// BodyAdapter -- a body whose methods are tools the brain can call directly.
//
// Zero HTTP by default. The body lives in the same process as Space.
// Subclasses declare tools as async methods and describe them via static tools.
// Space discovers tools on addBody() and routes LLM tool calls as direct method
// invocations -- no text parsing, no transport indirection.
//
// Event priority levels (higher priority dropped last by Aggregator):
//   CRITICAL  never trimmed
//   HIGH      trimmed only under severe budget pressure
//   NORMAL    default
//   LOW       trimmed first

const PRIORITY = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};
const VALID_PRIORITIES = new Set(Object.keys(PRIORITY));

class BodyAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name] - optional override of class default
   */
  constructor(opts = {}) {
    // Name resolution: opts.name > static name > class name
    this.name = opts.name || this.constructor.bodyName || this.constructor.name;
    if (!this.name) {
      throw new Error("BodyAdapter: body must have a name");
    }

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
    };
  }

  // -- Tool discovery (for Space) --

  static tools = {}; // subclass overrides with { toolName: { description, parameters } }

  getToolDefinitions() {
    return this.constructor.tools || {};
  }

  /**
   * Space calls this to execute a tool by name.
   * Returns the method result or throws if unknown / not a function.
   */
  async invokeTool(toolName, parameters = {}) {
    const tools = this.getToolDefinitions();
    if (!tools[toolName]) {
      throw new Error(`${this.name}: unknown tool "${toolName}"`);
    }
    const fn = this[toolName];
    if (typeof fn !== "function") {
      throw new Error(`${this.name}: tool "${toolName}" declared but no method`);
    }
    this.stats.toolCalls++;
    try {
      return await fn.call(this, parameters || {});
    } catch (e) {
      this.stats.toolErrors++;
      throw e;
    }
  }

  // -- Space attachment --

  _attachSpace(space) {
    if (this.space && this.space !== space) {
      throw new Error(`${this.name}: already attached to a Space`);
    }
    this.space = space;
    this._setMode("managed");
  }

  _detachSpace() {
    this.space = null;
    this._setMode("standalone");
  }

  _setMode(mode) {
    if (mode !== "standalone" && mode !== "managed") {
      throw new Error(`${this.name}: invalid mode "${mode}"`);
    }
    this.mode = mode;
    this._state.mode = mode;
    this._state.updated_at = Date.now();
  }

  // -- Lifecycle hooks (override in subclass) --

  async onConfigure() {
    this._setStatus("configured");
  }

  async onActivate() {
    this._setStatus("active");
  }

  async onEmergencyStop() {
    this._setStatus("stopped");
  }

  /**
   * Sensor loop. Called by Space at tickHz.
   * Override in subclass to read sensors, check reflexes, emit events.
   * Default: no-op.
   */
  async tick() {
    this.stats.ticks++;
  }

  // -- State --

  snapshot() {
    return {
      status: this._state.status,
      mode: this._state.mode,
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

  /**
   * Emit a semantic event. Pushed directly to Space (no HTTP).
   * @param {string} eventType
   * @param {object} [payload]
   * @param {string} [priority] CRITICAL | HIGH | NORMAL | LOW
   */
  emit(eventType, payload = {}, priority = "NORMAL") {
    if (!VALID_PRIORITIES.has(priority)) priority = "NORMAL";

    this._state.pending_events.push({
      type: eventType,
      payload,
      priority,
      ts: Date.now(),
    });
    this.stats.events++;

    // Preserve CRITICAL past queue cap
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

  clearPendingEvents() {
    this._state.pending_events = [];
  }
}

module.exports = { BodyAdapter, PRIORITY };
