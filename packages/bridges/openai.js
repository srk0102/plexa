// OpenAIBrain -- Plexa Brain backed by OpenAI's Chat Completions API.
// Raw node:https, no SDK dependency.
//
// Usage:
//   const { OpenAIBrain } = require("@srk0102/plexa/bridges/openai")
//   space.setBrain(new OpenAIBrain({ apiKey: process.env.OPENAI_API_KEY }))

const https = require("node:https");
const { Brain } = require("../core/brain");

class OpenAIBrain extends Brain {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]       defaults to process.env.OPENAI_API_KEY
   * @param {string} [opts.model]        defaults to "gpt-4o-mini"
   * @param {string} [opts.host]         default "api.openai.com"
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.maxTokens]    default 512
   * @param {number} [opts.temperature]  default 0.1
   * @param {number} [opts.timeoutMs]    default 30000
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "gpt-4o-mini";
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || null;
    this.host = opts.host || "api.openai.com";
    this.timeoutMs = opts.timeoutMs || 30000;
  }

  async _rawCall(prompt) {
    if (!this.apiKey) {
      throw new Error("OpenAIBrain: missing apiKey (set OPENAI_API_KEY or pass opts.apiKey)");
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
      throw new Error(`OpenAIBrain: non-JSON response: ${raw.slice(0, 200)}`);
    }

    if (parsed.error) {
      throw new Error(`OpenAI API error: ${parsed.error.message || "unknown"}`);
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
              reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            } else {
              resolve(data);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("OpenAI request timed out")); });
      req.write(body);
      req.end();
    });
  }

  static isAvailable() {
    return Boolean(process.env.OPENAI_API_KEY);
  }
}

module.exports = { OpenAIBrain };
