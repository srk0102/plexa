// Brain -- base class for LLM providers that decide intent.
// Subclass this for Ollama, OpenAI, Bedrock, etc.
// The brain returns structured intent. Project Space translates and dispatches.
// The brain does not know about bodies, transports, or safety.

const VALID_INTENT_KEYS = new Set([
  "target_body",
  "action",
  "parameters",
  "priority",
  "fallback",
]);

class Brain {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - model identifier
   * @param {string} [opts.systemPrompt] - system prompt text
   * @param {number} [opts.maxTokens] - default 512
   * @param {number} [opts.temperature] - default 0.1
   */
  constructor(opts = {}) {
    this.model = opts.model || null;
    this.systemPrompt = opts.systemPrompt || this._defaultSystemPrompt();
    this.maxTokens = opts.maxTokens || 512;
    this.temperature = opts.temperature ?? 0.1;

    this.callCount = 0;
    this.errorCount = 0;
    this.totalDurationMs = 0;
    this.lastCallMs = 0;
  }

  // -- Must be implemented by subclass --

  /**
   * @param {string} prompt - full prompt text (system + user)
   * @returns {Promise<string>} - raw LLM text response
   */
  async _rawCall(prompt) {
    throw new Error("Brain._rawCall() must be implemented by subclass");
  }

  // -- Public API --

  /**
   * Invoke the brain with a world state snapshot.
   * Returns a structured intent object or null if the response was invalid.
   * Never throws for parse errors -- returns null.
   * @param {object} worldState - from Space._aggregateState()
   * @returns {Promise<object|null>}
   */
  async invoke(worldState) {
    const start = Date.now();
    this.callCount++;

    try {
      const prompt = this.buildPrompt(worldState);
      const raw = await this._rawCall(prompt);
      const intent = this.parseResponse(raw);

      this.lastCallMs = Date.now() - start;
      this.totalDurationMs += this.lastCallMs;

      return intent; // may be null if parse failed
    } catch (e) {
      this.errorCount++;
      this.lastCallMs = Date.now() - start;
      this.totalDurationMs += this.lastCallMs;
      throw e; // real errors bubble up (network, auth, etc.)
    }
  }

  // -- Prompt construction --

  buildPrompt(worldState) {
    const bodies = worldState.bodies || {};
    const goal = worldState.active_goal || "no active goal";
    const history = (worldState.recent_history || []).slice(-5);

    const bodyLines = Object.entries(bodies).map(([name, state]) => {
      const parts = [`  ${name}:`];
      parts.push(`    status: ${state.status || "unknown"}`);
      if (state.last_action) parts.push(`    last_action: ${state.last_action}`);
      if (state.pending_events && state.pending_events.length > 0) {
        const types = state.pending_events.map(e => e.type || e).join(", ");
        parts.push(`    pending_events: ${types}`);
      }
      // Include any other data fields
      for (const [k, v] of Object.entries(state)) {
        if (["status", "last_action", "pending_events", "updated_at"].includes(k)) continue;
        parts.push(`    ${k}: ${JSON.stringify(v)}`);
      }
      return parts.join("\n");
    });

    const historyLine = history.length > 0
      ? `Recent actions:\n${history.map(h => `  - ${h}`).join("\n")}`
      : "Recent actions: none";

    const userPrompt = [
      `Active goal: ${goal}`,
      ``,
      `Bodies:`,
      bodyLines.join("\n") || "  (none)",
      ``,
      historyLine,
      ``,
      `Return one intent as JSON with these exact fields:`,
      `  target_body: string (must match a body name above)`,
      `  action: string (what to do)`,
      `  parameters: object (action-specific args)`,
      `  priority: integer 1-5 (5 = most urgent)`,
      `  fallback: string (what to do if action fails)`,
      ``,
      `Respond with JSON only. No explanation.`,
    ].join("\n");

    return `${this.systemPrompt}\n\n${userPrompt}`;
  }

  // -- Response parsing --

  parseResponse(raw) {
    if (!raw || typeof raw !== "string") return null;

    // Try direct parse first
    let parsed = this._tryParse(raw);

    // Fallback: extract first JSON object from surrounding text
    if (!parsed) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = this._tryParse(match[0]);
      }
    }

    if (!parsed) return null;
    return this._validateIntent(parsed);
  }

  _tryParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  _validateIntent(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

    // Required fields
    if (typeof obj.target_body !== "string" || !obj.target_body) return null;
    if (typeof obj.action !== "string" || !obj.action) return null;

    // Normalize optional fields
    const intent = {
      target_body: obj.target_body,
      action: obj.action,
      parameters: (obj.parameters && typeof obj.parameters === "object" && !Array.isArray(obj.parameters))
        ? obj.parameters
        : {},
      priority: Number.isFinite(obj.priority) ? Math.min(5, Math.max(1, Math.round(obj.priority))) : 3,
      fallback: typeof obj.fallback === "string" ? obj.fallback : "hold_position",
    };

    // Strip any unknown keys
    for (const key of Object.keys(intent)) {
      if (!VALID_INTENT_KEYS.has(key)) delete intent[key];
    }

    return intent;
  }

  // -- Default prompt --

  _defaultSystemPrompt() {
    return [
      "You are the brain of a multi-body embodied system.",
      "Each body runs its own muscle layer at 60fps and handles routine actions.",
      "You decide WHAT to do and which body does it. You do not control actuators directly.",
      "",
      "Return one intent per call as JSON. Nothing else.",
    ].join("\n");
  }

  // -- Stats --

  stats() {
    return {
      model: this.model,
      calls: this.callCount,
      errors: this.errorCount,
      totalDurationMs: this.totalDurationMs,
      lastCallMs: this.lastCallMs,
      avgCallMs: this.callCount > 0
        ? Math.round(this.totalDurationMs / this.callCount)
        : 0,
    };
  }
}

module.exports = { Brain };
