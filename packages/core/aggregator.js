// Aggregator -- collect state + tool definitions from all bodies and
// compress into a single world-state object for the brain.
// Enforces a token budget. Priority-aware trimming.

const DEFAULT_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 4;
const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

function priorityRank(p) { return PRIORITY_RANK[p] ?? PRIORITY_RANK.NORMAL; }

class Aggregator {
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

      // Include tool definitions inline -- the brain needs to know what each body can do
      const tools = typeof body.getToolDefinitions === "function"
        ? body.getToolDefinitions()
        : (body.constructor && body.constructor.tools) || {};
      if (tools && Object.keys(tools).length > 0) {
        compact.tools = this._compactTools(tools);
      }

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

  _compactTools(tools) {
    const out = {};
    for (const [name, def] of Object.entries(tools)) {
      out[name] = {
        description: def.description || "",
        ...(def.parameters ? { parameters: def.parameters } : {}),
      };
    }
    return out;
  }

  _compactSnapshot(snap, now) {
    const compact = { status: snap.status || "unknown" };
    if (snap.mode) compact.mode = snap.mode;

    if (Array.isArray(snap.pending_events) && snap.pending_events.length > 0) {
      const sorted = [...snap.pending_events].sort(
        (a, b) => priorityRank(a.priority) - priorityRank(b.priority)
      );
      const kept = this._capEventsByPriority(sorted, this.maxPendingEventsPerBody);
      compact.pending_events = kept.map((e) => {
        if (typeof e === "string") return { type: e, priority: "NORMAL" };
        return { type: e.type || "event", priority: e.priority || "NORMAL" };
      });
    }

    if (typeof snap.updated_at === "number") {
      const age = now - snap.updated_at;
      if (age > this.staleMs) { compact.stale = true; compact.age_ms = age; }
    }

    for (const [k, v] of Object.entries(snap)) {
      if (["status", "mode", "pending_events", "updated_at"].includes(k)) continue;
      compact[k] = this._compactValue(v);
    }
    return compact;
  }

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
    if (typeof v === "number") return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
    if (typeof v === "string") return v.length > 120 ? v.slice(0, 117) + "..." : v;
    if (Array.isArray(v)) return v.slice(0, 10).map((x) => this._compactValue(x));
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

  _tokenEstimate(obj) {
    try { return Math.ceil(JSON.stringify(obj).length / CHARS_PER_TOKEN); }
    catch { return Infinity; }
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

    if (this._tokenEstimate(out) > this.tokenBudget) {
      out.recent_history = out.recent_history.slice(-5);
    }
    if (this._tokenEstimate(out) > this.tokenBudget) {
      this._dropEventsAtPriority(out, "LOW");
    }
    if (this._tokenEstimate(out) > this.tokenBudget) {
      this._dropEventsAtPriority(out, "NORMAL");
    }
    if (this._tokenEstimate(out) > this.tokenBudget) {
      this._dropEventsAtPriority(out, "HIGH");
    }
    if (this._tokenEstimate(out) > this.tokenBudget) {
      for (const name of Object.keys(out.bodies)) {
        const b = out.bodies[name];
        const criticalEvents = (b.pending_events || []).filter(
          (e) => (e.priority || "NORMAL") === "CRITICAL"
        );
        // Keep tools so the brain can still act, just strip other fields.
        out.bodies[name] = {
          status: b.status,
          ...(b.tools ? { tools: b.tools } : {}),
          ...(criticalEvents.length > 0 ? { pending_events: criticalEvents } : {}),
          truncated: true,
        };
      }
    }
    if (this._tokenEstimate(out) > this.tokenBudget) {
      out.recent_history = [];
    }
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
    return { ...this.stats, droppedByPriority: { ...this.stats.droppedByPriority } };
  }
}

module.exports = { Aggregator, PRIORITY_RANK };
