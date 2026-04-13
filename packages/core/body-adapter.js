// BodyAdapter -- base class for a single SCP-controlled body in a Space.
// One BodyAdapter wraps one SCP adapter (muscle layer running elsewhere).
//
// MODES:
//   standalone  SCP adapter calls its own LLM, uses its own pattern store.
//               This is the default when no Space is attached.
//
//   managed     Project G owns the brain. SCP adapter:
//                 - still runs muscle layer at 60fps
//                 - still fires reflexes locally (safety, always)
//                 - still logs decisions (for later learning)
//                 - does NOT call LLM directly
//                 - does NOT use its own pattern store for decisions
//                 - emits events UP, receives commands DOWN
//               Set automatically when Space attaches.

class BodyAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.name - unique name within the Space
   * @param {string} [opts.uri] - SCP endpoint, e.g. "scp://localhost:8001"
   * @param {string[]} [opts.capabilities] - allowed actions, e.g. ["move_to", "halt"]
   * @param {object} [opts.transport] - preconfigured transport instance
   */
  constructor(opts = {}) {
    if (!opts.name) {
      throw new Error("BodyAdapter: name is required");
    }

    this.name = opts.name;
    this.uri = opts.uri || null;
    this.capabilities = new Set(opts.capabilities || []);

    // Transport (set during onConfigure or passed in)
    this.transport = opts.transport || null;

    // Space back-reference (set by Space.addBody via _attachSpace)
    this.space = null;

    // Execution mode: standalone until a Space attaches
    this.mode = "standalone";

    // Current state snapshot -- updated by subclass or via transport events
    this._state = {
      status: "idle",   // idle | configured | active | error | stopped
      mode: this.mode,
      last_action: null,
      pending_events: [],
      updated_at: Date.now(),
      data: {},         // free-form per-adapter payload (sensor readings, etc.)
    };

    // Minimal scp facade -- subclass uses this.scp.call(method, args)
    this.scp = {
      call: (method, args) => this._scpCall(method, args),
    };
  }

  // -- Space attachment --

  _attachSpace(space) {
    if (this.space && this.space !== space) {
      throw new Error(`BodyAdapter ${this.name}: already attached to a Space`);
    }
    this.space = space;
    this._setMode("managed");
  }

  _detachSpace() {
    this.space = null;
    this._setMode("standalone");
  }

  // -- Mode control --

  _setMode(mode) {
    if (mode !== "standalone" && mode !== "managed") {
      throw new Error(`BodyAdapter ${this.name}: invalid mode "${mode}"`);
    }
    this.mode = mode;
    this._state.mode = mode;
    this._state.updated_at = Date.now();

    // Notify SCP muscle so it can disable local brain + cache decisions.
    // This is fire-and-forget; if transport is not ready yet, the message
    // is sent later when onConfigure wires the transport.
    this._sendModeToSCP(mode);
  }

  _sendModeToSCP(mode) {
    if (!this.transport || typeof this.transport.emit !== "function") return;

    // The SCP muscle listens for "set_mode". When mode is "managed" it:
    //   - stops calling its own LLM bridge
    //   - stops using local pattern-store decisions (may still log them)
    //   - keeps reflexes, physics, event emission, command execution
    this.transport.emit("set_mode", {
      body: this.name,
      mode,
      ts: Date.now(),
    });
  }

  // -- Lifecycle hooks (override in subclass) --

  async onConfigure() {
    // Subclass: set up transport, connect to SCP adapter, register handlers.
    // Default: mark configured and (re)send mode in case transport was attached here.
    this._setStatus("configured");
    this._sendModeToSCP(this.mode);
  }

  async onActivate() {
    // Subclass: enable hardware, start data flow.
    this._setStatus("active");
  }

  async onEmergencyStop() {
    // Subclass: halt actuators, release resources.
    this._setStatus("stopped");
    if (this.transport && typeof this.transport.stop === "function") {
      try { await this.transport.stop(); } catch {}
    }
  }

  // -- Intent execution (called by Space._dispatchIntent) --

  async execute(intent) {
    if (!intent || !intent.action) {
      throw new Error(`BodyAdapter ${this.name}: intent missing action`);
    }

    // Capability check (JOB 4: gate)
    if (this.capabilities.size > 0 && !this.capabilities.has(intent.action)) {
      throw new Error(
        `BodyAdapter ${this.name}: capability "${intent.action}" not declared`
      );
    }

    this._state.last_action = intent.action;
    this._state.updated_at = Date.now();

    return this.onIntent(intent);
  }

  /**
   * Override in subclass to handle the actual action.
   * Default: forward to SCP via scp.call(action, parameters).
   */
  async onIntent(intent) {
    return this.scp.call(intent.action, intent.parameters || {});
  }

  // -- State snapshot (read by Space aggregator) --

  snapshot() {
    return {
      status: this._state.status,
      mode: this._state.mode,
      last_action: this._state.last_action,
      pending_events: [...this._state.pending_events],
      updated_at: this._state.updated_at,
      ...this._state.data,
    };
  }

  // -- Subclass helpers --

  /**
   * Update arbitrary state fields (e.g. position, objects_detected).
   * Called by subclass from SCP event handlers.
   */
  setState(patch) {
    Object.assign(this._state.data, patch);
    this._state.updated_at = Date.now();
  }

  _setStatus(status) {
    this._state.status = status;
    this._state.updated_at = Date.now();
  }

  /**
   * Push a semantic event up to the Space.
   * Bodies call this when they detect something the brain should know about.
   */
  emit(eventType, payload = {}) {
    this._state.pending_events.push({
      type: eventType,
      payload,
      ts: Date.now(),
    });

    // Cap the pending events queue
    if (this._state.pending_events.length > 20) {
      this._state.pending_events = this._state.pending_events.slice(-20);
    }

    if (this.space) {
      this.space.onBodyEvent(this.name, eventType, payload);
    }
  }

  /**
   * Called by Space aggregator after brain has seen the events.
   * Clears pending_events so they are not re-reported.
   */
  clearPendingEvents() {
    this._state.pending_events = [];
  }

  // -- Transport routing (internal) --

  async _scpCall(method, args) {
    if (!this.transport) {
      throw new Error(`BodyAdapter ${this.name}: no transport configured`);
    }

    // HTTPTransport exposes emit() for outbound messages.
    // Subclass can override _scpCall for different semantics (e.g. request/response).
    if (typeof this.transport.emit === "function") {
      this.transport.emit("command", {
        body: this.name,
        method,
        args,
        ts: Date.now(),
      });
      return { ok: true };
    }

    throw new Error(`BodyAdapter ${this.name}: transport has no emit()`);
  }
}

module.exports = { BodyAdapter };
