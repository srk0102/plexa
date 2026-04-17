// Space -- orchestrator that coordinates multiple bodies with one brain.
// Four jobs only: translate, sequence, aggregate, gate.
//
// Bodies are in-process objects. Tools are their async methods.
// LLM tool calls dispatch directly as method invocations. Zero HTTP,
// zero text parsing. HTTP lives only between Plexa and the LLM.

const { EventEmitter } = require("node:events");
const { Translator } = require("./translator");
const { Aggregator } = require("./aggregator");
const { NetworkBodyAdapter } = require("./network-body");

class Space extends EventEmitter {
  /**
   * @param {string} name
   * @param {object} [opts]
   * @param {number} [opts.tickHz] reactor rate, default 60
   * @param {number} [opts.aggregateEveryTicks] aggregate cadence, default 30
   * @param {number} [opts.brainIntervalMs] min ms between brain calls, default 2000
   * @param {number} [opts.tokenBudget] aggregator budget, default 2000
   * @param {Set<string>} [opts.allowedTools] optional "body.tool" allowlist
   */
  constructor(name, opts = {}) {
    super();
    this.name = name;
    this.tickHz = opts.tickHz || 60;
    this.aggregateEveryTicks = opts.aggregateEveryTicks || 30;
    this.brainIntervalMs = opts.brainIntervalMs || 2000;

    this.bodies = new Map();
    this.toolRegistry = new Map(); // "body.tool" -> { body, tool, def }
    this.brain = null;
    this.activeGoal = null;
    this.history = [];
    this.historyCap = 10;

    this.translator = new Translator({ allowedTools: opts.allowedTools });
    this.aggregator = new Aggregator({
      tokenBudget: opts.tokenBudget,
      sanitizeInjection: opts.sanitizeInjection !== false,
    });
    // Surface sanitizer hits as a high-visibility security event.
    this.aggregator.setSecurityListener((info) => {
      this.stats.injectionHits = (this.stats.injectionHits || 0) + info.hits;
      this.emit("security_event", {
        type: "prompt_injection_detected",
        hits: info.hits,
        space: this.name,
      });
    });

    // Pluggable gates. Order at dispatch time:
    //   1. translator validates schema
    //   2. safety rules (sync, cannot be bypassed)
    //   3. approval hook (async, optional; can approve/reject/modify)
    //   4. body.invokeTool
    this._safetyRules = [];
    this._approvalHook = null;

    // Confidence gating: thresholds applied to decisions reported by
    // bodies (via decideLocally / notifyDecision). Brain escalation is
    // emitted when confidence falls below `escalate`.
    this.confidenceThresholds = {
      autoApprove: 0.9,
      monitor: 0.6,
      escalate: 0.0,
    };
    this._confidenceSums = new Map(); // bodyName -> { sum, count }

    // Lateral body-to-body channels. Map<fromName, Map<eventType, Set<toName>>>
    this._peerRoutes = new Map();

    // Optional vertical memory (SQLite persistence across sessions).
    this.verticalMemory = opts.verticalMemory || null;

    // Input extractor: converts world state into flat key-value features
    // for vertical memory's evaluate(). Developer provides this so Plexa
    // knows which signals to check against learned reasoning.
    // Default: flatten body snapshot data into a single object.
    this._inputExtractor = opts.inputExtractor || null;

    // Schema retry: max attempts when LLM hallucinates a variable.
    this._schemaRetryMax = opts.schemaRetryMax ?? 2;

    // Auto-save guards
    this._autoSaveInstalled = false;

    this._running = false;
    this._tick = 0;
    this._lastBrainCallAt = 0;
    this._brainInFlight = false;
    this._brainResponseQueue = [];
    this._sessionId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.stats = {
      brainCalls: 0,
      brainErrors: 0,
      ticks: 0,
      tickErrors: 0,
      aggregations: 0,
      toolsDispatched: 0,
      toolsRejected: 0,
      toolErrors: 0,
      safetyBlocked: 0,
      approvalRejected: 0,
      approvalModified: 0,
      // Confidence gating
      lowConfidenceCount: 0,
      escalatedByConfidence: 0,
      avgConfidenceByBody: {},
      // Lateral
      peerEventsRouted: 0,
      // Memory
      memoryHits: 0,
      memoryMisses: 0,
    };
  }

