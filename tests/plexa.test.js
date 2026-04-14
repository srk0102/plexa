const { describe, test } = require("node:test");
const assert = require("node:assert");

const {
  Space,
  BodyAdapter,
  Brain,
  Translator,
  Aggregator,
  PRIORITY,
} = require("..");
const { OllamaBrain } = require("../packages/bridges/ollama");

// -- Helpers --

class FakeBrain extends Brain {
  constructor(response) { super({ model: "fake" }); this._response = response; }
  async _rawCall() {
    return typeof this._response === "string"
      ? this._response
      : JSON.stringify(this._response);
  }
}

class TestBody extends BodyAdapter {
  static tools = {
    say: {
      description: "say something",
      parameters: {
        msg: { type: "string", required: true },
      },
    },
    count: {
      description: "increment counter",
      parameters: {
        by: { type: "number", min: 0, max: 100 },
      },
    },
    ping: {
      description: "no args",
      parameters: {},
    },
  };
  constructor(name = "test_body") {
    super({ name });
    this.counter = 0;
    this.lastSaid = null;
    this.tickCount = 0;
  }
  async say({ msg }) { this.lastSaid = msg; return { said: msg }; }
  async count({ by = 1 }) { this.counter += by; return this.counter; }
  async ping() { return "pong"; }
  async tick() { await super.tick(); this.tickCount++; }
}

class EmptyBody extends BodyAdapter {
  static tools = {};
  constructor() { super({ name: "empty" }); }
}

// ============================================================
// Space
// ============================================================

describe("Space lifecycle", () => {
  test("throws if no bodies registered", async () => {
    const s = new Space("t");
    s.setBrain(new FakeBrain({ target_body: "x", tool: "y" }));
    await assert.rejects(() => s.run(), { message: /no bodies/ });
  });

  test("throws if no brain registered", async () => {
    const s = new Space("t");
    s.addBody(new TestBody());
    await assert.rejects(() => s.run(), { message: /no brain/ });
  });

  test("addBody rejects duplicates", () => {
    const s = new Space("t");
    s.addBody(new TestBody("a"));
    assert.throws(() => s.addBody(new TestBody("a")), { message: /already registered/ });
  });

  test("addBody rejects nameless", () => {
    const s = new Space("t");
    assert.throws(() => s.addBody({}), { message: /must have a name/ });
  });

  test("setBrain requires invoke()", () => {
    const s = new Space("t");
    assert.throws(() => s.setBrain({}), { message: /must have invoke/ });
  });

  test("addBody registers tools", () => {
    const s = new Space("t");
    s.addBody(new TestBody("a"));
    const tools = s.getTools();
    assert.strictEqual(tools.length, 3);
    assert.ok(tools.some(t => t.fqn === "a.say"));
    assert.ok(tools.some(t => t.fqn === "a.count"));
    assert.ok(tools.some(t => t.fqn === "a.ping"));
  });

  test("tool registry combines bodies", () => {
    const s = new Space("t");
    s.addBody(new TestBody("a"));
    s.addBody(new TestBody("b"));
    assert.strictEqual(s.getTools().length, 6);
  });

  test("run calls onConfigure then onActivate on all bodies", async () => {
    const order = [];
    class OrderBody extends TestBody {
      async onConfigure() { order.push(`${this.name}:config`); await super.onConfigure(); }
      async onActivate() { order.push(`${this.name}:activate`); await super.onActivate(); }
    }
    const s = new Space("t", { tickHz: 10, brainIntervalMs: 99999 });
    s.addBody(new OrderBody("a"));
    s.addBody(new OrderBody("b"));
    s.setBrain(new FakeBrain({ target_body: "a", tool: "ping" }));
    await s.run();
    await s.stop();
    assert.deepStrictEqual(order.slice(0, 4), ["a:config", "b:config", "a:activate", "b:activate"]);
  });

  test("stop triggers onEmergencyStop", async () => {
    let stopped = 0;
    class StopBody extends TestBody {
      async onEmergencyStop() { stopped++; await super.onEmergencyStop(); }
    }
    const s = new Space("t", { tickHz: 10, brainIntervalMs: 99999 });
    s.addBody(new StopBody("a"));
    s.setBrain(new FakeBrain({ target_body: "a", tool: "ping" }));
    await s.run();
    await s.stop();
    assert.strictEqual(stopped, 1);
  });
});

// ============================================================
// Reactor: tick() + tool dispatch
// ============================================================

