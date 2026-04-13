const { describe, test, after } = require("node:test");
const assert = require("node:assert");

const {
  Space,
  BodyAdapter,
  Brain,
  Translator,
  Aggregator,
  OllamaBrain,
} = require("..");

// -- Helpers --

class FakeTransport {
  constructor() {
    this.sent = [];
    this._handlers = new Map();
  }
  emit(type, data) { this.sent.push({ type, data }); }
  on(type, handler) { this._handlers.set(type, handler); }
  _dispatch(type, data) {
    const h = this._handlers.get(type);
    if (h) h(data);
  }
  async start() {}
  async stop() {}
}

class FakeBrain extends Brain {
  constructor(response) {
    super({ model: "fake" });
    this._response = response;
  }
  async _rawCall() {
    return typeof this._response === "string"
      ? this._response
      : JSON.stringify(this._response);
  }
}

function makeBody(name, opts = {}) {
  return new BodyAdapter({
    name,
    capabilities: opts.capabilities || ["move_to", "halt"],
    transport: opts.transport || new FakeTransport(),
  });
}

// -- Space lifecycle --

describe("Space", () => {
  test("throws if no bodies registered", async () => {
    const s = new Space("test");
    s.setBrain(new FakeBrain({ target_body: "x", action: "y" }));
    await assert.rejects(() => s.run(), { message: /no bodies/ });
  });

  test("throws if no brain registered", async () => {
    const s = new Space("test");
    s.addBody(makeBody("a"));
    await assert.rejects(() => s.run(), { message: /no brain/ });
  });

  test("addBody rejects duplicate names", () => {
    const s = new Space("test");
    s.addBody(makeBody("a"));
    assert.throws(() => s.addBody(makeBody("a")), { message: /already registered/ });
  });

  test("addBody rejects nameless adapters", () => {
    const s = new Space("test");
    assert.throws(() => s.addBody({}), { message: /must have a name/ });
  });

  test("setBrain requires invoke()", () => {
    const s = new Space("test");
    assert.throws(() => s.setBrain({}), { message: /must have invoke/ });
  });

  test("run() calls onConfigure then onActivate on all bodies", async () => {
    const order = [];
    class TestBody extends BodyAdapter {
      async onConfigure() { order.push(`${this.name}:configure`); await super.onConfigure(); }
      async onActivate() { order.push(`${this.name}:activate`); await super.onActivate(); }
    }
    const s = new Space("test", { tickHz: 10 });
    s.addBody(new TestBody({ name: "a", transport: new FakeTransport() }));
    s.addBody(new TestBody({ name: "b", transport: new FakeTransport() }));
    s.setBrain(new FakeBrain({ target_body: "a", action: "halt" }));
    await s.run();
    await s.stop();
    assert.deepStrictEqual(order, ["a:configure", "b:configure", "a:activate", "b:activate"]);
  });

  test("stop() triggers onEmergencyStop", async () => {
    let stopped = 0;
    class TestBody extends BodyAdapter {
      async onEmergencyStop() { stopped++; await super.onEmergencyStop(); }
    }
    const s = new Space("test", { tickHz: 10 });
    s.addBody(new TestBody({ name: "a", transport: new FakeTransport() }));
    s.setBrain(new FakeBrain({ target_body: "a", action: "halt" }));
    await s.run();
    await s.stop();
    assert.strictEqual(stopped, 1);
  });
});

// -- BodyAdapter modes --

describe("BodyAdapter modes", () => {
  test("default mode is standalone", () => {
    const b = makeBody("a");
    assert.strictEqual(b.mode, "standalone");
  });

  test("attaching to Space flips mode to managed", () => {
    const s = new Space("test");
    const b = makeBody("a");
    s.addBody(b);
    assert.strictEqual(b.mode, "managed");
  });

  test("attach sends set_mode over transport", () => {
    const t = new FakeTransport();
    const s = new Space("test");
    const b = makeBody("a", { transport: t });
    s.addBody(b);

    const msg = t.sent.find(m => m.type === "set_mode");
    assert.ok(msg, "expected set_mode message to be sent");
    assert.strictEqual(msg.data.mode, "managed");
    assert.strictEqual(msg.data.body, "a");
  });

  test("detachSpace reverts to standalone", () => {
    const s = new Space("test");
    const b = makeBody("a");
    s.addBody(b);
    b._detachSpace();
    assert.strictEqual(b.mode, "standalone");
  });

  test("invalid mode throws", () => {
    const b = makeBody("a");
    assert.throws(() => b._setMode("rogue"), { message: /invalid mode/ });
  });

  test("snapshot includes mode", () => {
    const b = makeBody("a");
    const snap = b.snapshot();
    assert.strictEqual(snap.mode, "standalone");
  });

  test("cannot attach to two Spaces", () => {
    const s1 = new Space("s1");
    const s2 = new Space("s2");
    const b = makeBody("a");
    s1.addBody(b);
    assert.throws(() => s2.addBody(b), { message: /already attached/ });
  });
});

