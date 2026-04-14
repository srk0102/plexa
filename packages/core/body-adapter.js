// BodyAdapter -- a body whose methods are tools the brain can call.
//
// By DEFAULT, a body is INPROCESS:
//   - No port. No transport configuration. No HTTP server.
//   - Plexa calls body.invokeTool(name, params) as a direct async method call.
//
// To run a body in another process (Python MuJoCo, hardware, ROS2),
// mark it explicitly via static fields:
//
//   class MuJoCoCartpole extends BodyAdapter {
//     static transport = "http";
//     static port = 8002;
//     static host = "localhost";
//   }
//
// Plexa reads these on addBody() and uses HTTP to reach the body.
// Same developer API either way:
//   space.addBody(new CartpoleJS())   // inprocess -- direct calls
//   space.addBody(new CartpolePy())   // network   -- HTTP under the hood
//
// Aliased as SCPBody since this matches the v0.2 SCP body contract.

const PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const VALID_PRIORITIES = new Set(Object.keys(PRIORITY));

class BodyAdapter {
  constructor(opts = {}) {
    const Class = this.constructor;

    this.name = opts.name || Class.bodyName || Class.name;
    if (!this.name) throw new Error("BodyAdapter: name required");

    // Transport defaults to inprocess. Network is OPT-IN.
    this.transport = opts.transport || Class.transport || "inprocess";
    if (this.transport !== "inprocess" && this.transport !== "http") {
      throw new Error(`${this.name}: invalid transport "${this.transport}"`);
    }

    this.host = opts.host || Class.host || null;
    this.port = opts.port || Class.port || null;

    if (this.transport === "http" && !this.port) {
      throw new Error(`${this.name}: transport=http requires a port`);
    }

    // Optional local pattern store. In managed mode the body still uses it;
    // decisions are reported up to the Space for vertical memory.
    this.patternStore = opts.patternStore || null;
    this._lastCachedEntity = null;

    this.space = null;
    this.mode = "standalone";

    this._state = {
      status: "idle",
      mode: this.mode,
      pending_events: [],
      updated_at: Date.now(),
      data: {},
    };

    this.stats = {
      ticks: 0,
      toolCalls: 0,
      toolErrors: 0,
      events: 0,
      reports: 0,
      decisions: 0,
    };
  }

  // -- Tool discovery --

  static tools = {};

  getToolDefinitions() { return this.constructor.tools || {}; }

  /**
   * Direct tool invocation. Used by Plexa for inprocess bodies.
   * Plexa wraps this in NetworkBodyAdapter when transport="http".
   *
   * If a pattern store is attached, the outcome is reported back to
   * the cache after the tool runs (when evaluateOutcome is overridden).
   */
  async invokeTool(toolName, parameters = {}) {
    const tools = this.getToolDefinitions();
    if (!tools[toolName]) throw new Error(`${this.name}: unknown tool "${toolName}"`);
    const fn = this[toolName];
    if (typeof fn !== "function") throw new Error(`${this.name}: tool "${toolName}" declared but no method`);
    this.stats.toolCalls++;
    try {
      const result = await fn.call(this, parameters || {});
      this._maybeReportOutcome();
      return result;
    } catch (e) {
      this.stats.toolErrors++;
      throw e;
    }
  }

  /**
   * Decide locally using the pattern store.
   * In BOTH standalone and managed modes the body is intelligent.
   * In managed mode the body additionally notifies Space of what it
   * decided, so Plexa can build vertical memory / analytics.
   */
  decideLocally(entity) {
    if (!this.patternStore) return null;
    const result = this.patternStore.lookup(entity);
    if (result) {
      this._lastCachedEntity = entity;
      this.notifyDecision(entity, result.decision, {
        source: result.source || "cache",
        confidence: result.confidence,
      });
    }
    return result;
  }

  /**
   * Remember which entity the last cached decision came from so a later
   * outcome report can find it.
   */
  rememberCachedEntity(entity) { this._lastCachedEntity = entity; }

  /**
   * Override to return true (success) / false (failure) / null (skip).
   */
  evaluateOutcome(/* state */) { return null; }

