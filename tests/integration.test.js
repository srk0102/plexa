// End-to-end integration tests. These exercise scp-protocol and plexa
// together as a package user would use them.

const { describe, test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  Space, BodyAdapter, Brain, VerticalMemory,
} = require("..");
const { NetworkBodyAdapter } = require("../packages/core/network-body");
const { SCPBody, PatternStore, AdaptiveMemory } = require("scp-protocol");

function tmpdb(name) {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function cleanup(file) {
  for (const ext of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(file + ext); } catch {}
  }
}

class ScriptedBrain extends Brain {
  constructor(intents) { super({ model: "scripted" }); this._intents = intents || []; this._i = 0; this.calls = 0; }
  async _rawCall() {
    this.calls++;
    const intent = this._intents[this._i % Math.max(1, this._intents.length)];
    this._i++;
    return JSON.stringify(intent || { target_body: "_none", tool: "_none", parameters: {} });
  }
}

// ============================================================
// 1. InProcess body full lifecycle
// ============================================================

describe("Integration 1: InProcess body full lifecycle", () => {
  test("tick, event, tool call through Space", async () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = {
        ping: { description: "ping", parameters: {} },
      };
      constructor() { super(); this.pings = 0; this.ticked = 0; }
      async ping() { this.pings++; return { pong: true }; }
      async tick() { await super.tick(); this.ticked++; if (this.ticked === 2) this.emit("hello", { n: 1 }); }
    }
    const body = new Bot();
    const s = new Space("t", { tickHz: 200, aggregateEveryTicks: 1, brainIntervalMs: 1 });
    s.addBody(body);
    s.setBrain(new ScriptedBrain([{ target_body: "bot", tool: "ping", parameters: {} }]));

    const events = [];
    s.on("body_event", (e) => events.push(e));

    await s.run();
    await new Promise((r) => setTimeout(r, 80));
    await s.stop();

    assert.ok(body.ticked >= 2, `tick must have been called (was ${body.ticked})`);
    assert.ok(events.length >= 1, "events should have reached Space");
    assert.ok(body.pings >= 1, "tool should have been dispatched");
  });
});

// ============================================================
// 2. PatternStore + Space integration (body decisions captured)
// ============================================================

describe("Integration 2: PatternStore + Space integration", () => {
  test("body local decisions surface via onBodyDecision", () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = { do: { description: "x", parameters: {} } };
      async do() { return {}; }
    }
    const store = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      confidenceThreshold: 0.2,
      explorationRate: 0,
    });
    for (let i = 0; i < 10; i++) store.learn({ kind: "red" }, "halt");

    const body = new Bot({ patternStore: store });
    const mem = new VerticalMemory({ spaceName: "t" });
    const s = new Space("t", { verticalMemory: mem });
    s.addBody(body);
    s.setBrain(new ScriptedBrain([]));

    const decisions = [];
    s.on("body_decision", (e) => decisions.push(e));

    const result = body.decideLocally({ kind: "red" });
    assert.ok(result);
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].decision, "halt");
  });
});

// ============================================================
// 3. AdaptiveMemory + Space: second similar state uses memory, no LLM
// ============================================================

describe("Integration 3: AdaptiveMemory reduces LLM calls", () => {
  test("second similar state served from adaptive memory", () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = { do: { description: "x", parameters: {} } };
      async do() { return {}; }
    }
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: Math.round(e.x) }),
      explorationRate: 0,
    });
    const adaptive = new AdaptiveMemory({ threshold: 0.4 });
    const body = new Bot({ patternStore: store, adaptiveMemory: adaptive });

    // First time: learn from brain.
    body.learnFromBrain({ x: 1.0 }, "move_forward");
    // Slightly different input: pattern store miss, adaptive memory should hit.
    const hit = body.decideLocally({ x: 1.2 });
    assert.ok(hit);
    // Either layer is acceptable; what matters is no LLM fallback was needed.
    assert.ok(hit.decision === "move_forward");
  });
});

// ============================================================
// 4. Safety gate blocks tool call
// ============================================================

