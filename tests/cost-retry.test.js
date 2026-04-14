const { describe, test } = require("node:test");
const assert = require("node:assert");

const { Brain, Space, BodyAdapter } = require("..");

class FakeBrain extends Brain {
  constructor(opts = {}) { super(opts); this._script = opts.script || []; this._i = 0; }
  async _rawCall() {
    if (this._i >= this._script.length) {
      return JSON.stringify({ target_body: "a", tool: "noop", parameters: {} });
    }
    const step = this._script[this._i++];
    if (step instanceof Error) throw step;
    return step;
  }
}

class Bot extends BodyAdapter {
  static tools = { noop: { description: "x", parameters: {} } };
  constructor() { super({ name: "a" }); }
  async noop() { return {}; }
}

// ============================================================
// Cost tracking
// ============================================================

describe("Brain cost tracking", () => {
  test("costForModel recognizes known prefixes", () => {
    assert.strictEqual(Brain.costForModel("llama3.2"), 0);
    assert.ok(Brain.costForModel("amazon.nova-micro-v1:0") > 0);
    assert.ok(Brain.costForModel("claude-haiku-4-5-20251001") > 0);
    assert.ok(Brain.costForModel("gpt-4o-mini") > 0);
    assert.strictEqual(Brain.costForModel(""), 0);
    assert.strictEqual(Brain.costForModel(null), 0);
  });

  test("cost accumulates after invoke", async () => {
    const b = new FakeBrain({
      model: "amazon.nova-micro-v1:0",
      script: [JSON.stringify({ target_body: "a", tool: "noop", parameters: {} })],
    });
    const world = { bodies: {}, active_goal: "g", recent_history: [] };
    await b.invoke(world);
    assert.ok(b.totalCost > 0);
    assert.ok(b.totalInputTokens > 0);
    assert.strictEqual(b.stats().totalCost > 0, true);
  });

  test("zero cost for local models", async () => {
    const b = new FakeBrain({
      model: "llama3.2",
      script: [JSON.stringify({ target_body: "a", tool: "noop", parameters: {} })],
    });
    await b.invoke({ bodies: {}, active_goal: "g", recent_history: [] });
    assert.strictEqual(b.totalCost, 0);
  });

  test("custom costPerKToken overrides default", () => {
    const b = new FakeBrain({ model: "some-model", costPerKToken: 0.5 });
    assert.strictEqual(b.costPerKToken, 0.5);
  });

  test("Space stats include estimatedCostUSD and costSavedByCacheUSD", async () => {
    const s = new Space("t");
    const brain = new FakeBrain({
      model: "claude-haiku-4-5-20251001",
      script: [JSON.stringify({ target_body: "a", tool: "noop", parameters: {} })],
    });
    s.addBody(new Bot());
    s.setBrain(brain);
    await s._maybeCallBrain();
    const stats = s.getStats();
    assert.ok(stats.estimatedCostUSD >= 0);
    assert.strictEqual(typeof stats.costSavedByCacheUSD, "number");
  });
});

// ============================================================
// Retry policy
// ============================================================

describe("Brain retry policy", () => {
  test("retries on network error and succeeds", async () => {
    const b = new FakeBrain({
      model: "llama3.2",
      maxRetries: 2,
      retryDelayMs: 1,
      script: [
        new Error("ECONNREFUSED 127.0.0.1"),
        JSON.stringify({ target_body: "a", tool: "noop", parameters: {} }),
      ],
    });
    const out = await b.invoke({ bodies: {}, active_goal: "g", recent_history: [] });
    assert.ok(out);
    assert.strictEqual(b.retriesTotal, 1);
    assert.strictEqual(b.retrySuccesses, 1);
  });

  test("retries on 429 with backoff", async () => {
    const b = new FakeBrain({
      model: "llama3.2",
      maxRetries: 2,
      retryDelayMs: 1,
      script: [
        new Error("HTTP 429: too many requests"),
        JSON.stringify({ target_body: "a", tool: "noop", parameters: {} }),
      ],
    });
    const out = await b.invoke({ bodies: {}, active_goal: "g", recent_history: [] });
    assert.ok(out);
    assert.strictEqual(b.retriesTotal, 1);
  });

  test("no retry on 400 bad request", async () => {
    const b = new FakeBrain({
      model: "llama3.2",
      maxRetries: 3,
      retryDelayMs: 1,
      script: [new Error("HTTP 400: bad request")],
    });
    await assert.rejects(() => b.invoke({ bodies: {}, active_goal: "g", recent_history: [] }), /HTTP 400/);
    assert.strictEqual(b.retriesTotal, 0);
  });

  test("retry on 500 server error once", async () => {
    const b = new FakeBrain({
      model: "llama3.2",
      maxRetries: 2,
      retryDelayMs: 1,
      script: [
        new Error("HTTP 500: internal"),
        JSON.stringify({ target_body: "a", tool: "noop", parameters: {} }),
      ],
    });
    const out = await b.invoke({ bodies: {}, active_goal: "g", recent_history: [] });
    assert.ok(out);
    assert.strictEqual(b.retriesTotal, 1);
  });

  test("gives up after maxRetries exhausted", async () => {
    const b = new FakeBrain({
      model: "llama3.2",
      maxRetries: 2,
      retryDelayMs: 1,
      script: [
        new Error("ECONNREFUSED"),
        new Error("ECONNREFUSED"),
        new Error("ECONNREFUSED"),
      ],
    });
    await assert.rejects(() => b.invoke({ bodies: {}, active_goal: "g", recent_history: [] }), /ECONNREFUSED/);
    assert.strictEqual(b.retriesTotal, 2);
  });
});

// ============================================================
// Auto-save on stop
// ============================================================

describe("Space auto-save on stop", () => {
  test("stop() saves vertical memory when attached", async () => {
    class FakeMem {
      constructor() { this.saved = 0; this.store = async () => {}; this.search = async () => []; }
      async save() { this.saved++; return 7; }
      stats() { return {}; }
    }
    const mem = new FakeMem();
    const s = new Space("t", { verticalMemory: mem });
    s.addBody(new Bot());
    s.setBrain(new FakeBrain());
    s._running = true; // skip actual run()
    await s.stop();
    assert.strictEqual(mem.saved, 1);
  });

  test("installShutdownHandlers is idempotent", () => {
    const s = new Space("t");
    s.installShutdownHandlers();
    assert.strictEqual(s._autoSaveInstalled, true);
    s.installShutdownHandlers();
    assert.strictEqual(s._autoSaveInstalled, true);
  });

  test("stop() calls body.patternStore.save when present", async () => {
    class SavingStore {
      constructor() { this.saves = 0; this.patterns = new Map(); }
      save() { this.saves++; }
    }
    class Saver extends BodyAdapter {
      static tools = { noop: { description: "x", parameters: {} } };
      constructor(store) { super({ name: "s" }); this.patternStore = store; }
      async noop() { return {}; }
    }
    const store = new SavingStore();
    const body = new Saver(store);
    const s = new Space("t");
    s.addBody(body);
    s.setBrain(new FakeBrain());
    s._running = true;
    await s.stop();
    assert.strictEqual(store.saves, 1);
  });

  test("cost per 1k tokens table covers expected model names", () => {
    assert.ok(Brain.DEFAULT_COST_TABLE.length > 0);
    const nova = Brain.DEFAULT_COST_TABLE.find(([p]) => p.includes("nova-micro"));
    assert.ok(nova);
    assert.ok(nova[1] > 0);
  });
});
