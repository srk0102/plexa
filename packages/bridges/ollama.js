// OllamaBrain -- Brain subclass for local Ollama models.
// Free, local, zero API key. Default for getting started.
// Requires: ollama installed and running (ollama serve)

const http = require("node:http");
const { Brain } = require("../core/brain");

class OllamaBrain extends Brain {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - Ollama model name, default "llama3.2"
   * @param {string} [opts.host] - Ollama API host, default "http://localhost:11434"
   * @param {string} [opts.systemPrompt] - system prompt override
   * @param {number} [opts.maxTokens] - default 512
   * @param {number} [opts.temperature] - default 0.1
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "llama3.2";
    this.host = opts.host || "http://localhost:11434";
  }

  async _rawCall(prompt) {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: prompt },
      ],
      stream: false,
      options: {
        temperature: this.temperature,
        num_predict: this.maxTokens,
      },
    });

    const raw = await this._post("/api/chat", body);
    const parsed = JSON.parse(raw);

    if (parsed.error) {
      throw new Error(`Ollama error: ${parsed.error}`);
    }

    const content = parsed.message && parsed.message.content;
    return typeof content === "string" ? content : "";
  }

  // -- HTTP helpers --

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.host);
      const req = http.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Ollama HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            } else {
              resolve(data);
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  // -- Static health check --

  /**
   * Quick health check. Returns true if Ollama is running and reachable.
   * Never throws.
   * @param {string} [host] - Ollama host, default "http://localhost:11434"
   * @returns {Promise<boolean>}
   */
  static isAvailable(host = "http://localhost:11434") {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      try {
        const url = new URL("/api/tags", host);
        const req = http.request(
          {
            method: "GET",
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            timeout: 2000,
          },
          (res) => {
            // Drain the response so the socket closes cleanly
            res.on("data", () => {});
            res.on("end", () => finish(res.statusCode === 200));
          }
        );
        req.on("error", () => finish(false));
        req.on("timeout", () => {
          req.destroy();
          finish(false);
        });
        req.end();
      } catch {
        finish(false);
      }
    });
  }
}

module.exports = { OllamaBrain };
