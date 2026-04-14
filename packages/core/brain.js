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

// Per-1k-token USD cost. Conservative 2026 list pricing; local models free.
// Prefix match (startsWith) so variant tags still map.
const DEFAULT_COST_TABLE = [
  ["llama",                        0.00000], // local ollama: free
  ["mistral",                      0.00000],
  ["phi",                          0.00000],
  ["qwen",                         0.00000],
  ["amazon.nova-micro",            0.00013],
  ["amazon.nova-lite",             0.00025],
  ["amazon.nova-pro",              0.00080],
  ["claude-haiku-4-5",             0.00025],
  ["claude-3-5-haiku",             0.00025],
  ["claude-haiku",                 0.00025],
  ["claude-3-5-sonnet",            0.00300],
  ["claude-sonnet-4",              0.00300],
  ["claude-opus-4",                0.01500],
  ["gpt-4o-mini",                  0.00015],
  ["gpt-4o",                       0.00250],
];

function costForModel(model) {
  if (!model || typeof model !== "string") return 0;
  const m = model.toLowerCase();
  for (const [prefix, cost] of DEFAULT_COST_TABLE) {
    if (m.includes(prefix)) return cost;
  }
  return 0;
}

class Brain {
  constructor(opts = {}) {
    this.model = opts.model || null;
    this.systemPrompt = opts.systemPrompt || this._defaultSystemPrompt();
    this.maxTokens = opts.maxTokens || 512;
    this.temperature = opts.temperature ?? 0.1;

    // Retry policy
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;

    // Cost tracking
    this.costPerKToken = typeof opts.costPerKToken === "number"
      ? opts.costPerKToken
      : costForModel(this.model);
    this.totalCost = 0;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;

    this.callCount = 0;
    this.errorCount = 0;
    this.retriesTotal = 0;
    this.retrySuccesses = 0;
    this.totalDurationMs = 0;
    this.lastCallMs = 0;
  }

  // Subclasses MUST implement. The default throws.
  async _rawCall(/* prompt */) {
    throw new Error("Brain._rawCall() must be implemented by subclass");
  }

  async invoke(worldState) {
    const start = Date.now();
    this.callCount++;
    try {
      const prompt = this.buildPrompt(worldState);
      const raw = await this._invokeWithRetry(prompt);
      const intent = this.parseResponse(raw);
      this.lastCallMs = Date.now() - start;
      this.totalDurationMs += this.lastCallMs;
      this._chargeCost(prompt, raw);
      return intent;
    } catch (e) {
      this.errorCount++;
      this.lastCallMs = Date.now() - start;
      this.totalDurationMs += this.lastCallMs;
      throw e;
    }
  }

  /**
   * Wrap _rawCall with retry logic:
   *   - network errors / timeouts: retry up to maxRetries
   *   - HTTP 429 (rate limit) in message: retry with exponential backoff
   *   - HTTP 5xx: retry once
   *   - HTTP 4xx except 429: no retry
   */
  async _invokeWithRetry(prompt) {
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const raw = await this._rawCall(prompt);
        if (attempt > 0) this.retrySuccesses++;
        return raw;
      } catch (e) {
        lastErr = e;
        const msg = (e && e.message) || "";
        const is429 = /HTTP 429|rate limit/i.test(msg);
        const is5xx = /HTTP 5\d\d/i.test(msg);
        const is4xx = /HTTP 4\d\d/i.test(msg) && !is429;
        const isNetwork = /ECONNREFUSED|ETIMEDOUT|timeout|ENOTFOUND|ECONNRESET|timed out/i.test(msg);

        if (is4xx) throw e;                  // do not retry hard client errors
        if (attempt >= this.maxRetries) throw e;
        if (!(is429 || is5xx || isNetwork)) throw e;

        this.retriesTotal++;
        const backoff = is429
          ? this.retryDelayMs * Math.pow(2, attempt)
          : this.retryDelayMs;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  _chargeCost(prompt, raw) {
    const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt || "");
    const rawText = typeof raw === "string" ? raw : "";
    const inputTokens = Math.ceil(promptText.length / 4);
    const outputTokens = Math.ceil(rawText.length / 4);
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    const cost = ((inputTokens + outputTokens) / 1000) * this.costPerKToken;
    this.totalCost += cost;
  }

  buildPrompt(worldState) {
    const bodies = worldState.bodies || {};
    const goal = worldState.active_goal || "no active goal";
    const history = (worldState.recent_history || []).slice(-5);

    const bodyBlocks = Object.entries(bodies).map(([name, state]) => {
      const lines = [`- body: ${name}`, `  status: ${state.status || "unknown"}`];

      if (state.mode) lines.push(`  mode: ${state.mode}`);

      // Tool definitions for this body (include full parameter spec so the
      // LLM knows types and enum constraints)
      if (state.tools) {
        lines.push(`  tools:`);
        for (const [tName, tDef] of Object.entries(state.tools)) {
          lines.push(`    ${tName}: ${tDef.description || ""}`);
          if (tDef.parameters && Object.keys(tDef.parameters).length > 0) {
            for (const [pName, pDef] of Object.entries(tDef.parameters)) {
              const parts = [];
              if (pDef.type) parts.push(pDef.type);
              if (Array.isArray(pDef.enum)) parts.push(`one of [${pDef.enum.map(v => JSON.stringify(v)).join(", ")}]`);
              if (typeof pDef.min === "number") parts.push(`min ${pDef.min}`);
              if (typeof pDef.max === "number") parts.push(`max ${pDef.max}`);
              if (pDef.required) parts.push("required");
              lines.push(`      ${pName}: ${parts.join(", ") || "any"}`);
            }
          } else {
            lines.push(`      (no parameters)`);
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
      retriesTotal: this.retriesTotal,
      retrySuccesses: this.retrySuccesses,
      totalDurationMs: this.totalDurationMs,
      lastCallMs: this.lastCallMs,
      avgCallMs: this.callCount > 0 ? Math.round(this.totalDurationMs / this.callCount) : 0,
      totalCost: Number(this.totalCost.toFixed(6)),
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      costPerKToken: this.costPerKToken,
    };
  }
}

// Exported for test harnesses that want to set or inspect the cost table.
Brain.costForModel = costForModel;
Brain.DEFAULT_COST_TABLE = DEFAULT_COST_TABLE;

module.exports = { Brain };
