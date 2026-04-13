// Space -- orchestrator that coordinates multiple SCP bodies with one brain
// Four jobs only: translate, sequence, aggregate, gate.
// No reasoning. No safety logic. No pattern matching.

const { EventEmitter } = require("node:events");
const { Translator } = require("./translator");
const { Aggregator } = require("./aggregator");

class Space extends EventEmitter {
  /**
   * @param {string} name - identifier for this Space
   * @param {object} [opts]
   * @param {number} [opts.tickHz] - reactor tick rate, default 120
   * @param {number} [opts.aggregateEveryTicks] - aggregate state every N ticks
   * @param {number} [opts.brainIntervalMs] - min ms between brain calls, default 2000
   * @param {number} [opts.tokenBudget] - aggregator token budget, default 2000
   * @param {Set<string>} [opts.allowedActions] - optional global action allowlist
   */
  constructor(name, opts = {}) {
    super();
    this.name = name;
    this.tickHz = opts.tickHz || 120;
    this.aggregateEveryTicks = opts.aggregateEveryTicks || 30;
    this.brainIntervalMs = opts.brainIntervalMs || 2000;

    this.bodies = new Map();
    this.brain = null;
    this.activeGoal = null;
    this.history = [];
    this.historyCap = 10;

    this.translator = new Translator({ allowedActions: opts.allowedActions });
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
      aggregations: 0,
      commandsDispatched: 0,
      commandsRejected: 0,
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
    adapter._attachSpace(this);
    this.bodies.set(adapter.name, adapter);
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

  // -- Reactor --

  async _reactorLoop() {
    const tickMs = 1000 / this.tickHz;

    while (this._running) {
      const tickStart = Date.now();
      this._tick++;
      this.stats.ticks++;

      // Drain brain responses
      while (this._brainResponseQueue.length > 0) {
        const intent = this._brainResponseQueue.shift();
        this._dispatchIntent(intent);
      }

      // Aggregate + brain call at interval
      if (this._tick % this.aggregateEveryTicks === 0) {
        const now = Date.now();
        if (!this._brainInFlight && now - this._lastBrainCallAt >= this.brainIntervalMs) {
          this._maybeCallBrain();
        }
      }

      const elapsed = Date.now() - tickStart;
      const wait = Math.max(0, tickMs - elapsed);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
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

  // -- Intent dispatch (translator + sequencer) --

  _dispatchIntent(intent) {
    const result = this.translator.translate(intent, this.bodies);

    if (!result.ok) {
      this.stats.commandsRejected++;
      this.emit("intent_error", { intent, reason: result.reason, error: result.error });
      return;
    }

    const command = result.command;
    const body = this.bodies.get(command.body);

    this.stats.commandsDispatched++;
    this._addToHistory(`${command.body}: ${command.action}`);

    body.execute({
      action: command.action,
      parameters: command.parameters,
      priority: command.priority,
      fallback: command.fallback,
    }).catch((e) => {
      this.emit("execute_error", { command, error: e.message });
    });
  }

  // -- Events from bodies --

  onBodyEvent(bodyName, eventType, payload) {
    this.emit("body_event", { body: bodyName, type: eventType, payload });
    this._addToHistory(`${bodyName}: event ${eventType}`);
  }

  _addToHistory(entry) {
    this.history.push(entry);
    if (this.history.length > this.historyCap * 2) {
      this.history = this.history.slice(-this.historyCap);
    }
  }

  // -- Stats --

  getStats() {
    return {
      ...this.stats,
      running: this._running,
      tick: this._tick,
      bodies: this.bodies.size,
      brainInFlight: this._brainInFlight,
      queuedResponses: this._brainResponseQueue.length,
      translator: this.translator.getStats(),
      aggregator: this.aggregator.getStats(),
      brain: this.brain ? (typeof this.brain.stats === "function" ? this.brain.stats() : null) : null,
    };
  }
}

module.exports = { Space };
