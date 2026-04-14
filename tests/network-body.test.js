const { describe, test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { Space, BodyAdapter, Brain } = require("..");
const { NetworkBodyAdapter } = require("../packages/core/network-body");

class FakeBrain extends Brain {
  async _rawCall() { return "{}"; }
}

// -- Mock remote body server ------------------------------------------------

function makeMockServer(opts = {}) {
  const state = {
    discovered: 0,
    stateCalls: 0,
    eventsCalls: 0,
    healthCalls: 0,
    toolCalls: [],
    lastTool: null,
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/discover") {
      state.discovered++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        tools: opts.tools || {
          apply_force: {
            description: "push",
            parameters: { direction: { type: "string", enum: ["left", "right"], required: true } },
          },
          hold: { description: "no-op", parameters: {} },
        },
      }));
    }
    if (req.method === "GET" && req.url === "/health") {
      state.healthCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "GET" && req.url === "/state") {
      state.stateCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: { angle: 0.12, cart_pos: 0.03 } }));
    }
    if (req.method === "GET" && req.url === "/events") {
      state.eventsCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        events: state.eventsCalls === 1
          ? [{ type: "pole_warning", payload: { angle: 0.5 }, priority: "HIGH" }]
          : [],
      }));
    }
    if (req.method === "POST" && req.url === "/tool") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          state.toolCalls.push(parsed);
          state.lastTool = parsed;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, applied: parsed.parameters }));
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ server, port, state });
    });
  });
}

// ============================================================
// NetworkBodyAdapter directly
// ============================================================

describe("NetworkBodyAdapter direct", () => {
  test("invokeTool POSTs to /tool and returns response", async () => {
    const { server, port, state } = await makeMockServer();
    try {
      const body = new NetworkBodyAdapter({
        name: "cart", port, tools: { apply_force: { description: "x", parameters: {} } },
      });
      const result = await body.invokeTool("apply_force", { direction: "left" });
      assert.ok(result);
      assert.strictEqual(state.toolCalls.length, 1);
      assert.strictEqual(state.toolCalls[0].name, "apply_force");
      assert.deepStrictEqual(state.toolCalls[0].parameters, { direction: "left" });
    } finally {
      server.close();
    }
  });

  test("tick() polls /state and /events", async () => {
    const { server, port, state } = await makeMockServer();
    try {
      const body = new NetworkBodyAdapter({
        name: "cart", port,
        tools: { apply_force: { description: "x", parameters: {} } },
        pollIntervalMs: 0,
      });
      await body.tick();
      assert.strictEqual(state.stateCalls, 1);
      assert.strictEqual(state.eventsCalls, 1);
      const snap = body.snapshot();
      assert.strictEqual(snap.angle, 0.12);
      assert.ok(Array.isArray(snap.pending_events));
      assert.strictEqual(snap.pending_events[0].type, "pole_warning");
    } finally {
      server.close();
    }
  });

  test("discoverTools fetches /discover and populates tools", async () => {
    const { server, port, state } = await makeMockServer();
    try {
      const body = new NetworkBodyAdapter({ name: "cart", port });
      assert.strictEqual(Object.keys(body.getToolDefinitions()).length, 0);
      const tools = await body.discoverTools();
      assert.ok(tools.apply_force);
      assert.ok(tools.hold);
      assert.strictEqual(state.discovered, 1);
    } finally {
      server.close();
    }
  });

  test("health() returns true when remote replies ok", async () => {
    const { server, port } = await makeMockServer();
    try {
      const body = new NetworkBodyAdapter({ name: "cart", port, tools: {} });
      const ok = await body.health();
      assert.strictEqual(ok, true);
    } finally {
      server.close();
    }
  });

  test("unknown tool rejected after discovery", async () => {
    const { server, port } = await makeMockServer();
    try {
      const body = new NetworkBodyAdapter({ name: "cart", port });
      await body.discoverTools();
      await assert.rejects(() => body.invokeTool("does_not_exist"), /unknown tool/);
    } finally {
      server.close();
    }
  });
});

// ============================================================
// Space auto-wrap
// ============================================================

describe("Space auto-wrap for transport=http", () => {
  test("plain BodyAdapter with transport=http auto-wrapped as NetworkBodyAdapter", async () => {
    const { server, port } = await makeMockServer();
    try {
      class RemoteCart extends BodyAdapter {
        static bodyName = "cart";
        static transport = "http";
        static tools = {
          apply_force: {
            description: "push",
            parameters: { direction: { type: "string", required: true } },
          },
        };
      }

      const s = new Space("t", { tickHz: 100 });
      s.addBody(new RemoteCart({ port }));
      s.setBrain(new FakeBrain());
      const body = s.bodies.get("cart");
      assert.ok(body instanceof NetworkBodyAdapter, "body should be auto-wrapped");
      assert.strictEqual(body.port, port);
    } finally {
      server.close();
    }
  });

  test("Space auto-runs /discover for network body with no static tools", async () => {
    const { server, port, state } = await makeMockServer();
    try {
      class UnknownRemote extends BodyAdapter {
        static bodyName = "cart";
        static transport = "http";
        // no static tools -> should trigger discovery
      }
      const s = new Space("t");
      s.addBody(new UnknownRemote({ port }));
      s.setBrain(new FakeBrain());
      await s.ready();
      assert.strictEqual(state.discovered, 1);
      const body = s.bodies.get("cart");
      assert.ok(Object.keys(body.getToolDefinitions()).includes("apply_force"));
    } finally {
      server.close();
    }
  });

  test("NetworkBodyAdapter passed directly is not double-wrapped", async () => {
    const { server, port } = await makeMockServer();
    try {
      const s = new Space("t");
      const body = new NetworkBodyAdapter({
        name: "cart", port, tools: { apply_force: { description: "x", parameters: {} } },
      });
      s.addBody(body);
      s.setBrain(new FakeBrain());
      assert.strictEqual(s.bodies.get("cart"), body);
    } finally {
      server.close();
    }
  });

  test("tool call reaches remote mock server end-to-end", async () => {
    const { server, port, state } = await makeMockServer();
    try {
      class RemoteCart extends BodyAdapter {
        static bodyName = "cart";
        static transport = "http";
        static tools = {
          apply_force: {
            description: "push",
            parameters: { direction: { type: "string", required: true } },
          },
        };
      }
      const s = new Space("t");
      s.addBody(new RemoteCart({ port }));
      s.setBrain(new FakeBrain());

      await s._dispatchIntent({
        target_body: "cart",
        tool: "apply_force",
        parameters: { direction: "right" },
      });
      // Allow the async POST to round-trip.
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(state.toolCalls.length >= 1, "remote server should have received the POST");
      assert.strictEqual(state.toolCalls[0].parameters.direction, "right");
    } finally {
      server.close();
    }
  });
});
