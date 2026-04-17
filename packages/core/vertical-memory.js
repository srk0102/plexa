// VerticalMemory -- cross-session memory of brain REASONING at the Space
// level. The PatternStore and AdaptiveMemory layers live per-body and keep
// per-body local muscle memory (cached answers). VerticalMemory sits in
// Plexa and remembers HOW the brain REASONED about a given world state.
//
// Critical distinction:
//   PatternStore (SCP) caches ANSWERS:   input -> "halt"
//   VerticalMemory (Plexa) caches REASONING: input -> {indicators, weights, logic}
//
// When a similar world state is seen again, VerticalMemory does NOT
// return a cached answer blindly. It returns the REASONING PATTERN,
// which the caller EVALUATES against the current specific situation.
// Each case gets a fresh decision based on learned principles.
//
// The goal: after N sessions, Space consults memory and APPLIES learned
// reasoning instead of calling the LLM. The LLM taught the principles;
// VerticalMemory applies them to new situations without the LLM.
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
  /**
   * @param {object} [opts]
   * @param {string}   [opts.spaceName]         isolates entries per space
   * @param {string}   [opts.dbPath]            SQLite path (optional)
   * @param {number}   [opts.hitThreshold]      similarity score to treat as hit (default 0.85)
   * @param {number}   [opts.maxEntries]        cap before eviction (default 2000)
   * @param {string[]} [opts.allowedVariables]  schema enforcement: only these variable names allowed in reasoning indicators
   */
  constructor(opts = {}) {
    super();
    this.spaceName = opts.spaceName || "default";
    this.dbPath = opts.dbPath || null;
    this.hitThreshold = opts.hitThreshold ?? DEFAULT_HIT_THRESHOLD;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.allowedVariables = opts.allowedVariables || null; // null = no restriction
    this.dbAdapter = opts.dbAdapter || null; // PostgresAdapter, null = use SQLite/memory

    this.entries = [];
    this._nextId = 1;
    this._sessionsSeen = new Set();
    this._db = null;
    this._guardrails = []; // Level 1: immutable runtime guardrails

    this._stats = {
      total: 0,
      stored: 0,
      searches: 0,
      hits: 0,
      misses: 0,
      successes: 0,
      failures: 0,
      schemaRejections: 0,
      guardrailOverrides: 0,
      conflictsResolved: 0,
    };
  }

  // -- Level 1: Immutable Guardrails --

  /**
   * Add a guardrail function. Runs AFTER evaluate() scoring, BEFORE final decision.
   * Cannot be removed at runtime. Cannot be overridden by heuristics.
   *
   * @param {function} fn - (input, proposedDecision, score) => decision or null
   *   Return a decision string to override. Return null to pass through.
   */
  addGuardrail(fn) {
    if (typeof fn !== "function") throw new Error("addGuardrail: fn must be a function");
    this._guardrails.push(fn);
  }

  /**
   * Apply all guardrails to a proposed decision.
   * @returns {object} { decision, overriddenBy }
   */
  _applyGuardrails(input, proposedDecision, score) {
    for (let i = 0; i < this._guardrails.length; i++) {
      try {
        const override = this._guardrails[i](input, proposedDecision, score);
        if (override && typeof override === "string" && override !== proposedDecision) {
          this._stats.guardrailOverrides++;
          return { decision: override, overriddenBy: `guardrail_${i}` };
        }
      } catch {}
    }
    return { decision: proposedDecision, overriddenBy: null };
  }

  // -- Schema Validation --

  /**
   * Validate a reasoning object against the allowed schema.
   * Throws SchemaValidationError if invalid.
   */
  validateReasoning(reasoning) {
    if (!reasoning) return;
    const errors = [];
    const allowed = this.allowedVariables ? new Set(this.allowedVariables) : null;

    for (const ind of (reasoning.indicators || [])) {
      if (allowed && !allowed.has(ind.variable)) {
        errors.push(`unknown variable "${ind.variable}" (allowed: ${[...allowed].join(", ")})`);
      }
      if (typeof ind.weight === "number" && (ind.weight < 0 || ind.weight > 1)) {
        errors.push(`weight ${ind.weight} out of range [0, 1] for "${ind.variable}"`);
      }
    }
    for (const comp of (reasoning.compounds || [])) {
      for (const v of (comp.variables || [])) {
        if (allowed && !allowed.has(v)) {
          errors.push(`unknown compound variable "${v}" (allowed: ${[...allowed].join(", ")})`);
        }
      }
      if (typeof comp.weight === "number" && (comp.weight < 0 || comp.weight > 1)) {
        errors.push(`compound weight ${comp.weight} out of range [0, 1]`);
      }
    }
    if (typeof reasoning.threshold === "number" && (reasoning.threshold < 0 || reasoning.threshold > 1)) {
      errors.push(`threshold ${reasoning.threshold} out of range [0, 1]`);
    }

    if (errors.length > 0) {
      this._stats.schemaRejections++;
      const err = new Error(`SchemaValidationError: ${errors.join("; ")}`);
      err.code = "SCHEMA_VALIDATION_ERROR";
      err.details = errors;
      throw err;
    }
  }

  // -- Write --

  /**
   * Record a brain decision WITH its reasoning trace.
   *
   * @param {string} bodyName
   * @param {string} toolName
   * @param {object} worldState
   * @param {*}      decision
   * @param {object} [reasoning]  The brain's thought process:
   *   {
   *     indicators: [
   *       { variable: "obstacle_distance", weight: 0.4, condition: "< 2", matched: true },
   *       { variable: "speed", weight: 0.3, condition: "> 0.5", matched: true },
   *     ],
   *     threshold: 0.6,           // combined weight threshold for this decision
   *     explanation: "why the brain decided this way",
   *   }
   *   If null/omitted, the entry is stored as a plain answer cache (legacy mode).
   * @param {object} [meta]      { confidence, source, sessionId, outcome }
   */
  async store(bodyName, toolName, worldState, decision, reasoning, meta = {}) {
    // Backwards compat: if reasoning looks like old meta object (has sessionId,
    // confidence, source, or outcome but no indicators), shift args.
    if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning.indicators)) {
      const hasMetaKeys = "sessionId" in reasoning || "confidence" in reasoning
        || "source" in reasoning || "outcome" in reasoning;
      const hasReasoningKeys = "indicators" in reasoning || "compounds" in reasoning
        || "threshold" in reasoning;
      if (hasMetaKeys && !hasReasoningKeys) {
        meta = reasoning;
        reasoning = null;
      }
    }

    // Schema validation: reject hallucinated variables, out-of-range weights.
    if (reasoning) {
      this.validateReasoning(reasoning);
    }

    // Auto-generated (source=brain) starts at 0.5 confidence.
    // Human-approved (source=human) starts at 1.0.
    const defaultConf = (meta.source === "human" || meta.source === "manual") ? 1.0 : 0.5;
    const entry = {
      id: this._nextId++,
      spaceName: this.spaceName,
      bodyName,
      toolName,
      worldState: this._compactWorldState(worldState),
      decision,
      reasoning: reasoning || null,
      confidence: typeof meta.confidence === "number" ? meta.confidence : defaultConf,
      source: meta.source || "brain",
      sessionId: meta.sessionId || "unknown",
      outcome: typeof meta.outcome === "boolean" ? meta.outcome : null,
      createdAt: Date.now(),
      appliedCount: 0,
      successCount: 0,
      failureCount: 0,
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

  // -- Evaluate --

  /**
   * Apply a learned reasoning pattern to a NEW specific situation.
   *
   * Supports three types of indicators:
   *
   * 1. Simple indicators: { variable, weight, condition }
   *    Hard match. Variable meets condition = add weight. Else 0.
   *
   * 2. Fuzzy indicators: { variable, weight, condition, fuzzy: true }
   *    Partial match. If close to threshold, add partial weight.
   *    "9 requests when condition is > 10" scores 0.9 * weight, not 0.
   *
   * 3. Compound indicators: { variables: ["a","b"], conditions: ["< 24","true"], weight, all: true }
   *    Synergistic risk. BOTH must match to add weight.
   *    "New account AND VPN together = 0.6" even if each alone is low.
   *
   * @param {object} currentInput  - key-value pairs of current variables
   * @param {object} reasoning     - { indicators, compounds, threshold, explanation }
   */
  evaluate(currentInput, reasoning) {
    if (!reasoning || (!Array.isArray(reasoning.indicators) && !Array.isArray(reasoning.compounds))) {
      return { decision: null, score: 0, passes: false, matched: [], missed: [], explanation: "no reasoning to apply" };
    }

    let score = 0;
    const matched = [];
    const missed = [];

    // 1. Simple + fuzzy indicators
    for (const ind of (reasoning.indicators || [])) {
      const value = currentInput[ind.variable];
      const weight = typeof ind.weight === "number" ? ind.weight : 0;
      const doesMatch = _matchCondition(value, ind.condition);

      if (doesMatch) {
        score += weight;
        matched.push({ variable: ind.variable, weight, condition: ind.condition, value, type: "exact" });
      } else if (ind.fuzzy && typeof value === "number") {
        // Fuzzy: partial score based on proximity to threshold
        const fuzzyScore = _fuzzyMatch(value, ind.condition);
        if (fuzzyScore > 0) {
          const partial = weight * fuzzyScore;
          score += partial;
          matched.push({ variable: ind.variable, weight: Number(partial.toFixed(4)), condition: ind.condition, value, type: "fuzzy", proximity: Number(fuzzyScore.toFixed(3)) });
        } else {
          missed.push({ variable: ind.variable, weight, condition: ind.condition, value, type: "fuzzy" });
        }
      } else {
        missed.push({ variable: ind.variable, weight, condition: ind.condition, value, type: "exact" });
      }
    }

    // 2. Compound indicators (synergistic risk)
    for (const comp of (reasoning.compounds || [])) {
      if (!Array.isArray(comp.variables) || !Array.isArray(comp.conditions)) continue;
      const weight = typeof comp.weight === "number" ? comp.weight : 0;
      const allMatch = comp.all !== false; // default: all must match

      let matchCount = 0;
      const details = [];
      for (let i = 0; i < comp.variables.length; i++) {
        const v = currentInput[comp.variables[i]];
        const c = comp.conditions[i];
        const m = _matchCondition(v, c);
        if (m) matchCount++;
        details.push({ variable: comp.variables[i], condition: c, value: v, matched: m });
      }

      const passes = allMatch ? matchCount === comp.variables.length : matchCount > 0;
      if (passes) {
        score += weight;
        matched.push({ variables: comp.variables, weight, conditions: comp.conditions, type: "compound", details });
      } else {
        missed.push({ variables: comp.variables, weight, conditions: comp.conditions, type: "compound", details });
      }
    }

    const threshold = typeof reasoning.threshold === "number" ? reasoning.threshold : 0.5;
    return {
      decision: score >= threshold ? (reasoning.decision || null) : null,
      score: Number(score.toFixed(4)),
      passes: score >= threshold,
      matched,
      missed,
      explanation: reasoning.explanation || null,
    };
  }

  /**
   * High-level: search for relevant reasoning, evaluate all matches against
   * current input, resolve conflicts, apply guardrails, return final decision.
   *
   * Conflict resolution:
   *   1. Evaluate ALL matching heuristics (not just the first)
   *   2. Sort by confidence (highest first)
   *   3. Same confidence: sort by recency (newest first)
   *   4. Same confidence + same time: fail-open (ALLOW)
   *
   * Guardrails: applied AFTER conflict resolution, BEFORE returning.
   *
   * @param {object} worldState    - for similarity search
   * @param {object} currentInput  - for reasoning evaluation
   * @returns {object|null} evaluated result or null if no reasoning found
   */
  async searchAndEvaluate(worldState, currentInput) {
    const results = await this.search(worldState, 10); // broader search for conflict detection
    if (!results.length) {
      this._stats.misses++;
      return null;
    }

    // Evaluate ALL entries that have reasoning (not just first match per body+tool).
    const evaluations = [];
    const evaluated = new Set(); // track by entry id to avoid duplicates
    for (const match of results) {
      for (const entry of this.entries) {
        if (evaluated.has(entry.id)) continue;
        if (entry.bodyName !== match.body || entry.toolName !== match.tool) continue;
        if (!entry.reasoning) continue;
        evaluated.add(entry.id);

        const evaluation = this.evaluate(currentInput, entry.reasoning);
        evaluations.push({
          evaluation,
          entry,
          similarity: match.confidence,
        });
      }
    }

    if (evaluations.length === 0) {
      // Fallback: check for answer-only entries (no reasoning, V1 legacy).
      // These are plain cached decisions, returned if confidence is high enough.
      for (const match of results) {
        for (const entry of this.entries) {
          if (entry.bodyName !== match.body || entry.toolName !== match.tool) continue;
          if (entry.reasoning) continue; // already checked above
          const sim = match.confidence;
          if (sim >= this.hitThreshold && entry.confidence >= 0.5) {
            this._stats.hits++;
            entry.appliedCount = (entry.appliedCount || 0) + 1;
            const proposedDecision = entry.decision;
            const { decision: finalDecision, overriddenBy } = this._applyGuardrails(
              currentInput, typeof proposedDecision === "object" ? "allow" : proposedDecision, sim
            );
            return {
              decision: typeof proposedDecision === "object" ? proposedDecision : finalDecision,
              score: sim,
              passes: true,
              matched: [],
              missed: [],
              entry_id: entry.id,
              from_reasoning: false,
              confidence: entry.confidence,
              conflict: null,
              guardrail_override: overriddenBy,
            };
          }
        }
      }
      this._stats.misses++;
      return null;
    }

    // Only keep evaluations that pass their threshold.
    const passing = evaluations.filter((e) => e.evaluation.passes);
    const failing = evaluations.filter((e) => !e.evaluation.passes);

    // If nothing passes, it's a genuine "allow" based on learned reasoning.
    // But also a miss if we expected something to trigger.
    if (passing.length === 0) {
      this._stats.misses++;
      return null;
    }

    // Conflict resolution: sort passing heuristics.
    // 1. Highest entry confidence first
    // 2. Same confidence: most recent first
    passing.sort((a, b) => {
      if (b.entry.confidence !== a.entry.confidence) return b.entry.confidence - a.entry.confidence;
      return b.entry.createdAt - a.entry.createdAt;
    });

    // Detect conflicts (multiple heuristics passing with different decisions).
    const decisions = new Set(passing.map((p) => p.evaluation.decision || p.entry.decision));
    const hasConflict = decisions.size > 1;

    if (hasConflict) {
      this._stats.conflictsResolved++;
    }

    // Winner: highest confidence, most recent.
    const winner = passing[0];
    let proposedDecision = winner.evaluation.decision || winner.entry.decision;

    // Fail-open: if there's a conflict and winner confidence equals runner-up,
    // and their decisions differ, default to ALLOW.
    if (hasConflict && passing.length > 1) {
      const runnerUp = passing[1];
      const winnerDecision = winner.evaluation.decision || winner.entry.decision;
      const runnerDecision = runnerUp.evaluation.decision || runnerUp.entry.decision;
      if (
        winnerDecision !== runnerDecision &&
        winner.entry.confidence === runnerUp.entry.confidence &&
        winner.entry.createdAt === runnerUp.entry.createdAt
      ) {
        proposedDecision = "allow"; // fail-open
      }
    }

    // Apply Level 1 guardrails.
    const { decision: finalDecision, overriddenBy } = this._applyGuardrails(
      currentInput, proposedDecision, winner.evaluation.score
    );

    // Update stats on the winning entry.
    winner.entry.appliedCount = (winner.entry.appliedCount || 0) + 1;
    this._stats.hits++;

    return {
      ...winner.evaluation,
      decision: finalDecision,
      entry_id: winner.entry.id,
      from_reasoning: true,
      confidence: winner.entry.confidence,
      conflict: hasConflict ? {
        total_passing: passing.length,
        decisions_seen: [...decisions],
        resolution: "highest_confidence_wins",
      } : null,
      guardrail_override: overriddenBy,
    };
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
    // Postgres adapter takes priority.
    if (this.dbAdapter && typeof this.dbAdapter.save === "function") {
      return this.dbAdapter.save(this.spaceName, this.entries);
    }
    if (!this.dbPath) return this.entries.length;
    this._ensureDb();
    if (!this._db) return this.entries.length;
    const upsert = this._db.prepare(`
      INSERT OR REPLACE INTO space_memory
        (id, space_name, body_name, tool_name, world_state_json, decision_json,
         reasoning_json, outcome, confidence, source, session_id, created_at,
         applied_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this._db.transaction(() => {
      this._db.prepare("DELETE FROM space_memory WHERE space_name = ?").run(this.spaceName);
      for (const e of this.entries) {
        upsert.run(
          e.id, this.spaceName, e.bodyName, e.toolName,
          JSON.stringify(e.worldState), JSON.stringify(e.decision),
          e.reasoning ? JSON.stringify(e.reasoning) : null,
          e.outcome == null ? null : (e.outcome ? 1 : 0),
          e.confidence, e.source, e.sessionId, e.createdAt,
          e.appliedCount || 0
        );
      }
    });
    tx();
    return this.entries.length;
  }

  async load() {
    // Postgres adapter takes priority.
    if (this.dbAdapter && typeof this.dbAdapter.load === "function") {
      const loaded = await this.dbAdapter.load(this.spaceName);
      this.entries = loaded;
      let maxId = 0;
      for (const e of loaded) {
        this._sessionsSeen.add(e.sessionId);
        if (e.id > maxId) maxId = e.id;
      }
      this._nextId = maxId + 1;
      this._stats.total = this.entries.length;
      return this.entries.length;
    }
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
      let reasoning = null;
      try { if (row.reasoning_json) reasoning = JSON.parse(row.reasoning_json); } catch {}
      this.entries.push({
        id: row.id,
        spaceName: row.space_name,
        bodyName: row.body_name,
        toolName: row.tool_name,
        worldState,
        decision,
        reasoning,
        confidence: row.confidence,
        source: row.source,
        sessionId: row.session_id,
        outcome: row.outcome == null ? null : !!row.outcome,
        createdAt: row.created_at,
        appliedCount: row.applied_count || 0,
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
          reasoning_json TEXT,
          outcome INTEGER,
          confidence REAL NOT NULL DEFAULT 0.7,
          source TEXT,
          session_id TEXT,
          created_at INTEGER NOT NULL,
          applied_count INTEGER DEFAULT 0
        )
      `);
      // Add columns if upgrading from older schema.
      try { this._db.exec("ALTER TABLE space_memory ADD COLUMN reasoning_json TEXT"); } catch {}
      try { this._db.exec("ALTER TABLE space_memory ADD COLUMN applied_count INTEGER DEFAULT 0"); } catch {}
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

/**
 * Match a value against a condition string.
 * Supports: "< N", "> N", "<= N", ">= N", "= V", "true", "false", "!= V"
 * Falls back to string equality if no operator found.
 */
function _matchCondition(value, condition) {
  if (value === undefined || value === null) return false;
  if (condition === undefined || condition === null) return false;
  const cond = String(condition).trim();

  // Boolean shortcuts
  if (cond === "true") return value === true || value === "true" || value === 1;
  if (cond === "false") return value === false || value === "false" || value === 0;

  // Comparison operators
  const cmpMatch = cond.match(/^(<=?|>=?|!=|=)\s*(.+)$/);
  if (cmpMatch) {
    const op = cmpMatch[1];
    const rhs = parseFloat(cmpMatch[2]);
    const lhs = typeof value === "number" ? value : parseFloat(value);
    if (isNaN(lhs) || isNaN(rhs)) {
      // String comparison for = and !=
      if (op === "=") return String(value) === cmpMatch[2].trim();
      if (op === "!=") return String(value) !== cmpMatch[2].trim();
      return false;
    }
    if (op === "<") return lhs < rhs;
    if (op === "<=") return lhs <= rhs;
    if (op === ">") return lhs > rhs;
    if (op === ">=") return lhs >= rhs;
    if (op === "=") return lhs === rhs;
    if (op === "!=") return lhs !== rhs;
  }

  // Fallback: string equality
  return String(value) === cond;
}

/**
 * Fuzzy match: how close is a numeric value to meeting a condition?
 * Returns 0-1. 0 = not close. 1 = meets it. 0.5-0.99 = close but doesn't meet.
 *
 * Example: value=9, condition="> 10"
 *   9 is 90% of the way to 10 -> returns ~0.9
 *   An attacker sending 9 requests to dodge "> 10" still scores 0.27 (0.3 * 0.9)
 *   instead of 0.0 with hard matching.
 */
function _fuzzyMatch(value, condition) {
  if (typeof value !== "number") return 0;
  const cond = String(condition).trim();
  const m = cond.match(/^(<=?|>=?)\s*(.+)$/);
  if (!m) return 0;

  const op = m[1];
  const threshold = parseFloat(m[2]);
  if (isNaN(threshold)) return 0;

  // How far is the value from meeting the condition?
  // Returns 0-1 where 1 = meets it, 0 = far away
  const margin = Math.abs(threshold) * 0.3 || 3; // 30% margin or at least 3

  if (op === ">" || op === ">=") {
    if (value >= threshold) return 1;
    const dist = threshold - value;
    return dist <= margin ? Math.max(0, 1 - (dist / margin)) : 0;
  }
  if (op === "<" || op === "<=") {
    if (value <= threshold) return 1;
    const dist = value - threshold;
    return dist <= margin ? Math.max(0, 1 - (dist / margin)) : 0;
  }
  return 0;
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
