const { describe, test } = require("node:test");
const assert = require("node:assert");

const { Space, BodyAdapter, Brain } = require("..");

// Lightweight pattern-store stub so we do not take a hard dep on scp-protocol
class StubStore {
  constructor(patterns = {}) { this._patterns = patterns; }
  lookup(entity) {
    const key = JSON.stringify(entity);
    if (this._patterns[key]) {
      return { decision: this._patterns[key], source: "exact", confidence: 0.8 };
    }
    return null;
  }
  report() {}
}

class FakeBrain extends Brain {
  async _rawCall() {
    return JSON.stringify({ target_body: "nope", tool: "nope" });
  }
}

class SimpleBody extends BodyAdapter {
  static bodyName = "simple";
  static tools = {
    do_thing: { description: "", parameters: {} },
  };
  async do_thing() { return { ok: true }; }
}

describe("managed mode: body stays intelligent", () => {
  test("decideLocally uses pattern store in standalone mode", () => {
    const store = new StubStore({ '{"x":1}': "go_right" });
    const body = new SimpleBody({ patternStore: store });
    const r = body.decideLocally({ x: 1 });
    assert.ok(r);
    assert.strictEqual(r.decision, "go_right");
  });

  test("decideLocally uses pattern store in managed mode", () => {
    const store = new StubStore({ '{"x":1}': "go_right" });
    const body = new SimpleBody({ patternStore: store });
    const space = new Space("t");
    space.addBody(body);
    assert.strictEqual(body.mode, "managed");
    const r = body.decideLocally({ x: 1 });
    assert.strictEqual(r.decision, "go_right");
  });

  test("decideLocally returns null on cache miss", () => {
    const store = new StubStore({});
    const body = new SimpleBody({ patternStore: store });
    assert.strictEqual(body.decideLocally({ x: 99 }), null);
  });

  test("decideLocally notifies Space.onBodyDecision in managed mode", () => {
    const store = new StubStore({ '{"x":1}': "go_right" });
    const body = new SimpleBody({ patternStore: store });
    const space = new Space("t");
    space.addBody(body);

    let evt = null;
    space.on("body_decision", (e) => { evt = e; });

    body.decideLocally({ x: 1 });

    assert.ok(evt);
    assert.strictEqual(evt.body, "simple");
    assert.strictEqual(evt.decision, "go_right");
    assert.strictEqual(evt.meta.source, "exact");
  });

  test("Space.stats.bodyDecisions increments", () => {
    const store = new StubStore({ '{"x":1}': "a", '{"x":2}': "b" });
    const body = new SimpleBody({ patternStore: store });
    const space = new Space("t");
    space.addBody(body);
    body.decideLocally({ x: 1 });
    body.decideLocally({ x: 2 });
    body.decideLocally({ x: 99 }); // miss -- does not count
    assert.strictEqual(space.getStats().bodyDecisions, 2);
  });

  test("Space adds decision to history", () => {
    const store = new StubStore({ '{"x":1}': "go_right" });
    const body = new SimpleBody({ patternStore: store });
    const space = new Space("t");
    space.addBody(body);
    body.decideLocally({ x: 1 });
    assert.ok(space.history.some((h) => h.includes("simple local")));
  });

  test("notifyDecision is safe without Space", () => {
    const body = new SimpleBody();
    body.notifyDecision({ x: 1 }, "foo", { source: "cache" });
    assert.ok(true);
  });

  test("body stats.decisions increments on decideLocally hit", () => {
    const store = new StubStore({ '{"x":1}': "a" });
    const body = new SimpleBody({ patternStore: store });
    body.decideLocally({ x: 1 });
    body.decideLocally({ x: 1 });
    body.decideLocally({ x: 99 }); // miss
    assert.strictEqual(body.stats.decisions, 2);
  });

  test("body without patternStore returns null from decideLocally", () => {
    const body = new SimpleBody();
    assert.strictEqual(body.decideLocally({ x: 1 }), null);
  });

  test("body stays intelligent: mode does not disable patternStore", () => {
    const store = new StubStore({ '{"x":1}': "same" });
    const body = new SimpleBody({ patternStore: store });
    // managed does not change which patterns resolve
    body._setMode("managed");
    const mResult = body.decideLocally({ x: 1 });
    body._setMode("standalone");
    const sResult = body.decideLocally({ x: 1 });
    assert.strictEqual(mResult.decision, sResult.decision);
  });
});
