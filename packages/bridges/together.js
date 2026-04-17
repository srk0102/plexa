// TogetherBrain -- Plexa Brain backed by Together.ai API.
// OpenAI-compatible endpoint. Cheap models (Llama, Qwen, Mistral).
//
// Usage:
//   const { TogetherBrain } = require("@srk0102/plexa/bridges/together")
//   space.setBrain(new TogetherBrain({ apiKey: process.env.TOGETHER_API_KEY }))

const https = require("node:https");
const { Brain } = require("../core/brain");

class TogetherBrain extends Brain {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]       defaults to process.env.TOGETHER_API_KEY
   * @param {string} [opts.model]        defaults to "meta-llama/Meta-Llama-3-8B-Instruct-Lite"
   * @param {string} [opts.host]         default "api.together.xyz"
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.maxTokens]    default 512
   * @param {number} [opts.temperature]  default 0.1
   * @param {number} [opts.timeoutMs]    default 30000
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "meta-llama/Meta-Llama-3-8B-Instruct-Lite";
    this.apiKey = opts.apiKey || process.env.TOGETHER_API_KEY || null;
    this.host = opts.host || "api.together.xyz";
    this.timeoutMs = opts.timeoutMs || 30000;
  }

  async _rawCall(prompt) {
    if (!this.apiKey) {
      throw new Error("TogetherBrain: missing apiKey (set TOGETHER_API_KEY or pass opts.apiKey)");
    }

    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: prompt },
      ],
    });

    const raw = await this._post(body);
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      throw new Error(`TogetherBrain: non-JSON response: ${raw.slice(0, 200)}`);
    }

    if (parsed.error) {
      throw new Error(`Together API error: ${parsed.error.message || "unknown"}`);
    }

    return parsed.choices?.[0]?.message?.content || "";
  }

  _post(body) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: "POST",
          hostname: this.host,
          port: 443,
          path: "/v1/chat/completions",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Together HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            } else {
              resolve(data);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("Together request timed out")); });
      req.write(body);
      req.end();
    });
  }

  static isAvailable() {
    return Boolean(process.env.TOGETHER_API_KEY);
  }
}

module.exports = { TogetherBrain };