describe("Space reactor", () => {
  test("calls body.tick() every reactor tick", async () => {
    const body = new TestBody("a");
    const s = new Space("t", { tickHz: 60, brainIntervalMs: 99999 });
    s.addBody(body);
    s.setBrain(new FakeBrain({ target_body: "a", tool: "ping" }));
    await s.run();
    await new Promise(r => setTimeout(r, 250));
    await s.stop();
    assert.ok(body.tickCount > 5, `tickCount=${body.tickCount} should exceed 5`);
  });

  test("dispatches tool via direct method call", async () => {
    const body = new TestBody("a");
    const s = new Space("t", { tickHz: 120, brainIntervalMs: 50, aggregateEveryTicks: 5 });
    s.addBody(body);
    s.setBrain(new FakeBrain({ target_body: "a", tool: "say", parameters: { msg: "hi" } }));
    await s.run();
    await new Promise(r => setTimeout(r, 500));
    await s.stop();
    assert.strictEqual(body.lastSaid, "hi");
  });

  test("tool call increments tools dispatched stat", async () => {
    const body = new TestBody("a");
    const s = new Space("t", { tickHz: 120, brainIntervalMs: 50, aggregateEveryTicks: 5 });
    s.addBody(body);
    s.setBrain(new FakeBrain({ target_body: "a", tool: "ping" }));
    await s.run();
    await new Promise(r => setTimeout(r, 300));
    await s.stop();
    assert.ok(s.getStats().toolsDispatched >= 1);
  });

  test("tick errors increment tickErrors stat", async () => {
    class CrashBody extends TestBody {
      async tick() { throw new Error("boom"); }
    }
    const body = new CrashBody("a");
    const s = new Space("t", { tickHz: 60, brainIntervalMs: 99999 });
    s.addBody(body);
    s.setBrain(new FakeBrain({ target_body: "a", tool: "ping" }));
    await s.run();
    await new Promise(r => setTimeout(r, 200));
    await s.stop();
    assert.ok(s.getStats().tickErrors > 0);
  });
});

// ============================================================
// BodyAdapter
// ============================================================

describe("BodyAdapter tools", () => {
  test("invokeTool calls the method", async () => {
    const b = new TestBody();
    const r = await b.invokeTool("say", { msg: "hello" });
    assert.strictEqual(r.said, "hello");
    assert.strictEqual(b.lastSaid, "hello");
  });

  test("invokeTool throws on unknown tool", async () => {
    const b = new TestBody();
    await assert.rejects(() => b.invokeTool("nope"), { message: /unknown tool/ });
  });

  test("invokeTool throws if declared but no method", async () => {
    class BrokenBody extends BodyAdapter {
      static tools = { ghost: { description: "no impl" } };
      constructor() { super({ name: "broken" }); }
    }
    const b = new BrokenBody();
    await assert.rejects(() => b.invokeTool("ghost"), { message: /no method/ });
  });

  test("invokeTool counts call and error stats", async () => {
    class FailBody extends TestBody {
      async say() { throw new Error("nope"); }
    }
    const b = new FailBody();
    try { await b.invokeTool("say", { msg: "x" }); } catch {}
    assert.strictEqual(b.stats.toolCalls, 1);
    assert.strictEqual(b.stats.toolErrors, 1);
  });

  test("getToolDefinitions reflects static tools", () => {
    const b = new TestBody();
    const defs = b.getToolDefinitions();
    assert.ok(defs.say);
    assert.ok(defs.count);
    assert.ok(defs.ping);
  });
});

describe("BodyAdapter modes", () => {
  test("default mode is standalone", () => {
    assert.strictEqual(new TestBody().mode, "standalone");
  });

  test("attaching to Space flips to managed", () => {
    const s = new Space("t");
    const b = new TestBody();
    s.addBody(b);
    assert.strictEqual(b.mode, "managed");
  });

  test("detach reverts to standalone", () => {
    const s = new Space("t");
    const b = new TestBody();
    s.addBody(b);
    b._detachSpace();
    assert.strictEqual(b.mode, "standalone");
  });

  test("cannot attach to two Spaces", () => {
    const s1 = new Space("s1");
    const s2 = new Space("s2");
    const b = new TestBody();
    s1.addBody(b);
    assert.throws(() => s2.addBody(b), { message: /already attached/ });
  });

  test("snapshot includes mode", () => {
    const b = new TestBody();
    assert.strictEqual(b.snapshot().mode, "standalone");
  });

  test("invalid mode throws", () => {
    const b = new TestBody();
    assert.throws(() => b._setMode("rogue"), { message: /invalid mode/ });
  });
});