  // -- Registration --

  addBody(adapter) {
    if (!adapter || !adapter.name) {
      throw new Error("Space.addBody: adapter must have a name");
    }

    // AUTO-WRAP: a plain BodyAdapter with transport="http" becomes a
    // NetworkBodyAdapter pointing at the declared host:port. Auto-wrap is
    // skipped if the adapter is already a NetworkBodyAdapter.
    if (
      adapter.transport === "http" &&
      !(adapter instanceof NetworkBodyAdapter)
    ) {
      const declaredTools =
        typeof adapter.getToolDefinitions === "function"
          ? adapter.getToolDefinitions()
          : (adapter.constructor && adapter.constructor.tools) || {};

      adapter = new NetworkBodyAdapter({
        name: adapter.name,
        host: adapter.host || "localhost",
        port: adapter.port,
        tools: declaredTools,
      });
    }

    if (this.bodies.has(adapter.name)) {
      throw new Error(`Space.addBody: body "${adapter.name}" already registered`);
    }

    const transport = adapter.transport || "inprocess";

    adapter._attachSpace(this);
    this.bodies.set(adapter.name, adapter);

    // Register tools now (from static or from discovery-so-far).
    this._registerAdapterTools(adapter);

    // If this is a network body with no statically declared tools, run
    // /discover in the background and republish tools when it returns.
    if (adapter instanceof NetworkBodyAdapter && Object.keys(adapter.getToolDefinitions()).length === 0) {
      this._pendingDiscovery = (this._pendingDiscovery || new Map());
      const p = adapter.discoverTools()
        .then(() => this.emit("body_discovered", { name: adapter.name, tools: Object.keys(adapter.getToolDefinitions()) }))
        .catch((e) => this.emit("body_discovery_error", { name: adapter.name, error: e.message }));
      this._pendingDiscovery.set(adapter.name, p);
    }

    this.emit("body_registered", {
      name: adapter.name,
      transport,
      port: adapter.port || null,
      tools: Object.keys(adapter.getToolDefinitions()),
    });

    return this;
  }

  /**
   * Register (or re-register) the tool registry entries for an adapter.
   * Called internally on addBody and after network discovery completes.
   */
  _registerAdapterTools(adapter) {
    const tools =
      typeof adapter.getToolDefinitions === "function"
        ? adapter.getToolDefinitions()
        : (adapter.constructor && adapter.constructor.tools) || {};

    // Clear any existing registry entries for this body name
    for (const fqn of [...this.toolRegistry.keys()]) {
      if (fqn.startsWith(`${adapter.name}.`)) this.toolRegistry.delete(fqn);
    }
    for (const [toolName, def] of Object.entries(tools)) {
      this.toolRegistry.set(`${adapter.name}.${toolName}`, { body: adapter, tool: toolName, def });
    }
  }

  /**
   * Resolve once every pending async operation (network discovery, auto-saves)
   * has completed. Useful in tests and demos.
   */
  async ready() {
    if (!this._pendingDiscovery) return;
    await Promise.allSettled([...this._pendingDiscovery.values()]);
  }

  setBrain(brain) {
    if (!brain || typeof brain.invoke !== "function") {
      throw new Error("Space.setBrain: brain must have invoke()");
    }
    this.brain = brain;
    return this;
  }

  setGoal(goal) {
    this.activeGoal = goal;
    return this;
  }

  // -- Safety + approval gates --

  /**
   * Register a safety rule. Rules run BEFORE the approval hook and cannot
   * be bypassed. A rule must be a synchronous function that receives the
   * validated command ({ body, tool, parameters }) and returns:
   *   { allowed: true }                     -- pass
   *   { allowed: false, reason: "..." }     -- block
   *
   * @param {(command: {body: string, tool: string, parameters: object}) => {allowed: boolean, reason?: string}} rule
   */
  addSafetyRule(rule) {
    if (typeof rule !== "function") {
      throw new Error("Space.addSafetyRule: rule must be a function");
    }
    this._safetyRules.push(rule);
    return this;
  }

