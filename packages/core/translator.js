// Translator -- validate a structured tool call from the brain.
// Input: { target_body, tool, parameters, priority?, fallback? }
// Output: { ok: true, command } or { ok: false, reason, error }
// Never throws. No text parsing -- LLM must return structured JSON.

class Translator {
  constructor(opts = {}) {
    // Optional global allowlist: Set of "bodyName.toolName"
    this.allowedTools = opts.allowedTools || null;

    this.stats = {
      translated: 0,
      rejected: 0,
      byReason: {},
    };
  }

  /**
   * @param {object} intent - structured brain output
   * @param {Map<string, BodyAdapter>} bodies
   * @returns {{ok:true, command:object} | {ok:false, reason:string, error:string}}
   */
  translate(intent, bodies) {
    if (!intent || typeof intent !== "object") {
      return this._reject("invalid_intent", "intent is not an object");
    }

    // Accept both { tool } (new) and { action } (legacy) for back-compat
    const { target_body } = intent;
    const tool = intent.tool || intent.action;
    const { parameters, priority, fallback } = intent;

    if (typeof target_body !== "string" || !target_body) {
      return this._reject("missing_target_body", "target_body must be a non-empty string");
    }
    if (typeof tool !== "string" || !tool) {
      return this._reject("missing_tool", "tool must be a non-empty string");
    }

    const body = bodies && typeof bodies.get === "function" ? bodies.get(target_body) : null;
    if (!body) {
      return this._reject(
        "unknown_body",
        `target_body "${target_body}" is not registered in this Space`
      );
    }

    // Tool must be declared on the body
    const toolDefs = typeof body.getToolDefinitions === "function"
      ? body.getToolDefinitions()
      : (body.constructor && body.constructor.tools) || {};

    if (!toolDefs[tool]) {
      return this._reject(
        "unknown_tool",
        `body "${target_body}" does not declare tool "${tool}"`
      );
    }

    // Global tool allowlist check
    const fqn = `${target_body}.${tool}`;
    if (this.allowedTools && !this.allowedTools.has(fqn)) {
      return this._reject(
        "tool_not_allowed",
        `tool "${fqn}" not in global allowlist`
      );
    }

    // Parameter validation against declared schema
    const params = (parameters && typeof parameters === "object" && !Array.isArray(parameters))
      ? parameters : {};

    const schema = toolDefs[tool].parameters || {};
    const validationError = this._validateParameters(params, schema);
    if (validationError) {
      return this._reject("invalid_parameters", validationError);
    }

    const prio = Number.isFinite(priority)
      ? Math.min(5, Math.max(1, Math.round(priority)))
      : 3;
    const fb = (typeof fallback === "string" && fallback) ? fallback : "hold_position";

    this.stats.translated++;

    return {
      ok: true,
      command: {
        body: target_body,
        tool,
        parameters: params,
        priority: prio,
        fallback: fb,
        ts: Date.now(),
      },
    };
  }

  // -- Parameter validation (subset of JSON Schema) --

  _validateParameters(params, schema) {
    if (!schema || typeof schema !== "object") return null;

    for (const [key, def] of Object.entries(schema)) {
      if (def.required && !(key in params)) {
        return `missing required parameter "${key}"`;
      }
      if (!(key in params)) continue;

      const val = params[key];
      const type = def.type;

      if (type === "string") {
        if (typeof val !== "string") return `"${key}" must be string`;
        if (Array.isArray(def.enum) && !def.enum.includes(val)) {
          return `"${key}" must be one of [${def.enum.join(", ")}]`;
        }
      } else if (type === "number" || type === "integer") {
        if (typeof val !== "number" || Number.isNaN(val)) {
          return `"${key}" must be number`;
        }
        if (type === "integer" && !Number.isInteger(val)) {
          return `"${key}" must be integer`;
        }
        if (typeof def.min === "number" && val < def.min) {
          return `"${key}" must be >= ${def.min}`;
        }
        if (typeof def.max === "number" && val > def.max) {
          return `"${key}" must be <= ${def.max}`;
        }
      } else if (type === "boolean") {
        if (typeof val !== "boolean") return `"${key}" must be boolean`;
      }
      // Unknown types are skipped (loose validation)
    }
    return null;
  }

  _reject(reason, message) {
    this.stats.rejected++;
    this.stats.byReason[reason] = (this.stats.byReason[reason] || 0) + 1;
    return { ok: false, reason, error: message };
  }

  getStats() {
    return {
      translated: this.stats.translated,
      rejected: this.stats.rejected,
      byReason: { ...this.stats.byReason },
    };
  }
}

module.exports = { Translator };
