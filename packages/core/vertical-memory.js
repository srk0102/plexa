// VerticalMemory -- cross-session memory of brain decisions at the Space
// level. The PatternStore and AdaptiveMemory layers live per-body and keep
// per-body local muscle memory. VerticalMemory sits in Plexa and remembers
// what the *brain* decided for a given world state.
//
// The goal: after N sessions on the same task, Space consults memory before
// firing the LLM. If a confident match exists, the LLM call is skipped.
//
// Similarity is intentionally simple: compare the set of body names + tool
// names + goal + a hash of pending-event types. Good world-state diffing
// lives in `search(worldState, limit)`.
//
// Storage: SQLite via better-sqlite3 when available, in-memory otherwise.

const { EventEmitter } = require("node:events");

const DEFAULT_HIT_THRESHOLD = 0.85;
const DEFAULT_MAX_ENTRIES = 2000;

class VerticalMemory extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.spaceName]     isolates entries per space
   * @param {string} [opts.dbPath]        SQLite path (optional)
   * @param {number} [opts.hitThreshold]  similarity score to treat as hit (default 0.85)
   * @param {number} [opts.maxEntries]    cap before eviction (default 2000)
   */
  constructor(opts = {}) {
    super();
    this.spaceName = opts.spaceName || "default";
    this.dbPath = opts.dbPath || null;
    this.hitThreshold = opts.hitThreshold ?? DEFAULT_HIT_THRESHOLD;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

    this.entries = [];
    this._nextId = 1;
    this._sessionsSeen = new Set();
    this._db = null;

    this._stats = {
      total: 0,
      stored: 0,
      searches: 0,
      hits: 0,
      misses: 0,
      successes: 0,
      failures: 0,
    };
  }

  // -- Write --

  /**
   * Record a decision. `outcome` is optional (true/false).
   *
   * @param {string} bodyName
   * @param {string} toolName
   * @param {object} worldState
   * @param {*}      decision
   * @param {object} [meta]      { confidence, source, sessionId, outcome }
   */
  async store(bodyName, toolName, worldState, decision, meta = {}) {
    const entry = {
      id: this._nextId++,
      spaceName: this.spaceName,
      bodyName,
      toolName,
      worldState: this._compactWorldState(worldState),
      decision,
      confidence: typeof meta.confidence === "number" ? meta.confidence : 0.7,
      source: meta.source || "brain",
      sessionId: meta.sessionId || "unknown",
      outcome: typeof meta.outcome === "boolean" ? meta.outcome : null,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    this._sessionsSeen.add(entry.sessionId);
    this._stats.stored++;
    this._stats.total = this.entries.length;
    this._evict();
    return entry;
  }

  // -- Search --

  /**
   * Return the best matches for the given world state, ranked by similarity.
   * Each result is shaped so the brain prompt can render it:
   *   { body, tool, decision, confidence, age_ms }
   *
   * @param {object} worldState
   * @param {number} [limit]  default 5
   */
  async search(worldState, limit = 5) {
    this._stats.searches++;
    if (this.entries.length === 0) {
      this._stats.misses++;
      return [];
    }
    const target = this._compactWorldState(worldState);
    const now = Date.now();

    const scored = this.entries.map((e) => ({
      entry: e,
      sim: this._similarity(target, e.worldState),
    }));
    scored.sort((a, b) => b.sim - a.sim);

    const out = scored.slice(0, Math.max(1, limit)).map(({ entry, sim }) => ({
      body: entry.bodyName,
      tool: entry.toolName,
      decision: entry.decision,
      confidence: Number((sim * entry.confidence).toFixed(3)),
      age_ms: now - entry.createdAt,
    }));

    if (out[0] && out[0].confidence >= this.hitThreshold) this._stats.hits++;
    else this._stats.misses++;
    return out;
  }

  /**
   * Report outcome for the most-recent decision matching (bodyName, toolName).
   * The orchestrator calls this when it can decide whether the action worked.
   */
  async recordOutcome(bodyName, toolName, success) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.bodyName === bodyName && e.toolName === toolName && e.outcome == null) {
        e.outcome = !!success;
        if (success) { e.confidence = Math.min(1, e.confidence + 0.1); this._stats.successes++; }
        else { e.confidence = Math.max(0, e.confidence - 0.15); this._stats.failures++; }
        return true;
      }
    }
    return false;
  }

  stats() {
    const successRate = (this._stats.successes + this._stats.failures) > 0
      ? Number((this._stats.successes / (this._stats.successes + this._stats.failures)).toFixed(3))
      : null;
    const byBody = {};
    for (const e of this.entries) {
      byBody[e.bodyName] = (byBody[e.bodyName] || 0) + 1;
    }
    return {
      total: this.entries.length,
      stored: this._stats.stored,
      searches: this._stats.searches,
      hits: this._stats.hits,
      misses: this._stats.misses,
      hitRate: (this._stats.hits + this._stats.misses) > 0
        ? Number((this._stats.hits / (this._stats.hits + this._stats.misses)).toFixed(3))
        : 0,
      successRate,
      sessionsCount: this._sessionsSeen.size,
      byBody,
    };
  }

  // -- Persistence --

  async save() {
    if (!this.dbPath) return this.entries.length;
    this._ensureDb();
    if (!this._db) return this.entries.length;
    const upsert = this._db.prepare(`
      INSERT OR REPLACE INTO space_memory
        (id, space_name, body_name, tool_name, world_state_json, decision_json,
         outcome, confidence, source, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this._db.transaction(() => {
      this._db.prepare("DELETE FROM space_memory WHERE space_name = ?").run(this.spaceName);
      for (const e of this.entries) {
        upsert.run(
          e.id, this.spaceName, e.bodyName, e.toolName,
          JSON.stringify(e.worldState), JSON.stringify(e.decision),
          e.outcome == null ? null : (e.outcome ? 1 : 0),
          e.confidence, e.source, e.sessionId, e.createdAt
        );
      }
    });
    tx();
    return this.entries.length;
  }

  async load() {
    if (!this.dbPath) return 0;
    this._ensureDb();
    if (!this._db) return 0;
    const rows = this._db
      .prepare("SELECT * FROM space_memory WHERE space_name = ? ORDER BY id ASC")
      .all(this.spaceName);
    this.entries = [];
    let maxId = 0;
    for (const row of rows) {
      let worldState = {}, decision = null;
      try { worldState = JSON.parse(row.world_state_json); } catch {}
      try { decision = JSON.parse(row.decision_json); } catch {}
      this.entries.push({
        id: row.id,
        spaceName: row.space_name,
        bodyName: row.body_name,
        toolName: row.tool_name,
        worldState,
        decision,
        confidence: row.confidence,
        source: row.source,
        sessionId: row.session_id,
        outcome: row.outcome == null ? null : !!row.outcome,
        createdAt: row.created_at,
      });
      this._sessionsSeen.add(row.session_id);
      if (row.id > maxId) maxId = row.id;
    }
    this._nextId = maxId + 1;
    this._stats.total = this.entries.length;
    return this.entries.length;
  }

  _ensureDb() {
    if (this._db || !this.dbPath) return;
    try {
      const Database = require("better-sqlite3");
      this._db = new Database(this.dbPath);
      this._db.pragma("journal_mode = WAL");
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS space_memory (
          id INTEGER PRIMARY KEY,
          space_name TEXT NOT NULL,
          body_name TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          world_state_json TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          outcome INTEGER,
          confidence REAL NOT NULL DEFAULT 0.7,
          source TEXT,
          session_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this._db.exec("CREATE INDEX IF NOT EXISTS idx_space_memory_space ON space_memory(space_name)");
    } catch {
      this._db = null;
    }
  }

  // -- Internals --

  _compactWorldState(ws) {
    if (!ws || typeof ws !== "object") return { goal: null, bodies: [], events: [] };
    const bodyNames = Object.keys(ws.bodies || {}).sort();
    const toolNames = [];
    const events = [];
    for (const name of bodyNames) {
      const b = ws.bodies[name] || {};
      if (b.tools) for (const t of Object.keys(b.tools)) toolNames.push(`${name}.${t}`);
      if (Array.isArray(b.pending_events)) {
        for (const e of b.pending_events) events.push(`${name}:${e.type}:${e.priority || "NORMAL"}`);
      }
    }
    return {
      goal: ws.active_goal || null,
      bodies: bodyNames,
      tools: toolNames.sort(),
      events: events.sort(),
    };
  }

  _similarity(a, b) {
    // Jaccard across bodies / tools / events plus goal equality.
    const bodiesSim = jaccard(a.bodies, b.bodies);
    const toolsSim = jaccard(a.tools, b.tools);
    const eventsSim = jaccard(a.events, b.events);
    const goalSim = (a.goal && b.goal && a.goal === b.goal) ? 1 : (!a.goal && !b.goal ? 1 : 0.5);
    // weights chosen so same bodies + same goal dominates.
    return 0.35 * bodiesSim + 0.25 * toolsSim + 0.2 * eventsSim + 0.2 * goalSim;
  }

  _evict() {
    if (this.entries.length <= this.maxEntries) return;
    // Evict oldest first.
    this.entries.sort((a, b) => a.createdAt - b.createdAt);
    this.entries.splice(0, this.entries.length - this.maxEntries);
  }
}

function jaccard(a = [], b = []) {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

module.exports = { VerticalMemory };