describe("BodyAdapter execute", () => {
  test("rejects intent missing action", async () => {
    const b = makeBody("a");
    await assert.rejects(() => b.execute({}), { message: /missing action/ });
  });

  test("rejects action not in capabilities", async () => {
    const b = makeBody("a", { capabilities: ["halt"] });
    await assert.rejects(() => b.execute({ action: "jump" }), { message: /not declared/ });
  });

  test("emits events and stores them", () => {
    const b = makeBody("a");
    b.emit("entity_detected", { kind: "box" });
    const snap = b.snapshot();
    assert.strictEqual(snap.pending_events.length, 1);
    assert.strictEqual(snap.pending_events[0].type, "entity_detected");
  });

  test("clearPendingEvents drains the buffer", () => {
    const b = makeBody("a");
    b.emit("x");
    b.clearPendingEvents();
    assert.strictEqual(b.snapshot().pending_events.length, 0);
  });
});

// -- Brain base class --

describe("Brain", () => {
  test("_rawCall throws if not implemented", async () => {
    const b = new Brain();
    await assert.rejects(() => b._rawCall(""), { message: /must be implemented/ });
  });

  test("invoke parses valid JSON", async () => {
    const b = new FakeBrain({ target_body: "a", action: "halt" });
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.target_body, "a");
    assert.strictEqual(intent.action, "halt");
    assert.strictEqual(intent.priority, 3); // default
    assert.strictEqual(intent.fallback, "hold_position");
  });

  test("invoke returns null for invalid JSON", async () => {
    const b = new FakeBrain("not json at all");
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent, null);
  });

  test("invoke returns null for missing required fields", async () => {
    const b = new FakeBrain({ action: "halt" }); // no target_body
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent, null);
  });

  test("invoke extracts JSON from surrounding text", async () => {
    const b = new FakeBrain('Sure! Here is my decision: {"target_body":"a","action":"halt"}');
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.target_body, "a");
  });

  test("invoke clamps priority to 1-5", async () => {
    const b = new FakeBrain({ target_body: "a", action: "halt", priority: 99 });
    const intent = await b.invoke({ bodies: {} });
    assert.strictEqual(intent.priority, 5);
  });

  test("stats increment on call", async () => {
    const b = new FakeBrain({ target_body: "a", action: "halt" });
    await b.invoke({ bodies: {} });
    assert.strictEqual(b.callCount, 1);
    assert.strictEqual(b.errorCount, 0);
  });

  test("buildPrompt includes body names and active goal", () => {
    const b = new Brain();
    const prompt = b.buildPrompt({
      bodies: { arm: { status: "active", last_action: "move_to" } },
      active_goal: "pick up the box",
      recent_history: ["arm moved"],
    });
    assert.ok(prompt.includes("arm"));
    assert.ok(prompt.includes("pick up the box"));
  });
});

// -- OllamaBrain --

describe("OllamaBrain", () => {
  test("constructor defaults", () => {
    const b = new OllamaBrain();
    assert.strictEqual(b.model, "llama3.2");
    assert.strictEqual(b.host, "http://localhost:11434");
  });

  test("isAvailable returns false for unreachable host", async () => {
    const ok = await OllamaBrain.isAvailable("http://localhost:19999");
    assert.strictEqual(ok, false);
  });

  test("isAvailable never throws", async () => {
    // Doesn't matter if Ollama is running or not; just must not throw.
    await OllamaBrain.isAvailable("http://not-a-real-host-9999.invalid");
    assert.ok(true);
  });
});

// -- Translator --

