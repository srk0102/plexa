// Brain -- base class for LLM providers.
// Produces structured tool calls. No text parsing.
// Subclass implements _rawCall(prompt). Returns the raw text response.

const VALID_INTENT_KEYS = new Set([
  "target_body",
  "tool",
  "action",       // legacy alias for tool
  "parameters",
  "priority",
  "fallback",
]);

class Brain {
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

  async _rawCall(prompt) {
    throw new Error("Brain._rawCall() must be implemented by subclass");
  }

  async invoke(worldState) {
    const start = Date.now();
    this.callCount++;
    try {
      const prompt = this.buildPrompt(worldState);
      const raw = await this._rawCall(prompt);
      const intent = this.parseResponse(raw);
      this.lastCallMs = Date.now() - start;
      this.totalDurationMs += this.lastCallMs;
      return intent;
    } catch (e) {
      this.errorCount++;
      this.lastCallMs = Date.now() - start;
      this.totalDurationMs += this.lastCallMs;
      throw e;
    }
  }

  buildPrompt(worldState) {
    const bodies = worldState.bodies || {};
    const goal = worldState.active_goal || "no active goal";
    const history = (worldState.recent_history || []).slice(-5);

    const bodyBlocks = Object.entries(bodies).map(([name, state]) => {
      const lines = [`- body: ${name}`, `  status: ${state.status || "unknown"}`];

      if (state.mode) lines.push(`  mode: ${state.mode}`);

      // Tool definitions for this body
      if (state.tools) {
        lines.push(`  tools:`);
        for (const [tName, tDef] of Object.entries(state.tools)) {
          lines.push(`    ${tName}: ${tDef.description || ""}`);
          if (tDef.parameters) {
            const keys = Object.keys(tDef.parameters).join(", ") || "none";
            lines.push(`      params: ${keys}`);
          }
        }
      }

      if (state.pending_events && state.pending_events.length > 0) {
        const types = state.pending_events
          .map((e) => `${e.type}(${e.priority || "NORMAL"})`)
          .join(", ");
        lines.push(`  pending_events: ${types}`);
      }

      for (const [k, v] of Object.entries(state)) {
        if (["status", "mode", "pending_events", "tools", "updated_at", "truncated"].includes(k)) continue;
        lines.push(`  ${k}: ${JSON.stringify(v)}`);
      }

      return lines.join("\n");
    });

    const historyLine = history.length > 0
      ? `Recent actions:\n${history.map((h) => `  - ${h}`).join("\n")}`
      : "Recent actions: none";

    const userPrompt = [
      `Active goal: ${goal}`,
      ``,
      `Bodies and their tools:`,
      bodyBlocks.join("\n\n") || "  (none)",
      ``,
      historyLine,
      ``,
      `Return one tool call as JSON with these exact fields:`,
      `  target_body: body name from the list above`,
      `  tool: a tool name declared by that body`,
      `  parameters: object matching the tool's declared params`,
      `  priority: integer 1-5 (optional, default 3)`,
      `  fallback: string (optional)`,
      ``,
      `Respond with JSON only. No explanation.`,
    ].join("\n");

    return `${this.systemPrompt}\n\n${userPrompt}`;
  }

  parseResponse(raw) {
    if (!raw || typeof raw !== "string") return null;

    let parsed = this._tryParse(raw);
    if (!parsed) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = this._tryParse(match[0]);
    }
    if (!parsed) return null;
    return this._validateIntent(parsed);
  }

  _tryParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  _validateIntent(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    if (typeof obj.target_body !== "string" || !obj.target_body) return null;

    // Accept tool or action (legacy)
    const tool = obj.tool || obj.action;
    if (typeof tool !== "string" || !tool) return null;

    const intent = {
      target_body: obj.target_body,
      tool,
      parameters: (obj.parameters && typeof obj.parameters === "object" && !Array.isArray(obj.parameters))
        ? obj.parameters : {},
      priority: Number.isFinite(obj.priority) ? Math.min(5, Math.max(1, Math.round(obj.priority))) : 3,
      fallback: typeof obj.fallback === "string" ? obj.fallback : "hold_position",
    };

    for (const key of Object.keys(intent)) {
      if (!VALID_INTENT_KEYS.has(key)) delete intent[key];
    }
    return intent;
  }

  _defaultSystemPrompt() {
    return [
      "You are the brain of a multi-body embodied system.",
      "Each body runs its own muscle at 60fps and handles routine actions.",
      "You decide WHAT to do and which body should do it by calling one of that body's tools.",
      "You do not control actuators directly. You choose a tool and its parameters.",
      "",
      "Always return a single JSON tool call. Nothing else.",
    ].join("\n");
  }

  stats() {
    return {
      model: this.model,
      calls: this.callCount,
      errors: this.errorCount,
      totalDurationMs: this.totalDurationMs,
      lastCallMs: this.lastCallMs,
      avgCallMs: this.callCount > 0 ? Math.round(this.totalDurationMs / this.callCount) : 0,
    };
  }
}

module.exports = { Brain };
