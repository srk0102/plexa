// Introspection HTTP server for the Plexa CLI.
//
// Opt-in. A running Space calls attachIntrospection(space) (or passes
// {introspect: true} to the constructor) and this module exposes:
//
//   GET /plexa/status   compact health snapshot
//   GET /plexa/bodies   full body list with tools
//   GET /plexa/logs     cursor-based log tail
//
// Zero external deps. Uses node:http only.

const http = require("node:http");

const LOG_CAP = 500;

function attachIntrospection(space, opts = {}) {
  if (space._introspection) return space._introspection;

  const port = opts.port || 4747;
  const log = [];
  const startedAt = Date.now();

  function record(entry) {
    log.push({ ts: Date.now(), ...entry });
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  }

  // Wire event taps
  space.on("body_event", (e) => record({
    kind: "event",
    body: e.body,
    type: e.type,
    priority: e.priority,
    payload: e.payload,
  }));

  space.on("tool_dispatched", (e) => record({
    kind: "tool",
    body: e.body,
    tool: e.tool,
    parameters: e.parameters,
    durationMs: e.durationMs,
  }));

  space.on("body_decision", (e) => record({
    kind: "decision",
    body: e.body,
    decision: e.decision,
    meta: e.meta,
  }));

  function serializeBodies() {
    const out = [];
    for (const [name, body] of space.bodies) {
      const snap = typeof body.snapshot === "function" ? body.snapshot() : {};
      const tools = typeof body.getToolDefinitions === "function"
        ? Object.keys(body.getToolDefinitions())
        : [];
      out.push({
        name,
        transport: body.transport || "inprocess",
        port: body.port || null,
        host: body.host || null,
        mode: body.mode,
        status: snap.status,
        tools,
      });
    }
    return out;
  }

  function statusPayload() {
    const s = space.getStats ? space.getStats() : {};
    const bodies = serializeBodies();
    return {
      name: space.name,
      running: !!space._running,
      tickHz: space.tickHz,
      bodies,
      brain: space.brain ? {
        provider: space.brain.constructor ? space.brain.constructor.name : "Brain",
        model: space.brain.model || null,
      } : null,
      stats: {
        brainCalls: s.brainCalls ?? 0,
        brainErrors: s.brainErrors ?? 0,
        toolsDispatched: s.toolsDispatched ?? 0,
        toolsRejected: s.toolsRejected ?? 0,
        bodyDecisions: s.bodyDecisions ?? 0,
        aggregations: s.aggregations ?? 0,
        tick: s.tick ?? 0,
        uptimeMs: Date.now() - startedAt,
        avgBrainMs: s.brain && s.brain.avgCallMs ? s.brain.avgCallMs : 0,
      },
    };
  }

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    if (req.method !== "GET") {
      res.writeHead(405); return res.end(JSON.stringify({ error: "method not allowed" }));
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/plexa/status") {
      res.writeHead(200);
      return res.end(JSON.stringify(statusPayload()));
    }

    if (url.pathname === "/plexa/bodies") {
      res.writeHead(200);
      return res.end(JSON.stringify({ bodies: serializeBodies() }));
    }

    if (url.pathname === "/plexa/logs") {
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      const slice = log.slice(offset);
      res.writeHead(200);
      return res.end(JSON.stringify({ lines: slice, offset: log.length }));
    }

    if (url.pathname === "/plexa/health") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, version: "0.3.0" }));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port);

  const handle = {
    server,
    port,
    stop() { server.close(); },
  };

  space._introspection = handle;
  return handle;
}

module.exports = { attachIntrospection };
