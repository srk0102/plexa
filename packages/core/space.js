// Space -- orchestrator that coordinates multiple bodies with one brain.
// Four jobs only: translate, sequence, aggregate, gate.
//
// Bodies are in-process objects. Tools are their async methods.
// LLM tool calls dispatch directly as method invocations. Zero HTTP,
// zero text parsing. HTTP lives only between Plexa and the LLM.

const { EventEmitter } = require("node:events");
const { Translator } = require("./translator");
const { Aggregator } = require("./aggregator");

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
    this.aggregator = new Aggregator({ tokenBudget: opts.tokenBudget });

    this._running = false;
    this._tick = 0;
    this._lastBrainCallAt = 0;
    this._brainInFlight = false;
    this._brainResponseQueue = [];

    this.stats = {
      brainCalls: 0,
      brainErrors: 0,
      ticks: 0,
      tickErrors: 0,
      aggregations: 0,
      toolsDispatched: 0,
      toolsRejected: 0,
      toolErrors: 0,
    };
  }

  // -- Registration --

  addBody(adapter) {
    if (!adapter || !adapter.name) {
      throw new Error("Space.addBody: adapter must have a name");
    }
    if (this.bodies.has(adapter.name)) {
      throw new Error(`Space.addBody: body "${adapter.name}" already registered`);
    }

    // Inspect transport: inprocess (default) or http (explicit network body).
    const transport = adapter.transport || "inprocess";

    adapter._attachSpace(this);
    this.bodies.set(adapter.name, adapter);

    // Discover tools and build registry
    const tools = typeof adapter.getToolDefinitions === "function"
      ? adapter.getToolDefinitions()
      : (adapter.constructor && adapter.constructor.tools) || {};

    for (const [toolName, def] of Object.entries(tools)) {
      this.toolRegistry.set(`${adapter.name}.${toolName}`, { body: adapter, tool: toolName, def });
    }

    this.emit("body_registered", {
      name: adapter.name,
      transport,
      port: adapter.port || null,
      tools: Object.keys(tools),
    });

    return this;
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
    if (!this._running) return;
    this._running = false;

    for (const body of this.bodies.values()) {
      try { await body.onEmergencyStop(); } catch {}
    }
    this.emit("stopped");
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

      // 2. Drain queued brain tool calls
      while (this._brainResponseQueue.length > 0) {
        const intent = this._brainResponseQueue.shift();
        this._dispatchIntent(intent);
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

      const intent = await this.brain.invoke(worldState);
      this.stats.brainCalls++;

      if (intent) this._brainResponseQueue.push(intent);
    } catch (e) {
      this.stats.brainErrors++;
      this.emit("brain_error", e);
    } finally {
      this._brainInFlight = false;
    }
  }

  // -- Tool dispatch: structured intent -> direct method call --

  _dispatchIntent(intent) {
    const result = this.translator.translate(intent, this.bodies);

    if (!result.ok) {
      this.stats.toolsRejected++;
      this.emit("intent_error", { intent, reason: result.reason, error: result.error });
      return;
    }

    const { body: bodyName, tool, parameters } = result.command;
    const body = this.bodies.get(bodyName);

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
  }

  /**
   * Called by a managed body when its local pattern store decides.
   * Plexa records the decision so it can build vertical memory later
   * and reason about what each body has been doing autonomously.
   *
   * @param {string} bodyName
   * @param {*} entity
   * @param {string} decision
   * @param {object} [meta]   { source: "exact"|"similar"|"reflex", confidence }
   */
  onBodyDecision(bodyName, entity, decision, meta = {}) {
    this.stats.bodyDecisions = (this.stats.bodyDecisions || 0) + 1;
    this._addToHistory(`${bodyName} local -> ${decision}`);
    this.emit("body_decision", { body: bodyName, entity, decision, meta, ts: Date.now() });
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
      brain: this.brain && typeof this.brain.stats === "function" ? this.brain.stats() : null,
    };
  }
}

module.exports = { Space };
