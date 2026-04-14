const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { VerticalMemory, Space, BodyAdapter, Brain } = require("..");

function tmpdb(name) {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function cleanup(file) {
  for (const ext of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(file + ext); } catch {}
  }
}

describe("VerticalMemory basic", () => {
  test("stores and searches", async () => {
    const m = new VerticalMemory({ spaceName: "t" });
    await m.store("arm", "move", { active_goal: "pick", bodies: { arm: { tools: { move: {} } } } }, { target_body: "arm", tool: "move" });
    const results = await m.search({ active_goal: "pick", bodies: { arm: { tools: { move: {} } } } }, 5);
    assert.ok(results.length > 0);
    assert.strictEqual(results[0].body, "arm");
    assert.strictEqual(results[0].tool, "move");
  });

  test("search returns empty on empty memory", async () => {
    const m = new VerticalMemory({ spaceName: "t" });
    const r = await m.search({ bodies: {} });
    assert.deepStrictEqual(r, []);
  });

  test("similarity ranks same bodies/tools higher", async () => {
    const m = new VerticalMemory({ spaceName: "t" });
    await m.store("arm", "grasp", { bodies: { arm: { tools: { grasp: {} } } } }, { tool: "grasp" });
    await m.store("camera", "snap", { bodies: { camera: { tools: { snap: {} } } } }, { tool: "snap" });
    const r = await m.search({ bodies: { arm: { tools: { grasp: {} } } } }, 5);
    assert.strictEqual(r[0].body, "arm");
  });

  test("outcome recording adjusts confidence", async () => {
    const m = new VerticalMemory({ spaceName: "t" });
    const before = await m.store("arm", "move", { bodies: { arm: {} } }, "dec");
    await m.recordOutcome("arm", "move", true);
    assert.ok(m.entries[0].confidence >= before.confidence);
  });

  test("stats reflect activity", async () => {
    const m = new VerticalMemory({ spaceName: "t", hitThreshold: 0.5 });
    await m.store("a", "go", { bodies: { a: {} } }, "x", { sessionId: "s1" });
    await m.store("a", "go", { bodies: { a: {} } }, "x", { sessionId: "s2" });
    await m.search({ bodies: { a: {} } });
    const s = m.stats();
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.sessionsCount, 2);
    assert.ok(s.searches >= 1);
  });
});

describe("VerticalMemory persistence", () => {
  test("save + load round trip", async (t) => {
    let hasSqlite = true;
    try { require("better-sqlite3"); } catch { hasSqlite = false; }
    if (!hasSqlite) { t.skip("better-sqlite3 not installed"); return; }

    const file = tmpdb("vmem");
    try {
      const m1 = new VerticalMemory({ spaceName: "t", dbPath: file });
      await m1.store("arm", "move", { bodies: { arm: {} }, active_goal: "g" }, { tool: "move" }, { sessionId: "s1" });
      await m1.save();

      const m2 = new VerticalMemory({ spaceName: "t", dbPath: file });
      const n = await m2.load();
      assert.strictEqual(n, 1);
      const r = await m2.search({ bodies: { arm: {} }, active_goal: "g" });
      assert.ok(r.length > 0);
      assert.strictEqual(r[0].body, "arm");
    } finally {
      cleanup(file);
    }
  });

  test("isolates entries by spaceName", async (t) => {
    let hasSqlite = true;
    try { require("better-sqlite3"); } catch { hasSqlite = false; }
    if (!hasSqlite) { t.skip("better-sqlite3 not installed"); return; }

    const file = tmpdb("vmem-iso");
    try {
      const a = new VerticalMemory({ spaceName: "alpha", dbPath: file });
      await a.store("x", "y", { bodies: {} }, "d", { sessionId: "s1" });
      await a.save();

      const b = new VerticalMemory({ spaceName: "beta", dbPath: file });
      const n = await b.load();
      assert.strictEqual(n, 0);
    } finally {
      cleanup(file);
    }
  });
});

describe("VerticalMemory integration with Space", () => {
  class FakeBrain extends Brain {
    constructor() { super({ model: "fake" }); this.calls = 0; }
    async _rawCall() {
      this.calls++;
      return JSON.stringify({ target_body: "a", tool: "act", parameters: {} });
    }
  }
  class Bot extends BodyAdapter {
    static tools = { act: { description: "x", parameters: {} } };
    constructor() { super({ name: "a" }); }
    async act() { return {}; }
  }

  test("onBodyDecision writes to attached vertical memory", async () => {
    const mem = new VerticalMemory({ spaceName: "t" });
    const s = new Space("t", { verticalMemory: mem });
    s.addBody(new Bot());
    s.setBrain(new FakeBrain());

    s.onBodyDecision("a", { x: 1 }, "act", { confidence: 0.7, source: "cache" });
    // Write-through is synchronous here (store returns synchronously for in-memory mode).
    await new Promise((r) => setImmediate(r));
    assert.ok(mem.entries.length >= 1);
  });

  test("Space consults vertical memory before brain", async () => {
    const mem = new VerticalMemory({ spaceName: "t", hitThreshold: 0.3 });
    // Pre-populate memory with a matching decision.
    await mem.store("a", "act", { bodies: { a: { tools: { act: {} } } } },
      { target_body: "a", tool: "act", parameters: {} },
      { confidence: 0.9, source: "brain", sessionId: "prev" });

    const s = new Space("t", { tickHz: 100, verticalMemory: mem });
    const brain = new FakeBrain();
    s.addBody(new Bot());
    s.setBrain(brain);

    await s._maybeCallBrain();
    // Memory hit means LLM was not called.
    assert.strictEqual(brain.calls, 0);
    assert.ok(s.stats.memoryHits >= 1);
  });

  test("low-confidence memory falls through to brain", async () => {
    const mem = new VerticalMemory({ spaceName: "t", hitThreshold: 0.999 });
    await mem.store("a", "act", { bodies: { a: { tools: { act: {} } } } },
      { target_body: "a", tool: "act", parameters: {} },
      { confidence: 0.1, source: "brain", sessionId: "prev" });

    const s = new Space("t", { verticalMemory: mem });
    const brain = new FakeBrain();
    s.addBody(new Bot());
    s.setBrain(brain);

    await s._maybeCallBrain();
    assert.strictEqual(brain.calls, 1);
    assert.ok(s.stats.memoryMisses >= 1);
  });
});
