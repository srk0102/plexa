// AnthropicBrain -- Plexa Brain backed by Anthropic's Messages API.
// Raw node:https, no SDK dependency.
//
// Usage:
//   const { AnthropicBrain } = require("@srk0102/plexa/bridges/anthropic")
//   space.setBrain(new AnthropicBrain({ apiKey: process.env.ANTHROPIC_API_KEY }))

const https = require("node:https");
const { Brain } = require("../core/brain");

const DEFAULT_HOST = "api.anthropic.com";
const DEFAULT_PATH = "/v1/messages";
const DEFAULT_VERSION = "2023-06-01";

class AnthropicBrain extends Brain {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]       defaults to process.env.ANTHROPIC_API_KEY
   * @param {string} [opts.model]        defaults to "claude-haiku-4-5-20251001"
   * @param {string} [opts.host]         default "api.anthropic.com"
   * @param {string} [opts.path]         default "/v1/messages"
   * @param {string} [opts.version]      anthropic-version header, default "2023-06-01"
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.maxTokens]    default 512
   * @param {number} [opts.temperature]  default 0.1
   * @param {number} [opts.timeoutMs]    default 30000
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "claude-haiku-4-5-20251001";
    this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || null;
    this.host = opts.host || DEFAULT_HOST;
    this.path = opts.path || DEFAULT_PATH;
    this.version = opts.version || DEFAULT_VERSION;
    this.timeoutMs = opts.timeoutMs || 30000;
  }

  async _rawCall(prompt) {
    if (!this.apiKey) {
      throw new Error("AnthropicBrain: missing apiKey (set ANTHROPIC_API_KEY or pass opts.apiKey)");
    }

    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: this.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = await this._post(body);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`AnthropicBrain: non-JSON response: ${raw.slice(0, 200)}`);
    }

    if (parsed.type === "error" || parsed.error) {
      const msg = (parsed.error && parsed.error.message) || "unknown error";
      throw new Error(`AnthropicBrain API error: ${msg}`);
    }

    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const text = content.find((b) => b.type === "text");
    return text && typeof text.text === "string" ? text.text : "";
  }

  _post(body) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "POST",
          hostname: this.host,
          port: 443,
          path: this.path,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": this.version,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Anthropic HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            } else {
              resolve(data);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Anthropic request timed out"));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * Lightweight availability check -- true if an API key is configured.
   * Does not make a network call.
   * @returns {boolean}
   */
  static isAvailable() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }
}

module.exports = { AnthropicBrain };