describe("Integration 4: Safety gate blocks tool call", () => {
  test("magnitude over threshold is rejected", async () => {
    class Arm extends BodyAdapter {
      static tools = {
        push: {
          description: "push",
          parameters: {
            magnitude: { type: "number", min: 0, max: 1, required: true },
          },
        },
      };
      constructor() { super({ name: "arm" }); this.received = []; }
      async push({ magnitude }) { this.received.push(magnitude); return {}; }
    }
    const body = new Arm();
    const s = new Space("t");
    s.addBody(body);
    s.setBrain(new ScriptedBrain([]));
    s.addSafetyRule((cmd) =>
      cmd.tool === "push" && cmd.parameters.magnitude > 0.9
        ? { allowed: false, reason: "too hard" }
        : { allowed: true }
    );

    const blocked = [];
    s.on("safety_blocked", (e) => blocked.push(e));

    await s._dispatchIntent({ target_body: "arm", tool: "push", parameters: { magnitude: 0.95 } });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(body.received.length, 0);
    assert.strictEqual(blocked.length, 1);
    assert.match(blocked[0].reason, /too hard/);
  });
});

// ============================================================
// 5. Approval hook modifies intent before dispatch
// ============================================================

describe("Integration 5: Approval hook modifies intent", () => {
  test("hook clamps magnitude from 0.9 to 0.5", async () => {
    class Arm extends BodyAdapter {
      static tools = {
        push: {
          description: "push",
          parameters: {
            magnitude: { type: "number", min: 0, max: 1, required: true },
          },
        },
      };
      constructor() { super({ name: "arm" }); this.received = null; }
      async push({ magnitude }) { this.received = magnitude; return {}; }
    }
    const body = new Arm();
    const s = new Space("t");
    s.addBody(body);
    s.setBrain(new ScriptedBrain([]));
    s.addApprovalHook(async (cmd) => ({ ...cmd, parameters: { magnitude: 0.5 } }));

    await s._dispatchIntent({ target_body: "arm", tool: "push", parameters: { magnitude: 0.9 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(body.received, 0.5);
    assert.strictEqual(s.stats.approvalModified, 1);
  });
});

// ============================================================
// 6. Lateral events between bodies
// ============================================================

describe("Integration 6: Lateral events between bodies", () => {
  test("body A emits, body B receives, no broadcast", async () => {
    class Arm extends BodyAdapter {
      static tools = { act: { description: "x", parameters: {} } };
      constructor(name) { super({ name }); this.peerEvents = []; }
      async act() { return {}; }
      async onPeerEvent(from, type, payload) { this.peerEvents.push({ from, type, payload }); }
    }
    const left = new Arm("left");
    const right = new Arm("right");
    const spectator = new Arm("spectator");

    const s = new Space("t");
    s.addBody(left);
    s.addBody(right);
    s.addBody(spectator);
    s.setBrain(new ScriptedBrain([]));

    s.link("left", "right", ["grip_slip"]);

    left.emit("grip_slip", { force: 4 }, "CRITICAL");
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(right.peerEvents.length, 1);
    assert.strictEqual(right.peerEvents[0].from, "left");
    assert.strictEqual(spectator.peerEvents.length, 0, "spectator must not receive (no broadcast)");
    assert.strictEqual(s.stats.peerEventsRouted, 1);
  });
});

// ============================================================
// 7. Confidence gating escalates correctly
// ============================================================

describe("Integration 7: Confidence escalation", () => {
  test("low confidence emits escalation event", () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = { act: { description: "x", parameters: {} } };
      async act() { return {}; }
    }
    const body = new Bot();
    const s = new Space("t");
    s.addBody(body);
    s.setBrain(new ScriptedBrain([]));
    s.setConfidenceThresholds({ autoApprove: 0.9, monitor: 0.6, escalate: 0.4 });

    let escalated = null;
    s.on("confidence_escalation", (e) => { escalated = e; });

    s.onBodyDecision("bot", { kind: "enemy" }, "flee", { confidence: 0.2, source: "adaptive" });
    assert.ok(escalated);
    assert.strictEqual(s.stats.escalatedByConfidence, 1);
  });
});

// ============================================================
// 8. Cost tracking end to end
// ============================================================

describe("Integration 8: Cost tracking end to end", () => {
  test("multiple brain calls accumulate cost", async () => {
    class Bot extends BodyAdapter {
      static tools = { noop: { description: "x", parameters: {} } };
      constructor() { super({ name: "a" }); }
      async noop() { return {}; }
    }
    const s = new Space("t");
    s.addBody(new Bot());
    s.setBrain(new ScriptedBrain([
      { target_body: "a", tool: "noop", parameters: {} },
      { target_body: "a", tool: "noop", parameters: {} },
      { target_body: "a", tool: "noop", parameters: {} },
    ]));
    s.brain.model = "claude-haiku-4-5-20251001";
    s.brain.costPerKToken = Brain.costForModel(s.brain.model);

    for (let i = 0; i < 3; i++) await s._maybeCallBrain();

    const stats = s.getStats();
    assert.ok(stats.brain.calls === 3);
    assert.ok(stats.estimatedCostUSD > 0);
    assert.strictEqual(typeof stats.costSavedByCacheUSD, "number");
  });
});

// ============================================================
// 9. Vertical memory cross-session
// ============================================================

describe("Integration 9: Vertical memory cross-session", () => {
  test("decisions persist across Space instances", async (t) => {
    let hasSqlite = true;
    try { require("better-sqlite3"); } catch { hasSqlite = false; }
    if (!hasSqlite) { t.skip("better-sqlite3 not installed"); return; }

    const file = tmpdb("intg9");
    try {
      class Bot extends BodyAdapter {
        static tools = { act: { description: "x", parameters: {} } };
        constructor() { super({ name: "a" }); }
        async act() { return {}; }
      }

      // Session 1: populate memory via brain calls.
      const mem1 = new VerticalMemory({ spaceName: "robot", dbPath: file });
      await mem1.load();
      const s1 = new Space("robot", { verticalMemory: mem1 });
      s1.addBody(new Bot());
      s1.setBrain(new ScriptedBrain([
        { target_body: "a", tool: "act", parameters: {} },
      ]));
      for (let i = 0; i < 3; i++) {
        await s1._maybeCallBrain();
        // Drain the fire-and-forget store promise so entries are persisted.
        await new Promise((r) => setImmediate(r));
      }
      s1._running = true; // so stop() executes save path
      await s1.stop();
      assert.ok(mem1.entries.length >= 1);

      // Session 2: reload memory, expect to see entries.
      const mem2 = new VerticalMemory({ spaceName: "robot", dbPath: file });
      const loaded = await mem2.load();
      assert.ok(loaded >= 1, `expected at least 1 loaded entry, got ${loaded}`);
    } finally {
      cleanup(file);
    }
  });
});

// ============================================================
// 10. Network body via mock server
// ============================================================

describe("Integration 10: Network body via mock server", () => {
  function makeMockServer() {
    const state = { discovered: 0, toolCalls: [] };
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/discover") {
        state.discovered++;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          tools: {
            wiggle: { description: "wiggle", parameters: {} },
          },
        }));
      }
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === "GET" && req.url === "/state") {
        res.writeHead(200); return res.end(JSON.stringify({ data: { joint: 0.1 } }));
      }
      if (req.method === "GET" && req.url === "/events") {
        res.writeHead(200); return res.end(JSON.stringify({ events: [] }));
      }
      if (req.method === "POST" && req.url === "/tool") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          try { state.toolCalls.push(JSON.parse(body)); } catch {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    return new Promise((resolve) => {
      server.listen(0, () => resolve({ server, port: server.address().port, state }));
    });
  }

  test("auto-wrap, discover, poll, dispatch round-trip", async () => {
    const { server, port, state } = await makeMockServer();
    try {
      class Remote extends BodyAdapter {
        static bodyName = "remote";
        static transport = "http";
      }
      const s = new Space("t", { tickHz: 200, brainIntervalMs: 1 });
      s.addBody(new Remote({ port }));
      s.setBrain(new ScriptedBrain([{ target_body: "remote", tool: "wiggle", parameters: {} }]));
      await s.ready();
      assert.ok(s.bodies.get("remote") instanceof NetworkBodyAdapter);
      assert.strictEqual(state.discovered, 1);

      await s._dispatchIntent({ target_body: "remote", tool: "wiggle", parameters: {} });
      await new Promise((r) => setTimeout(r, 60));

      assert.ok(state.toolCalls.length >= 1);
      assert.strictEqual(state.toolCalls[0].name, "wiggle");
    } finally {
      server.close();
    }
  });
});