  _maybeReportOutcome() {
    if (!this.patternStore || !this._lastCachedEntity) return;
    let outcome;
    try { outcome = this.evaluateOutcome(this._state.data); }
    catch { return; }
    if (outcome !== true && outcome !== false) return;
    this.patternStore.report(this._lastCachedEntity, outcome);
    this.stats.reports++;
    if (outcome) this._lastCachedEntity = null;
  }

  /**
   * Tell the orchestrator the body made a local decision.
   * Direct function call (zero HTTP in-process). Safe without a Space.
   */
  notifyDecision(entity, decision, meta = {}) {
    this.stats.decisions++;
    if (!this.space || typeof this.space.onBodyDecision !== "function") return;
    this.space.onBodyDecision(this.name, entity, decision, meta);
  }

  // -- Lateral (peer) events --

  /**
   * Send a direct event to another body in the same Space. Routed
   * synchronously through Space._routePeerEvent. Does NOT go through the
   * brain, the aggregator, or broadcast. Zero-latency in-process call.
   *
   * @param {string} targetBodyName
   * @param {string} eventType
   * @param {object} [payload]
   * @param {string} [priority] CRITICAL | HIGH | NORMAL | LOW
   */
  async sendToPeer(targetBodyName, eventType, payload = {}, priority = "NORMAL") {
    if (!this.space || typeof this.space._routePeerEvent !== "function") return;
    await this.space._routePeerEvent(this.name, targetBodyName, eventType, payload, priority);
  }

  /**
   * Override in a subclass to receive peer events. Default is a no-op.
   * @param {string} fromBody
   * @param {string} eventType
   * @param {object} payload
   * @param {string} priority
   */
  async onPeerEvent(/* fromBody, eventType, payload, priority */) { /* no-op */ }

  // -- Space attachment --

  _attachSpace(space) {
    if (this.space && this.space !== space) {
      throw new Error(`${this.name}: already attached to a Space`);
    }
    this.space = space;
    this._setMode("managed");
  }

  _detachSpace() { this.space = null; this._setMode("standalone"); }

  _setMode(mode) {
    if (mode !== "standalone" && mode !== "managed") {
      throw new Error(`${this.name}: invalid mode "${mode}"`);
    }
    this.mode = mode;
    this._state.mode = mode;
    this._state.updated_at = Date.now();
  }

  // -- Lifecycle hooks --

  async onConfigure() { this._setStatus("configured"); }
  async onActivate()  { this._setStatus("active"); }
  async onEmergencyStop() { this._setStatus("stopped"); }

  /**
   * Sensor loop. Called by Space at tickHz for inprocess bodies.
   * For network bodies, the body's own process runs the tick loop.
   */
  async tick() { this.stats.ticks++; }

  // -- State --

  snapshot() {
    return {
      status: this._state.status,
      mode: this._state.mode,
      transport: this.transport,
      pending_events: [...this._state.pending_events],
      updated_at: this._state.updated_at,
      ...this._state.data,
    };
  }

  setState(patch) {
    Object.assign(this._state.data, patch);
    this._state.updated_at = Date.now();
  }

  _setStatus(status) {
    this._state.status = status;
    this._state.updated_at = Date.now();
  }

  emit(eventType, payload = {}, priority = "NORMAL") {
    if (!VALID_PRIORITIES.has(priority)) priority = "NORMAL";
    this._state.pending_events.push({ type: eventType, payload, priority, ts: Date.now() });
    this.stats.events++;

    if (this._state.pending_events.length > 20) {
      const recent = this._state.pending_events.slice(-20);
      const droppedCritical = this._state.pending_events
        .slice(0, -20)
        .filter((e) => e.priority === "CRITICAL");
      this._state.pending_events = [...droppedCritical, ...recent];
    }

    if (this.space) {
      this.space.onBodyEvent(this.name, eventType, payload, priority);
    }
  }

  clearPendingEvents() { this._state.pending_events = []; }
}

// SCPBody is the same class. Two names for the same contract.
const SCPBody = BodyAdapter;

module.exports = { BodyAdapter, SCPBody, PRIORITY };