describe("BodyAdapter events", () => {
  test("emit defaults to NORMAL", () => {
    const b = new TestBody();
    b.emit("x");
    assert.strictEqual(b.snapshot().pending_events[0].priority, "NORMAL");
  });

  test("emit accepts CRITICAL", () => {
    const b = new TestBody();
    b.emit("collision", {}, "CRITICAL");
    assert.strictEqual(b.snapshot().pending_events[0].priority, "CRITICAL");
  });

  test("invalid priority falls back to NORMAL", () => {
    const b = new TestBody();
    b.emit("x", {}, "WHATEVER");
    assert.strictEqual(b.snapshot().pending_events[0].priority, "NORMAL");
  });

  test("queue overflow keeps CRITICAL", () => {
    const b = new TestBody();
    b.emit("critical_1", {}, "CRITICAL");
    for (let i = 0; i < 30; i++) b.emit(`low_${i}`, {}, "LOW");
    const events = b.snapshot().pending_events;
    assert.ok(events.some(e => e.type === "critical_1" && e.priority === "CRITICAL"));
  });

  test("clearPendingEvents drains queue", () => {
    const b = new TestBody();
    b.emit("x");
    b.clearPendingEvents();
    assert.strictEqual(b.snapshot().pending_events.length, 0);
  });

  test("emit pushes event up to Space", () => {
    const s = new Space("t");
    const b = new TestBody();
    s.addBody(b);
    let received = null;
    s.on("body_event", (e) => { received = e; });
    b.emit("ping", { foo: 1 }, "HIGH");
    assert.strictEqual(received.body, "test_body");
    assert.strictEqual(received.type, "ping");
    assert.strictEqual(received.priority, "HIGH");
    assert.deepStrictEqual(received.payload, { foo: 1 });
  });
});

describe("PRIORITY export", () => {
  test("exports priority constants", () => {
    assert.strictEqual(PRIORITY.CRITICAL, 0);
    assert.strictEqual(PRIORITY.HIGH, 1);
    assert.strictEqual(PRIORITY.NORMAL, 2);
    assert.strictEqual(PRIORITY.LOW, 3);
  });
});

// ============================================================
// Brain
// ============================================================

describe("Brain", () => {
  test("_rawCall throws if not implemented", async () => {
    await assert.rejects(() => new Brain()._rawCall(""), { message: /must be implemented/ });
  });

  test("invoke parses valid JSON tool call", async () => {
    const b = new FakeBrain({ target_body: "a", tool: "say", parameters: { msg: "hi" } });
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.target_body, "a");
    assert.strictEqual(intent.tool, "say");
    assert.deepStrictEqual(intent.parameters, { msg: "hi" });
  });

  test("invoke accepts 'action' as legacy alias for 'tool'", async () => {
    const b = new FakeBrain({ target_body: "a", action: "halt" });
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.tool, "halt");
  });

  test("invoke returns null for invalid JSON", async () => {
    const b = new FakeBrain("not json");
    assert.strictEqual(await b.invoke({ bodies: {} }), null);
  });

  test("invoke returns null for missing required fields", async () => {
    const b = new FakeBrain({ tool: "halt" });
    assert.strictEqual(await b.invoke({ bodies: {} }), null);
  });

  test("invoke extracts JSON from surrounding text", async () => {
    const b = new FakeBrain('thinking... {"target_body":"a","tool":"ping"} done');
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.target_body, "a");
  });

  test("invoke clamps priority 1-5", async () => {
    const b = new FakeBrain({ target_body: "a", tool: "p", priority: 99 });
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.priority, 5);
  });

  test("buildPrompt includes tool definitions", () => {
    const b = new Brain();
    const p = b.buildPrompt({
      bodies: {
        cartpole: {
          status: "active",
          tools: {
            apply_force: { description: "push", parameters: { direction: {} } },
          },
        },
      },
      active_goal: "balance",
    });
    assert.ok(p.includes("cartpole"));
    assert.ok(p.includes("apply_force"));
    assert.ok(p.includes("push"));
    assert.ok(p.includes("balance"));
  });

  test("stats increment on call", async () => {
    const b = new FakeBrain({ target_body: "a", tool: "p" });
    await b.invoke({ bodies: {} });
    assert.strictEqual(b.callCount, 1);
  });
});

// ============================================================
// OllamaBrain
// ============================================================

describe("OllamaBrain", () => {
  test("constructor defaults", () => {
    const b = new OllamaBrain();
    assert.strictEqual(b.model, "llama3.2");
    assert.strictEqual(b.host, "http://localhost:11434");
  });

  test("isAvailable returns false for unreachable host", async () => {
    assert.strictEqual(await OllamaBrain.isAvailable("http://localhost:19999"), false);
  });

  test("isAvailable never throws on invalid host", async () => {
    await OllamaBrain.isAvailable("http://not-real-9999.invalid");
    assert.ok(true);
  });
});

