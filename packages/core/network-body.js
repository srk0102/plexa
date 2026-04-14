// NetworkBodyAdapter -- proxy for a body that lives in another process.
//
// Built automatically by Space when it sees a body declared with
// transport="http". The developer never instantiates this directly.
//
// Behavior:
//   tick(): polls the remote body for state and events
//   invokeTool(): POSTs the tool call to the remote body
//   The remote body's process owns the physics loop.

const http = require("node:http");
const { BodyAdapter } = require("./body-adapter");

class NetworkBodyAdapter extends BodyAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.name      remote body name
   * @param {object} opts.tools     tool defs declared by the remote body
   * @param {string} [opts.host]    default localhost
   * @param {number} opts.port      remote body's HTTP port
   */
  constructor(opts) {
    if (!opts || !opts.name) throw new Error("NetworkBodyAdapter: name required");
    if (!opts.port) throw new Error("NetworkBodyAdapter: port required");

    super({ name: opts.name, transport: "http", host: opts.host || "localhost", port: opts.port });

    // Dynamic per-instance tool list
    this._tools = opts.tools || {};
  }

  // Override discovery so Plexa uses the dynamic tool set
  getToolDefinitions() { return this._tools; }

  /**
   * POST the tool call to the remote body.
   */
  async invokeTool(toolName, parameters = {}) {
    if (!this._tools[toolName]) {
      throw new Error(`${this.name}: unknown tool "${toolName}"`);
    }
    this.stats.toolCalls++;

    const body = JSON.stringify({
      type: "tool_call",
      tool: toolName,
      parameters,
      ts: Date.now(),
    });

    return new Promise((resolve) => {
      const req = http.request({
        method: "POST",
        hostname: this.host,
        port: this.port,
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 1000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try { resolve(JSON.parse(data || "{}")); }
          catch { resolve({ ok: true }); }
        });
      });
      req.on("error", (e) => { this.stats.toolErrors++; resolve({ ok: false, error: e.message }); });
      req.on("timeout", () => { req.destroy(); this.stats.toolErrors++; resolve({ ok: false, error: "timeout" }); });
      req.write(body);
      req.end();
    });
  }

  // tick() can be a no-op or poll. For now: state arrives via /emit
  // pushed by the remote body to Space's HTTP receiver (set up in NetworkAdapter
  // bootstrap if Plexa needs it). For minimal flow, tick is a no-op.
  async tick() { this.stats.ticks++; }
}

module.exports = { NetworkBodyAdapter };
