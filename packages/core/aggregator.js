// Aggregator -- JOB 3: collect state from all bodies and compress into
// a single world-state object for the brain. Enforces a token budget so
// the LLM context stays small. Never throws.

const DEFAULT_TOKEN_BUDGET = 2000;
// Conservative estimate: 1 token ~ 4 characters for English + JSON.
const CHARS_PER_TOKEN = 4;

class Aggregator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.tokenBudget] - default 2000
   * @param {number} [opts.maxHistory] - max recent history entries, default 10
   * @param {number} [opts.staleMs] - snapshots older than this are flagged, default 1000ms
   * @param {number} [opts.maxPendingEventsPerBody] - cap events per body, default 5
   */
  constructor(opts = {}) {
    this.tokenBudget = opts.tokenBudget || DEFAULT_TOKEN_BUDGET;
    this.maxHistory = opts.maxHistory || 10;
    this.staleMs = opts.staleMs || 1000;
    this.maxPendingEventsPerBody = opts.maxPendingEventsPerBody || 5;

    this.stats = {
      aggregations: 0,
      trimmed: 0,
      maxTokens: 0,
    };
  }

  /**
   * @param {Map<string, BodyAdapter>} bodies
   * @param {object} [opts]
   * @param {string} [opts.activeGoal]
   * @param {string[]} [opts.history]
   * @param {string} [opts.spaceName]
   * @param {boolean} [opts.clearEventsAfterRead=true]
   * @returns {object}
   */
  aggregate(bodies, opts = {}) {
    this.stats.aggregations++;
    const now = Date.now();

    const out = {
      timestamp: now,
      space: opts.spaceName || null,
      bodies: {},
      active_goal: opts.activeGoal || null,
      recent_history: (opts.history || []).slice(-this.maxHistory),
    };

    // Snapshot every body
    for (const [name, body] of bodies) {
      const snap = typeof body.snapshot === "function" ? body.snapshot() : {};
      const compact = this._compactSnapshot(snap, now);
      out.bodies[name] = compact;

      // Consume pending events after reading them (prevent replay)
      if (opts.clearEventsAfterRead !== false && typeof body.clearPendingEvents === "function") {
        body.clearPendingEvents();
      }
    }

    // Enforce token budget
    const budgeted = this._enforceBudget(out);

    const size = this._tokenEstimate(budgeted);
    if (size > this.stats.maxTokens) this.stats.maxTokens = size;

    return budgeted;
  }

  // -- Snapshot compaction --

  _compactSnapshot(snap, now) {
    const compact = {
      status: snap.status || "unknown",
    };

    if (snap.mode) compact.mode = snap.mode;
    if (snap.last_action) compact.last_action = snap.last_action;

    // Pending events: keep type and short payload summary
    if (Array.isArray(snap.pending_events) && snap.pending_events.length > 0) {
      const events = snap.pending_events.slice(-this.maxPendingEventsPerBody);
      compact.pending_events = events.map((e) => {
        if (typeof e === "string") return e;
        if (e && typeof e === "object") return e.type || "event";
        return "event";
      });
    }

    // Staleness flag
    if (typeof snap.updated_at === "number") {
      const age = now - snap.updated_at;
      if (age > this.staleMs) {
        compact.stale = true;
        compact.age_ms = age;
      }
    }

    // Remaining data fields (sensor readings, positions, etc.)
    for (const [k, v] of Object.entries(snap)) {
      if (["status", "mode", "last_action", "pending_events", "updated_at"].includes(k)) continue;
      compact[k] = this._compactValue(v);
    }

    return compact;
  }

  _compactValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") {
      // Round floats to 3 decimals
      return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
    }
    if (typeof v === "string") {
      return v.length > 120 ? v.slice(0, 117) + "..." : v;
    }
    if (Array.isArray(v)) {
      return v.slice(0, 10).map((x) => this._compactValue(x));
    }
    if (typeof v === "object") {
      const out = {};
      let count = 0;
      for (const [k, x] of Object.entries(v)) {
        if (count++ >= 20) break;
        out[k] = this._compactValue(x);
      }
      return out;
    }
    return v;
  }

  // -- Token budget enforcement --

  _tokenEstimate(obj) {
    try {
      return Math.ceil(JSON.stringify(obj).length / CHARS_PER_TOKEN);
    } catch {
      return Infinity;
    }
  }

  _enforceBudget(worldState) {
    if (this._tokenEstimate(worldState) <= this.tokenBudget) return worldState;

    this.stats.trimmed++;
    const out = {
      timestamp: worldState.timestamp,
      space: worldState.space,
      bodies: { ...worldState.bodies },
      active_goal: worldState.active_goal,
      recent_history: [...(worldState.recent_history || [])],
    };

    // Step 1: trim history to 5 entries
    if (this._tokenEstimate(out) > this.tokenBudget) {
      out.recent_history = out.recent_history.slice(-5);
    }

    // Step 2: drop pending_events from bodies
    if (this._tokenEstimate(out) > this.tokenBudget) {
      for (const name of Object.keys(out.bodies)) {
        const b = { ...out.bodies[name] };
        delete b.pending_events;
        out.bodies[name] = b;
      }
    }

    // Step 3: drop non-essential fields from each body (keep only status + last_action)
    if (this._tokenEstimate(out) > this.tokenBudget) {
      for (const name of Object.keys(out.bodies)) {
        const b = out.bodies[name];
        out.bodies[name] = {
          status: b.status,
          ...(b.last_action ? { last_action: b.last_action } : {}),
          truncated: true,
        };
      }
    }

    // Step 4: drop history entirely
    if (this._tokenEstimate(out) > this.tokenBudget) {
      out.recent_history = [];
    }

    // Step 5: drop bodies one at a time if still over budget
    const bodyNames = Object.keys(out.bodies);
    while (this._tokenEstimate(out) > this.tokenBudget && bodyNames.length > 0) {
      const drop = bodyNames.pop();
      delete out.bodies[drop];
    }

    return out;
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = { Aggregator };
