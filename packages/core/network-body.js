// NetworkBodyAdapter -- proxy for a body living in another process.
//
// Built automatically by Space.addBody when it sees a body declared with
// transport="http". The developer usually does NOT instantiate this directly;
// a plain BodyAdapter subclass with static transport="http" + static port
// is enough. Space handles the wrap.
//
// Remote body contract (Python, Go, Rust, whatever):
//   GET  /health    -> { ok: true }
//   GET  /state     -> { data: {...}, pending_events: [...], updated_at }
//   GET  /events    -> { events: [{type, payload, priority}] }  (drains)
//   POST /tool      -> request { name, parameters }, reply is tool result
//   GET  /discover  -> { tools: { toolName: { description, parameters } } }
//
// tick() polls /state and /events at a configurable interval (not every
// 60Hz frame). invokeTool POSTs to /tool. Discovery fetches /discover once.

const http = require("node:http");
const { BodyAdapter } = require("./body-adapter");

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HTTP_TIMEOUT_MS = 1500;

class NetworkBodyAdapter extends BodyAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.name             remote body name
   * @param {number} opts.port             remote body HTTP port
   * @param {string} [opts.host]           default "localhost"
   * @param {object} [opts.tools]          tool defs (if known statically; otherwise discovered)
   * @param {number} [opts.pollIntervalMs] default 250
   * @param {number} [opts.timeoutMs]      default 1500
   */
  constructor(opts) {
    if (!opts || !opts.name) throw new Error("NetworkBodyAdapter: name required");
    if (!opts.port) throw new Error("NetworkBodyAdapter: port required");

    super({ name: opts.name, transport: "http", host: opts.host || "localhost", port: opts.port });

    this._tools = opts.tools || {};
    this.pollIntervalMs = opts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS;
    this._lastPollAt = 0;
    this._alive = true;
    this._discoveryDone = Object.keys(this._tools).length > 0;
    this.stats.httpCalls = 0;
    this.stats.httpErrors = 0;
    this.stats.pollsOk = 0;
    this.stats.pollsFailed = 0;
  }

  getToolDefinitions() { return this._tools; }

  /**
   * Fetch tool schema from GET /discover and register locally.
   * Returns the discovered tools map.
   */
  async discoverTools() {
    const raw = await this._get("/discover");
    const parsed = this._safeJson(raw);
    if (parsed && parsed.tools && typeof parsed.tools === "object") {
      this._tools = parsed.tools;
      this._discoveryDone = true;
      // Re-publish the tool registry in the attached Space if available.
      if (this.space && typeof this.space._registerAdapterTools === "function") {
        this.space._registerAdapterTools(this);
      }
    }
    return this._tools;
  }

  /**
   * Tick polls /state + /events at pollIntervalMs, not per-frame.
   * First poll always happens.
   */
  async tick() {
    await super.tick();
    const now = Date.now();
    if (now - this._lastPollAt < this.pollIntervalMs) return;
    this._lastPollAt = now;

    // state
    try {
      const raw = await this._get("/state");
      const parsed = this._safeJson(raw);
      if (parsed) {
        if (parsed.data && typeof parsed.data === "object") {
          this.setState(parsed.data);
        } else if (typeof parsed === "object") {
          // Accept a flat body snapshot too.
          const { pending_events, events, ...rest } = parsed;
          if (Object.keys(rest).length > 0) this.setState(rest);
        }
      }
      this._alive = true;
      this.stats.pollsOk++;
    } catch {
      this._alive = false;
      this.stats.pollsFailed++;
    }

    // events -- drain
    try {
      const raw = await this._get("/events");
      const parsed = this._safeJson(raw);
      const evts = parsed && Array.isArray(parsed.events) ? parsed.events : [];
      for (const e of evts) {
        if (!e || typeof e !== "object") continue;
        this.emit(e.type || "event", e.payload || {}, e.priority || "NORMAL");
      }
    } catch {
      // events are best-effort
    }
  }

  /**
   * POST /tool {name, parameters}.
   */
  async invokeTool(toolName, parameters = {}) {
    if (this._discoveryDone && !this._tools[toolName]) {
      throw new Error(`${this.name}: unknown tool "${toolName}"`);
    }
    this.stats.toolCalls++;

    const body = JSON.stringify({ name: toolName, parameters, ts: Date.now() });
    let raw;
    try {
      raw = await this._post("/tool", body);
    } catch (e) {
      this.stats.toolErrors++;
      throw new Error(`${this.name}: remote tool call failed: ${e.message}`);
    }
    return this._safeJson(raw) ?? { ok: true };
  }

  /**
   * Best-effort health check. Returns boolean.
   */
  async health() {
    try {
      const raw = await this._get("/health");
      const parsed = this._safeJson(raw);
      return !!(parsed && (parsed.ok === true || parsed.status === "ok"));
    } catch {
      return false;
    }
  }

  // -- HTTP helpers --

  _get(path) {
    this.stats.httpCalls++;
    return new Promise((resolve, reject) => {
      const req = http.request({
        method: "GET",
        hostname: this.host,
        port: this.port,
        path,
        timeout: this.timeoutMs,
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            this.stats.httpErrors++;
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          resolve(data);
        });
      });
      req.on("error", (e) => { this.stats.httpErrors++; reject(e); });
      req.on("timeout", () => { req.destroy(); this.stats.httpErrors++; reject(new Error("timeout")); });
      req.end();
    });
  }

  _post(path, body) {
    this.stats.httpCalls++;
    return new Promise((resolve, reject) => {
      const req = http.request({
        method: "POST",
        hostname: this.host,
        port: this.port,
        path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: this.timeoutMs,
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            this.stats.httpErrors++;
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          resolve(data);
        });
      });
      req.on("error", (e) => { this.stats.httpErrors++; reject(e); });
      req.on("timeout", () => { req.destroy(); this.stats.httpErrors++; reject(new Error("timeout")); });
      req.write(body);
      req.end();
    });
  }

  _safeJson(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
}

module.exports = { NetworkBodyAdapter };