describe("Translator", () => {
  function setup() {
    const t = new Translator();
    const bodies = new Map();
    bodies.set("arm", new BodyAdapter({
      name: "arm",
      capabilities: ["move_to", "halt"],
      transport: new FakeTransport(),
    }));
    return { t, bodies };
  }

  test("translates valid intent", () => {
    const { t, bodies } = setup();
    const r = t.translate(
      { target_body: "arm", action: "move_to", parameters: { x: 1 } },
      bodies
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.command.body, "arm");
    assert.strictEqual(r.command.action, "move_to");
    assert.deepStrictEqual(r.command.parameters, { x: 1 });
  });

  test("rejects invalid_intent for non-object", () => {
    const { t, bodies } = setup();
    const r = t.translate(null, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "invalid_intent");
  });

  test("rejects missing_target_body", () => {
    const { t, bodies } = setup();
    const r = t.translate({ action: "halt" }, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "missing_target_body");
  });

  test("rejects missing_action", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm" }, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "missing_action");
  });

  test("rejects unknown_body", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "leg", action: "halt" }, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "unknown_body");
  });

  test("rejects capability_denied", () => {
    const { t, bodies } = setup();
    const r = t.translate({ target_body: "arm", action: "jump" }, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "capability_denied");
  });

  test("rejects action_not_allowed with global allowlist", () => {
    const bodies = new Map();
    bodies.set("arm", new BodyAdapter({
      name: "arm",
      // No capabilities declared -> body allows all
      transport: new FakeTransport(),
    }));
    const t = new Translator({ allowedActions: new Set(["halt"]) });
    const r = t.translate({ target_body: "arm", action: "move_to" }, bodies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "action_not_allowed");
  });

  test("stats track rejections by reason", () => {
    const { t, bodies } = setup();
    t.translate(null, bodies);
    t.translate({ target_body: "x", action: "halt" }, bodies);
    t.translate({ target_body: "arm", action: "jump" }, bodies);
    const s = t.getStats();
    assert.strictEqual(s.byReason.invalid_intent, 1);
    assert.strictEqual(s.byReason.unknown_body, 1);
    assert.strictEqual(s.byReason.capability_denied, 1);
  });
});

// -- Aggregator --

describe("Aggregator", () => {
  test("merges state from two bodies", () => {
    const a = new Aggregator();
    const bodies = new Map();
    const b1 = new BodyAdapter({ name: "a", transport: new FakeTransport() });
    const b2 = new BodyAdapter({ name: "b", transport: new FakeTransport() });
    b1.setState({ position: { x: 1 } });
    b2.setState({ position: { x: 2 } });
    bodies.set("a", b1);
    bodies.set("b", b2);

    const out = a.aggregate(bodies);
    assert.ok(out.bodies.a);
    assert.ok(out.bodies.b);
    assert.strictEqual(out.bodies.a.position.x, 1);
    assert.strictEqual(out.bodies.b.position.x, 2);
  });

  test("clears pending events after aggregation", () => {
    const a = new Aggregator();
    const body = new BodyAdapter({ name: "x", transport: new FakeTransport() });
    body.emit("detected", { kind: "cup" });
    const bodies = new Map([["x", body]]);

    const out = a.aggregate(bodies);
    assert.strictEqual(out.bodies.x.pending_events.length, 1);
    // Second aggregate should see zero because first one cleared
    const out2 = a.aggregate(bodies);
    assert.strictEqual(out2.bodies.x.pending_events, undefined);
  });

  test("enforces token budget under 2000", () => {
    const a = new Aggregator({ tokenBudget: 500 });
    const bodies = new Map();

    // Create many bodies with bulky state
    for (let i = 0; i < 20; i++) {
      const b = new BodyAdapter({ name: `body_${i}`, transport: new FakeTransport() });
      b.setState({
        long_field: "x".repeat(500),
        positions: Array(20).fill({ x: 1.12345, y: 2.6789, z: 3.45678 }),
      });
      bodies.set(`body_${i}`, b);
    }

    const out = a.aggregate(bodies);
    const size = Math.ceil(JSON.stringify(out).length / 4);
    assert.ok(size <= 500, `expected size <= 500 tokens, got ${size}`);
  });

  test("flags stale state", async () => {
    const a = new Aggregator({ staleMs: 50 });
    const body = new BodyAdapter({ name: "slow", transport: new FakeTransport() });
    body.setState({ value: 1 });
    // Wait for staleness threshold
    await new Promise((r) => setTimeout(r, 100));
    const bodies = new Map([["slow", body]]);

    const out = a.aggregate(bodies);
    assert.strictEqual(out.bodies.slow.stale, true);
    assert.ok(out.bodies.slow.age_ms >= 50);
  });

  test("compacts float values to 3 decimals", () => {
    const a = new Aggregator();
    const b = new BodyAdapter({ name: "x", transport: new FakeTransport() });
    b.setState({ pos: 3.14159265 });
    const out = a.aggregate(new Map([["x", b]]));
    assert.strictEqual(out.bodies.x.pos, 3.142);
  });

  test("truncates long strings", () => {
    const a = new Aggregator();
    const b = new BodyAdapter({ name: "x", transport: new FakeTransport() });
    b.setState({ note: "z".repeat(500) });
    const out = a.aggregate(new Map([["x", b]]));
    assert.ok(out.bodies.x.note.length <= 120);
  });
});