// ============================================================
// Translator
// ============================================================

describe("Translator", () => {
  function setup() {
    const t = new Translator();
    const bodies = new Map();
    bodies.set("arm", new TestBody("arm"));
    return { t, bodies };
  }

  test("translates valid tool call", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm", tool: "say", parameters: { msg: "hello" } }, bodies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.command.tool, "say");
    assert.deepStrictEqual(r.command.parameters, { msg: "hello" });
  });

  test("accepts 'action' legacy alias", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm", action: "ping" }, bodies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.command.tool, "ping");
  });

  test("rejects invalid_intent", () => {
    const { t, bodies } = setup();
    assert.strictEqual(t.translate(null, bodies).reason, "invalid_intent");
  });

  test("rejects missing_target_body", () => {
    const { t, bodies } = setup();
    assert.strictEqual(t.translate({ tool: "say" }, bodies).reason, "missing_target_body");
  });

  test("rejects missing_tool", () => {
    const { t, bodies } = setup();
    assert.strictEqual(t.translate({ target_body: "arm" }, bodies).reason, "missing_tool");
  });

  test("rejects unknown_body", () => {
    const { t, bodies } = setup();
    assert.strictEqual(t.translate({ target_body: "leg", tool: "say" }, bodies).reason, "unknown_body");
  });

  test("rejects unknown_tool", () => {
    const { t, bodies } = setup();
    assert.strictEqual(t.translate({ target_body: "arm", tool: "jump" }, bodies).reason, "unknown_tool");
  });

  test("rejects invalid_parameters (missing required)", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm", tool: "say", parameters: {} }, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "invalid_parameters");
  });

  test("rejects invalid_parameters (wrong type)", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm", tool: "say", parameters: { msg: 123 } }, bodies);
    assert.strictEqual(r.reason, "invalid_parameters");
  });

  test("rejects invalid_parameters (out of range)", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm", tool: "count", parameters: { by: 999 } }, bodies);
    assert.strictEqual(r.reason, "invalid_parameters");
  });

  test("accepts parameters with enum", () => {
    class EnumBody extends BodyAdapter {
      static tools = {
        go: {
          description: "go a direction",
          parameters: { dir: { type: "string", enum: ["n","s","e","w"], required: true } },
        },
      };
      constructor() { super({ name: "enum" }); }
      async go() {}
    }
    const bodies = new Map([["enum", new EnumBody()]]);
    const t = new Translator();
    const good = t.translate({ target_body: "enum", tool: "go", parameters: { dir: "n" } }, bodies);
    assert.strictEqual(good.ok, true);
    const bad = t.translate({ target_body: "enum", tool: "go", parameters: { dir: "nw" } }, bodies);
    assert.strictEqual(bad.reason, "invalid_parameters");
  });

  test("global allowlist blocks tool", () => {
    const t = new Translator({ allowedTools: new Set(["arm.ping"]) });
    const bodies = new Map([["arm", new TestBody("arm")]]);
    const r = t.translate({ target_body: "arm", tool: "say", parameters: { msg: "x" } }, bodies);
    assert.strictEqual(r.reason, "tool_not_allowed");
  });

  test("stats track reasons", () => {
    const { t, bodies } = setup();
    t.translate(null, bodies);
    t.translate({ target_body: "X", tool: "say" }, bodies);
    t.translate({ target_body: "arm", tool: "jump" }, bodies);
    const s = t.getStats();
    assert.strictEqual(s.byReason.invalid_intent, 1);
    assert.strictEqual(s.byReason.unknown_body, 1);
    assert.strictEqual(s.byReason.unknown_tool, 1);
  });
});

// ============================================================
// Aggregator
// ============================================================

