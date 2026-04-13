// Translator -- JOB 1: convert LLM intent into an SCP command.
// Validates the intent against known bodies and their declared capabilities.
// Returns a structured command object or a structured error.
// Never throws. The caller (Space) decides what to do with errors.

class Translator {
  /**
   * @param {object} [opts]
   * @param {Set<string>} [opts.allowedActions] - optional global allowlist
   */
  constructor(opts = {}) {
    this.allowedActions = opts.allowedActions || null;

    this.stats = {
      translated: 0,
      rejected: 0,
      byReason: {},
    };
  }

  /**
   * Translate an LLM intent into an SCP command.
   * @param {object} intent - parsed from Brain.invoke()
   * @param {Map<string, BodyAdapter>} bodies - Space.bodies
   * @returns {{ ok: true, command: object } | { ok: false, error: string, reason: string }}
   */
  translate(intent, bodies) {
    // Input shape
    if (!intent || typeof intent !== "object") {
      return this._reject("invalid_intent", "intent is not an object");
    }

    const { target_body, action, parameters, priority, fallback } = intent;

    // Required fields
    if (typeof target_body !== "string" || !target_body) {
      return this._reject("missing_target_body", "target_body must be a non-empty string");
    }
    if (typeof action !== "string" || !action) {
      return this._reject("missing_action", "action must be a non-empty string");
    }

    // Body must exist
    const body = bodies && typeof bodies.get === "function" ? bodies.get(target_body) : null;
    if (!body) {
      return this._reject(
        "unknown_body",
        `target_body "${target_body}" is not registered in this Space`
      );
    }

    // Body must declare capability (if it declares any)
    if (body.capabilities && body.capabilities.size > 0 && !body.capabilities.has(action)) {
      return this._reject(
        "capability_denied",
        `body "${target_body}" does not declare action "${action}"`
      );
    }

    // Global allowlist (optional)
    if (this.allowedActions && !this.allowedActions.has(action)) {
      return this._reject(
        "action_not_allowed",
        `action "${action}" is not in the global allowlist`
      );
    }

    // Parameters must be a plain object
    const params = (parameters && typeof parameters === "object" && !Array.isArray(parameters))
      ? parameters
      : {};

    // Priority: clamp to 1-5, default 3
    const prio = Number.isFinite(priority)
      ? Math.min(5, Math.max(1, Math.round(priority)))
      : 3;

    // Fallback: non-empty string or "hold_position"
    const fb = (typeof fallback === "string" && fallback) ? fallback : "hold_position";

    this.stats.translated++;

    return {
      ok: true,
      command: {
        body: target_body,
        action,
        parameters: params,
        priority: prio,
        fallback: fb,
        ts: Date.now(),
      },
    };
  }

  // -- Internal --

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