  /**
   * Register a human-in-the-loop approval hook. Runs AFTER safety rules and
   * AFTER translator validation, BEFORE body.invokeTool. A hook may be
   * async and receives the validated command. It must return:
   *   true                                           -- approve as-is
   *   false                                          -- reject
   *   { body, tool, parameters }                     -- modified command
   *
   * Only one hook may be registered; a second call replaces the first.
   *
   * @param {(command: {body: string, tool: string, parameters: object}) => (boolean|object|Promise<boolean|object>)} hook
   */
  addApprovalHook(hook) {
    if (typeof hook !== "function") {
      throw new Error("Space.addApprovalHook: hook must be a function");
    }
    this._approvalHook = hook;
    return this;
  }

  /**
   * Configure the confidence thresholds used when bodies report decisions
   * via notifyDecision (from decideLocally). Decisions are classified:
   *   >= autoApprove   -- executed silently (stat only)
   *   >= monitor       -- executed, emits "confidence_warning"
   *   <  escalate      -- emits "confidence_escalation" + increments
   *                       escalatedByConfidence; caller may use this to
   *                       force a brain re-evaluation.
   *
   * @param {{autoApprove?: number, monitor?: number, escalate?: number}} opts
   */
  setConfidenceThresholds(opts = {}) {
    if (typeof opts.autoApprove === "number") this.confidenceThresholds.autoApprove = opts.autoApprove;
    if (typeof opts.monitor === "number") this.confidenceThresholds.monitor = opts.monitor;
    if (typeof opts.escalate === "number") this.confidenceThresholds.escalate = opts.escalate;
    return this;
  }

  // -- Lateral events: direct body-to-body routing (no brain, no broadcast) --