describe("Aggregator", () => {
  test("merges state from two bodies", () => {
    const a = new Aggregator();
    const b1 = new TestBody("a"); b1.setState({ pos: { x: 1 } });
    const b2 = new TestBody("b"); b2.setState({ pos: { x: 2 } });
    const out = a.aggregate(new Map([["a", b1], ["b", b2]]));
    assert.strictEqual(out.bodies.a.pos.x, 1);
    assert.strictEqual(out.bodies.b.pos.x, 2);
  });

  test("includes tool definitions in aggregated state", () => {
    const a = new Aggregator();
    const b = new TestBody("a");
    const out = a.aggregate(new Map([["a", b]]));
    assert.ok(out.bodies.a.tools);
    assert.ok(out.bodies.a.tools.say);
    assert.strictEqual(out.bodies.a.tools.say.description, "say something");
  });

  test("omits tools for bodies with none", () => {
    const a = new Aggregator();
    const out = a.aggregate(new Map([["e", new EmptyBody()]]));
    assert.strictEqual(out.bodies.e.tools, undefined);
  });

  test("clears pending events after aggregation", () => {
    const a = new Aggregator();
    const b = new TestBody("a");
    b.emit("x");
    const out1 = a.aggregate(new Map([["a", b]]));
    assert.strictEqual(out1.bodies.a.pending_events.length, 1);
    const out2 = a.aggregate(new Map([["a", b]]));
    assert.strictEqual(out2.bodies.a.pending_events, undefined);
  });

  test("enforces token budget", () => {
    const a = new Aggregator({ tokenBudget: 300 });
    const bodies = new Map();
    for (let i = 0; i < 10; i++) {
      const b = new TestBody(`b${i}`);
      b.setState({ bulk: "x".repeat(500) });
      bodies.set(`b${i}`, b);
    }
    const out = a.aggregate(bodies);
    const size = Math.ceil(JSON.stringify(out).length / 4);
    assert.ok(size <= 300, `expected <= 300 tokens, got ${size}`);
  });

  test("CRITICAL events survive severe budget pressure", () => {
    const a = new Aggregator({ tokenBudget: 200, maxPendingEventsPerBody: 50 });
    const b = new TestBody("a");
    b.emit("emergency", { severity: "high" }, "CRITICAL");
    b.setState({ bulk: "x".repeat(500) });
    for (let i = 0; i < 30; i++) b.emit(`low_${i}`, { j: "z".repeat(30) }, "LOW");
    const out = a.aggregate(new Map([["a", b]]));
    assert.ok(out.bodies.a);
    const events = out.bodies.a.pending_events || [];
    assert.ok(events.some((e) => e.type === "emergency" && e.priority === "CRITICAL"));
  });

  test("LOW dropped before NORMAL under budget pressure", () => {
    // Keep event count below the body's 20-event cap so both priorities reach the aggregator.
    const a = new Aggregator({ tokenBudget: 150, maxPendingEventsPerBody: 50 });
    const b = new TestBody("a");
    for (let i = 0; i < 8; i++) b.emit(`low_${i}`, {}, "LOW");
    for (let i = 0; i < 8; i++) b.emit(`normal_${i}`, {}, "NORMAL");
    a.aggregate(new Map([["a", b]]));
    const s = a.getStats();
    // LOW must be dropped at least as many times as NORMAL.
    assert.ok(
      s.droppedByPriority.LOW >= s.droppedByPriority.NORMAL,
      `LOW=${s.droppedByPriority.LOW} NORMAL=${s.droppedByPriority.NORMAL}`
    );
  });

  test("flags stale state", async () => {
    const a = new Aggregator({ staleMs: 50 });
    const b = new TestBody("slow");
    b.setState({ v: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const out = a.aggregate(new Map([["slow", b]]));
    assert.strictEqual(out.bodies.slow.stale, true);
  });

  test("compacts floats to 3 decimals", () => {
    const a = new Aggregator();
    const b = new TestBody("a");
    b.setState({ pos: 3.14159265 });
    const out = a.aggregate(new Map([["a", b]]));
    assert.strictEqual(out.bodies.a.pos, 3.142);
  });

  test("truncates long strings", () => {
    const a = new Aggregator();
    const b = new TestBody("a");
    b.setState({ note: "z".repeat(500) });
    const out = a.aggregate(new Map([["a", b]]));
    assert.ok(out.bodies.a.note.length <= 120);
  });

  test("priority stats track drops", () => {
    const a = new Aggregator({ tokenBudget: 80, maxPendingEventsPerBody: 50 });
    const b = new TestBody("a");
    for (let i = 0; i < 20; i++) b.emit(`low_${i}`, {}, "LOW");
    for (let i = 0; i < 20; i++) b.emit(`normal_${i}`, {}, "NORMAL");
    a.aggregate(new Map([["a", b]]));
    const s = a.getStats();
    const total = s.droppedByPriority.LOW + s.droppedByPriority.NORMAL + s.droppedByPriority.HIGH;
    assert.ok(total > 0);
  });

  test("CRITICAL never counted in drops", () => {
    const a = new Aggregator({ tokenBudget: 80, maxPendingEventsPerBody: 50 });
    const b = new TestBody("a");
    b.emit("alert", {}, "CRITICAL");
    for (let i = 0; i < 30; i++) b.emit(`low_${i}`, {}, "LOW");
    a.aggregate(new Map([["a", b]]));
    assert.strictEqual(a.getStats().droppedByPriority.CRITICAL, 0);
  });
});
