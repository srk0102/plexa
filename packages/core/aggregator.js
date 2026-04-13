// Aggregator -- JOB 3: collect state from all bodies and compress into
// a single world-state object for the brain. Enforces a token budget so
// the LLM context stays small.
//
// Priority order (lower number = higher priority, drop last):
//   CRITICAL (0)  never trimmed
//   HIGH     (1)  trimmed only if severely over budget
//   NORMAL   (2)  trimmed after LOW
//   LOW      (3)  trimmed first

const DEFAULT_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 4;

const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

function priorityRank(p) {
  return PRIORITY_RANK[p] ?? PRIORITY_RANK.NORMAL;
}

class Aggregator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.tokenBudget] - default 2000
   * @param {number} [opts.maxHistory] - default 10
   * @param {number} [opts.staleMs] - default 1000ms
   * @param {number} [opts.maxPendingEventsPerBody] - default 5
   */
  constructor(opts = {}) {
    this.tokenBudget = opts.tokenBudget || DEFAULT_TOKEN_BUDGET;
    this.maxHistory = opts.maxHistory || 10;
    this.staleMs = opts.staleMs || 1000;
    this.maxPendingEventsPerBody = opts.maxPendingEventsPerBody || 5;

    this.stats = {
      aggregations: 0,
      trimmed: 0,
      droppedEvents: 0,
      droppedByPriority: { CRITICAL: 0, HIGH: 0, NORMAL: 0, LOW: 0 },
      maxTokens: 0,
    };
  }

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

    for (const [name, body] of bodies) {
      const snap = typeof body.snapshot === "function" ? body.snapshot() : {};
      const compact = this._compactSnapshot(snap, now);
      out.bodies[name] = compact;

      if (opts.clearEventsAfterRead !== false && typeof body.clearPendingEvents === "function") {
        body.clearPendingEvents();
      }
    }

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

    // Pending events: sort by priority (CRITICAL first) then cap.
    // CRITICAL events always survive the per-body cap.
    if (Array.isArray(snap.pending_events) && snap.pending_events.length > 0) {
      const sorted = [...snap.pending_events].sort(
        (a, b) => priorityRank(a.priority) - priorityRank(b.priority)
      );
      const kept = this._capEventsByPriority(sorted, this.maxPendingEventsPerBody);
      compact.pending_events = kept.map((e) => {
        if (typeof e === "string") return { type: e, priority: "NORMAL" };
        return {
          type: e.type || "event",
          priority: e.priority || "NORMAL",
        };
      });
    }

    if (typeof snap.updated_at === "number") {
      const age = now - snap.updated_at;
      if (age > this.staleMs) {
        compact.stale = true;
        compact.age_ms = age;
      }
    }

    for (const [k, v] of Object.entries(snap)) {
      if (["status", "mode", "last_action", "pending_events", "updated_at"].includes(k)) continue;
      compact[k] = this._compactValue(v);
    }

    return compact;
  }

  // Keep all CRITICAL events plus enough lower-priority events to fill cap
  _capEventsByPriority(sortedEvents, cap) {
    const critical = sortedEvents.filter((e) => (e.priority || "NORMAL") === "CRITICAL");
    const rest = sortedEvents.filter((e) => (e.priority || "NORMAL") !== "CRITICAL");
    const slotsLeft = Math.max(0, cap - critical.length);
    const dropped = rest.slice(slotsLeft);
    for (const e of dropped) {
      this.stats.droppedEvents++;
      const p = e.priority || "NORMAL";
      this.stats.droppedByPriority[p] = (this.stats.droppedByPriority[p] || 0) + 1;
    }
    return [...critical, ...rest.slice(0, slotsLeft)];
  }

  _compactValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") {
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

  // -- Token budget enforcement (priority-aware) --

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

    // Step 2: drop LOW priority events from every body
    if (this._tokenEstimate(out) > this.tokenBudget) {
      this._dropEventsAtPriority(out, "LOW");
    }

    // Step 3: drop NORMAL priority events
    if (this._tokenEstimate(out) > this.tokenBudget) {
      this._dropEventsAtPriority(out, "NORMAL");
    }

    // Step 4: drop HIGH priority events (last resort before dropping fields)
    if (this._tokenEstimate(out) > this.tokenBudget) {
      this._dropEventsAtPriority(out, "HIGH");
    }

    // Step 5: drop non-essential fields from each body.
    // Keep status, last_action, and any remaining CRITICAL events.
    if (this._tokenEstimate(out) > this.tokenBudget) {
      for (const name of Object.keys(out.bodies)) {
        const b = out.bodies[name];
        const criticalEvents = (b.pending_events || []).filter(
          (e) => (e.priority || "NORMAL") === "CRITICAL"
        );
        out.bodies[name] = {
          status: b.status,
          ...(b.last_action ? { last_action: b.last_action } : {}),
          ...(criticalEvents.length > 0 ? { pending_events: criticalEvents } : {}),
          truncated: true,
        };
      }
    }

    // Step 6: drop history entirely
    if (this._tokenEstimate(out) > this.tokenBudget) {
      out.recent_history = [];
    }

    // Step 7: drop bodies one at a time, starting with those that have no
    // CRITICAL events. Bodies with CRITICAL events stay to the end.
    if (this._tokenEstimate(out) > this.tokenBudget) {
      const names = Object.keys(out.bodies);
      const noCritical = names.filter((n) => {
        const events = out.bodies[n].pending_events || [];
        return !events.some((e) => (e.priority || "NORMAL") === "CRITICAL");
      });
      const withCritical = names.filter((n) => !noCritical.includes(n));
      const dropOrder = [...noCritical, ...withCritical];

      while (this._tokenEstimate(out) > this.tokenBudget && dropOrder.length > 0) {
        const drop = dropOrder.shift();
        delete out.bodies[drop];
      }
    }

    return out;
  }

  _dropEventsAtPriority(out, priority) {
    for (const name of Object.keys(out.bodies)) {
      const b = out.bodies[name];
      if (!Array.isArray(b.pending_events)) continue;
      const before = b.pending_events.length;
      b.pending_events = b.pending_events.filter(
        (e) => (e.priority || "NORMAL") !== priority
      );
      const dropped = before - b.pending_events.length;
      if (dropped > 0) {
        this.stats.droppedEvents += dropped;
        this.stats.droppedByPriority[priority] =
          (this.stats.droppedByPriority[priority] || 0) + dropped;
      }
      if (b.pending_events.length === 0) delete b.pending_events;
    }
  }

  getStats() {
    return {
      ...this.stats,
      droppedByPriority: { ...this.stats.droppedByPriority },
    };
  }
}

module.exports = { Aggregator, PRIORITY_RANK };