  /**
   * Route `eventTypes` emitted by `fromBody` to `toBody.onPeerEvent(...)`.
   * Repeat calls with the same triple are idempotent.
   *
   * @param {string} fromBody
   * @param {string} toBody
   * @param {string[]} eventTypes
   */
  link(fromBody, toBody, eventTypes) {
    if (!this.bodies.has(fromBody)) throw new Error(`Space.link: unknown body "${fromBody}"`);
    if (!this.bodies.has(toBody)) throw new Error(`Space.link: unknown body "${toBody}"`);
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
      throw new Error("Space.link: eventTypes must be a non-empty array");
    }
    let byType = this._peerRoutes.get(fromBody);
    if (!byType) { byType = new Map(); this._peerRoutes.set(fromBody, byType); }
    for (const type of eventTypes) {
      let targets = byType.get(type);
      if (!targets) { targets = new Set(); byType.set(type, targets); }
      targets.add(toBody);
    }
    return this;
  }

  unlink(fromBody, toBody, eventTypes) {
    const byType = this._peerRoutes.get(fromBody);
    if (!byType) return this;
    const types = Array.isArray(eventTypes) ? eventTypes : [...byType.keys()];
    for (const type of types) {
      const targets = byType.get(type);
      if (!targets) continue;
      targets.delete(toBody);
      if (targets.size === 0) byType.delete(type);
    }
    if (byType.size === 0) this._peerRoutes.delete(fromBody);
    return this;
  }

  /**
   * Called internally by BodyAdapter.sendToPeer and by onBodyEvent routing.
   */
  async _routePeerEvent(fromBody, toBody, eventType, payload, priority = "NORMAL") {
    const target = this.bodies.get(toBody);
    if (!target) return;
    this.stats.peerEventsRouted++;
    this.emit("peer_event", { from: fromBody, to: toBody, type: eventType, priority });
    if (typeof target.onPeerEvent === "function") {
      try {
        await target.onPeerEvent(fromBody, eventType, payload, priority);
      } catch (e) {
        this.emit("peer_event_error", { from: fromBody, to: toBody, type: eventType, error: e.message });
      }
    }
  }

  // -- Lifecycle --

  async run() {
    if (this._running) return;
    if (this.bodies.size === 0) {
      throw new Error("Space.run: no bodies registered");
    }
    if (!this.brain) {
      throw new Error("Space.run: no brain registered");
    }

    for (const body of this.bodies.values()) await body.onConfigure();
    for (const body of this.bodies.values()) await body.onActivate();

    this._running = true;
    this._reactorLoop();
    this.emit("started");
  }

  async stop() {
    if (!this._running && !this._forceStop) return;
    this._running = false;

    // Persist vertical memory before we exit.
    if (this.verticalMemory && typeof this.verticalMemory.save === "function") {
      try {
        const n = await this.verticalMemory.save();
        if (typeof n === "number") {
          console.log(`[plexa] memory saved (${n} decisions)`);
        }
      } catch (e) {
        this.emit("memory_error", { error: `save failed: ${e.message}` });
      }
    }

    // Give every body a chance to persist its own pattern store.
    for (const body of this.bodies.values()) {
      try { await body.onEmergencyStop(); } catch {}
      if (body.patternStore && typeof body.patternStore.save === "function") {
        try {
          body.patternStore.save();
          console.log(`[scp] patterns saved for ${body.name} (${body.patternStore.patterns?.size ?? 0} entries)`);
        } catch {}
      }
      if (body.adaptiveMemory && typeof body.adaptiveMemory.save === "function") {
        try { await body.adaptiveMemory.save(); } catch {}
      }
    }
    this.emit("stopped");
  }

  /**
   * Install graceful shutdown handlers for SIGINT and SIGTERM. Calls
   * stop() and exits after persistence completes. Idempotent.
   */
  installShutdownHandlers() {
    if (this._autoSaveInstalled) return this;
    this._autoSaveInstalled = true;
    const handler = async (signal) => {
      try {
        this._forceStop = true;
        await this.stop();
      } catch {}
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("SIGINT",  () => handler("SIGINT"));
    process.once("SIGTERM", () => handler("SIGTERM"));
    return this;
  }

  // -- Reactor: ticks every body, dispatches brain responses, calls brain at interval --

  async _reactorLoop() {
    const tickMs = 1000 / this.tickHz;

    while (this._running) {
      const tickStart = Date.now();
      this._tick++;
      this.stats.ticks++;

      // 1. Tick every body (direct async method calls -- zero network)
      for (const body of this.bodies.values()) {
        try {
          await body.tick();
        } catch (e) {
          this.stats.tickErrors++;
          this.emit("tick_error", { body: body.name, error: e.message });
        }
      }

      // 2. Drain queued brain tool calls. _dispatchIntent is async (safety
      //    and approval gates may await) so we fire-and-forget; internal
      //    errors are already emitted.
      while (this._brainResponseQueue.length > 0) {
        const intent = this._brainResponseQueue.shift();
        this._dispatchIntent(intent).catch((e) => {
          this.emit("dispatch_error", { intent, error: e.message });
        });
      }

      // 3. Maybe call brain
      if (this._tick % this.aggregateEveryTicks === 0) {
        const now = Date.now();
        if (!this._brainInFlight && now - this._lastBrainCallAt >= this.brainIntervalMs) {
          this._maybeCallBrain();
        }
      }

      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, tickMs - elapsed);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  async _maybeCallBrain() {
    this._brainInFlight = true;
    this._lastBrainCallAt = Date.now();

    try {
      const worldState = this.aggregator.aggregate(this.bodies, {
        activeGoal: this.activeGoal,
        history: this.history,
        spaceName: this.name,
      });
      this.stats.aggregations++;

      // -- Layer 1: Vertical memory reasoning evaluation --
      // If vertical memory has reasoning patterns, EVALUATE them against
      // current input. Each case gets a fresh decision. Not a cached answer.
      if (this.verticalMemory) {
        let memoryResult = null;
        try {
          // Extract flat features from world state for reasoning evaluation.
          const currentInput = this._extractInput(worldState);

          if (typeof this.verticalMemory.searchAndEvaluate === "function") {
            // V2: reasoning-based evaluation (per-case, with guardrails + conflict resolution)
            memoryResult = await this.verticalMemory.searchAndEvaluate(worldState, currentInput);
          } else if (typeof this.verticalMemory.search === "function") {
            // V1 fallback: plain answer cache lookup
            const matches = await this.verticalMemory.search(worldState, 3);
            if (matches && matches.length > 0 && matches[0].confidence >= (this.verticalMemory.hitThreshold || 0.85)) {
              memoryResult = matches[0];
            }
          }
        } catch (e) {
          // Fail open: memory error should never block the brain call.
          this.emit("memory_error", { error: e.message });
        }

        if (memoryResult && (memoryResult.passes || memoryResult.decision)) {
          this.stats.memoryHits++;
          this.emit("memory_hit", {
            decision: memoryResult.decision,
            confidence: memoryResult.confidence,
            from_reasoning: memoryResult.from_reasoning || false,
            conflict: memoryResult.conflict || null,
            guardrail_override: memoryResult.guardrail_override || null,
          });
          // If the reasoning evaluation produced a dispatchable intent, use it.
          if (memoryResult.decision && typeof memoryResult.decision === "object") {
            this._brainResponseQueue.push(memoryResult.decision);
          }
          this._brainInFlight = false;
          return;
        }
        this.stats.memoryMisses++;
      }

      // -- Layer 2: Call the brain (LLM) --
      // Only reached when vertical memory has no relevant reasoning.
      const intent = await this.brain.invoke(worldState);
      this.stats.brainCalls++;

      if (intent) {
        this._brainResponseQueue.push(intent);

        // -- Layer 3: Store brain output as reasoning for future reuse --
        if (this.verticalMemory && typeof this.verticalMemory.store === "function" && intent.target_body && intent.tool) {
          // Extract reasoning from intent if the brain provided it.
          const reasoning = intent._reasoning || null;
          await this._storeWithRetry(intent.target_body, intent.tool, worldState, intent, reasoning);
        }
      }
    } catch (e) {
      this.stats.brainErrors++;
      this.emit("brain_error", e);
    } finally {
      this._brainInFlight = false;
    }
  }

  // -- Input extraction: world state -> flat features for reasoning evaluation --

  _extractInput(worldState) {
    // Developer-provided extractor has highest priority.
    if (typeof this._inputExtractor === "function") {
      return this._inputExtractor(worldState);
    }
    // Default: flatten body snapshot data into a single object.
    const flat = {};
    if (worldState.bodies && typeof worldState.bodies === "object") {
      for (const [bodyName, bodyData] of Object.entries(worldState.bodies)) {
        if (bodyData && typeof bodyData === "object") {
          for (const [key, val] of Object.entries(bodyData)) {
            if (key === "tools" || key === "pending_events") continue;
            if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") {
              flat[`${bodyName}.${key}`] = val;
            }
          }
        }
      }
    }
    return flat;
  }

  // -- Store with schema retry: catch hallucinated vars, retry once --

  async _storeWithRetry(bodyName, toolName, worldState, decision, reasoning) {
    for (let attempt = 0; attempt <= this._schemaRetryMax; attempt++) {
      try {
        await this.verticalMemory.store(
          bodyName, toolName, worldState, decision, reasoning,
          { confidence: 0.5, source: "brain", sessionId: this._sessionId }
        );
        return; // success
      } catch (e) {
        if (e.code === "SCHEMA_VALIDATION_ERROR" && attempt < this._schemaRetryMax) {
          this.emit("schema_retry", { attempt: attempt + 1, error: e.message, details: e.details });
          // Retry: ask brain again with a corrective prompt.
          if (this.brain && typeof this.brain.invoke === "function") {
            try {
              const corrected = await this.brain.invoke({
                ...worldState,
                _correction: `Previous response had invalid variables: ${e.details.join(", ")}. Use ONLY: ${this.verticalMemory.allowedVariables ? this.verticalMemory.allowedVariables.join(", ") : "any"}`,
              });
              if (corrected && corrected._reasoning) {
                reasoning = corrected._reasoning;
                decision = corrected;
                continue; // retry store with corrected reasoning
              }
            } catch {
              // Retry failed. Fall through to final catch.
            }
          }
        }
        // Final failure: log but don't crash. Fail open.
        this.emit("memory_error", { error: e.message, code: e.code || "UNKNOWN" });
        return;
      }
    }
  }

  // -- Tool dispatch: structured intent -> direct method call --

  async _dispatchIntent(intent) {
    const result = this.translator.translate(intent, this.bodies);

    if (!result.ok) {
      this.stats.toolsRejected++;
      this.emit("intent_error", { intent, reason: result.reason, error: result.error });
      return;
    }

    let command = result.command;

    // Gate 1: safety rules (sync, cannot be bypassed). First blocker wins.
    for (const rule of this._safetyRules) {
      let verdict;
      try {
        verdict = rule(command);
      } catch (e) {
        verdict = { allowed: false, reason: `safety rule threw: ${e.message}` };
      }
      if (!verdict || verdict.allowed !== true) {
        this.stats.safetyBlocked++;
        this.stats.toolsRejected++;
        const reason = (verdict && verdict.reason) || "safety rule denied";
        this.emit("safety_blocked", { command, reason });
        this.emit("intent_error", { intent, reason: "safety_blocked", error: reason });
        return;
      }
    }

    // Gate 2: approval hook (async, optional). Can modify the command.
    if (typeof this._approvalHook === "function") {
      let decision;
      try {
        decision = await this._approvalHook(command);
      } catch (e) {
        decision = false;
        this.emit("approval_error", { command, error: e.message });
      }

      if (decision === false) {
        this.stats.approvalRejected++;
        this.stats.toolsRejected++;
        this.emit("approval_rejected", { command });
        this.emit("intent_error", { intent, reason: "approval_rejected", error: "hook returned false" });
        return;
      }

      if (decision && typeof decision === "object") {
        // Allow hook to modify the command. Re-validate shape.
        const modified = {
          body: typeof decision.body === "string" ? decision.body : command.body,
          tool: typeof decision.tool === "string" ? decision.tool : command.tool,
          parameters: (decision.parameters && typeof decision.parameters === "object" && !Array.isArray(decision.parameters))
            ? decision.parameters : command.parameters,
        };

        // If the hook retargeted the body/tool, re-run the translator so
        // we never dispatch a modified command with invalid params.
        if (modified.body !== command.body || modified.tool !== command.tool) {
          const revalidate = this.translator.translate(
            { target_body: modified.body, tool: modified.tool, parameters: modified.parameters },
            this.bodies
          );
          if (!revalidate.ok) {
            this.stats.approvalRejected++;
            this.stats.toolsRejected++;
            this.emit("intent_error", { intent, reason: "approval_modified_invalid", error: revalidate.error });
            return;
          }
          command = revalidate.command;
        } else {
          command = modified;
        }
        this.stats.approvalModified++;
        this.emit("approval_modified", { command });
      }
    }

    const { body: bodyName, tool, parameters } = command;
    const body = this.bodies.get(bodyName);

    if (!body) {
      // Only reachable if the hook retargeted to a body that got removed;
      // translator would have caught a simply-wrong name.
      this.stats.toolsRejected++;
      this.emit("intent_error", { intent, reason: "unknown_body", error: bodyName });
      return;
    }

    this.stats.toolsDispatched++;
    this._addToHistory(`${bodyName}.${tool}`);

    // Direct async method call -- no HTTP, no serialization round-trip
    const start = Date.now();
    body.invokeTool(tool, parameters)
      .then((value) => {
        const dur = Date.now() - start;
        this.emit("tool_dispatched", { body: bodyName, tool, parameters, value, durationMs: dur });
      })
      .catch((e) => {
        this.stats.toolErrors++;
        this.emit("tool_error", { body: bodyName, tool, parameters, error: e.message });
      });
  }

  // -- Events from bodies (direct in-process, no HTTP) --

  onBodyEvent(bodyName, eventType, payload, priority = "NORMAL") {
    this.emit("body_event", { body: bodyName, type: eventType, payload, priority });
    this._addToHistory(`${bodyName}: ${eventType}`);

    // Lateral routing: any peer links for this (fromBody, eventType) pair
    // dispatch the event directly to the target body's onPeerEvent. Plexa
    // never touches payload. No brain involvement. No broadcast.
    const byType = this._peerRoutes.get(bodyName);
    if (!byType) return;
    const targets = byType.get(eventType);
    if (!targets || targets.size === 0) return;
    for (const toName of targets) {
      if (toName === bodyName) continue; // prevent self-loops
      this._routePeerEvent(bodyName, toName, eventType, payload, priority).catch(() => {});
    }
  }

  /**
   * Called by a managed body when its local pattern store decides.
   * Plexa applies confidence gating and, when a VerticalMemory is attached,
   * records the decision for cross-session memory.
   *
   * @param {string} bodyName
   * @param {*} entity
   * @param {string} decision
   * @param {object} [meta]   { source: "exact"|"similar"|"reflex", confidence }
   */
  onBodyDecision(bodyName, entity, decision, meta = {}) {
    this.stats.bodyDecisions = (this.stats.bodyDecisions || 0) + 1;
    this._addToHistory(`${bodyName} local -> ${decision}`);

    // Confidence classification.
    const confidence = typeof meta.confidence === "number" ? meta.confidence : null;
    if (confidence !== null) {
      const acc = this._confidenceSums.get(bodyName) || { sum: 0, count: 0 };
      acc.sum += confidence; acc.count++;
      this._confidenceSums.set(bodyName, acc);
      this.stats.avgConfidenceByBody[bodyName] = Number((acc.sum / acc.count).toFixed(3));

      const t = this.confidenceThresholds;
      if (confidence < t.escalate) {
        this.stats.escalatedByConfidence++;
        this.emit("confidence_escalation", { body: bodyName, entity, decision, confidence, meta });
      } else if (confidence < t.monitor) {
        this.stats.lowConfidenceCount++;
        this.emit("confidence_warning", { body: bodyName, entity, decision, confidence, meta });
      } else if (confidence < t.autoApprove) {
        this.stats.lowConfidenceCount++;
        this.emit("confidence_warning", { body: bodyName, entity, decision, confidence, meta });
      }
    }

    this.emit("body_decision", { body: bodyName, entity, decision, meta, ts: Date.now() });

    // Vertical memory write-through.
    if (this.verticalMemory && typeof this.verticalMemory.store === "function") {
      Promise.resolve(this.verticalMemory.store(bodyName, decision, entity, decision, {
        confidence,
        source: meta.source || "local",
        sessionId: this._sessionId,
      })).catch((e) => this.emit("memory_error", { error: e.message }));
    }
  }

  _addToHistory(entry) {
    this.history.push(entry);
    if (this.history.length > this.historyCap * 2) {
      this.history = this.history.slice(-this.historyCap);
    }
  }

  // -- Introspection --

  getTools() {
    const out = [];
    for (const [fqn, entry] of this.toolRegistry) {
      out.push({ fqn, body: entry.body.name, tool: entry.tool, def: entry.def });
    }
    return out;
  }

  getStats() {
    const brainStats = this.brain && typeof this.brain.stats === "function" ? this.brain.stats() : null;
    const estimatedCostUSD = brainStats && typeof brainStats.totalCost === "number" ? brainStats.totalCost : 0;
    // Savings estimate: average per-call cost times memory + cache hits.
    const avgCostPerCall = brainStats && brainStats.calls > 0
      ? brainStats.totalCost / brainStats.calls
      : 0;
    const cacheSavedCalls = (this.stats.memoryHits || 0);
    const costSavedByCacheUSD = Number((cacheSavedCalls * avgCostPerCall).toFixed(6));
    const memoryHitRate = (this.stats.memoryHits + this.stats.memoryMisses) > 0
      ? Number((this.stats.memoryHits / (this.stats.memoryHits + this.stats.memoryMisses)).toFixed(3))
      : 0;

    return {
      ...this.stats,
      running: this._running,
      tick: this._tick,
      bodies: this.bodies.size,
      tools: this.toolRegistry.size,
      brainInFlight: this._brainInFlight,
      queuedResponses: this._brainResponseQueue.length,
      translator: this.translator.getStats(),
      aggregator: this.aggregator.getStats(),
      brain: brainStats,
      estimatedCostUSD: Number(estimatedCostUSD.toFixed(6)),
      costSavedByCacheUSD,
      memoryHitRate,
      verticalMemory: this.verticalMemory && typeof this.verticalMemory.stats === "function"
        ? this.verticalMemory.stats() : null,
      confidenceThresholds: { ...this.confidenceThresholds },
    };
  }
}

module.exports = { Space };
