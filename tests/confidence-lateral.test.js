const { describe, test } = require("node:test");
const assert = require("node:assert");

const { Space, BodyAdapter, Brain } = require("..");

class FakeBrain extends Brain {
  async _rawCall() { return "{}"; }
}

class Bot extends BodyAdapter {
  static tools = {
    noop: { description: "noop", parameters: {} },
    receive: { description: "receive", parameters: {} },
  };
  constructor(name) {
    super({ name });
    this.peerReceived = [];
  }
  async noop() { return {}; }
  async receive() { return {}; }
  async onPeerEvent(from, type, payload, priority) {
    this.peerReceived.push({ from, type, payload, priority });
  }
}

// ============================================================
// Confidence gating
// ============================================================

describe("Space confidence gating", () => {
  test("setConfidenceThresholds stores values", () => {
    const s = new Space("t");
    s.setConfidenceThresholds({ autoApprove: 0.8, monitor: 0.5, escalate: 0.2 });
    assert.strictEqual(s.confidenceThresholds.autoApprove, 0.8);
    assert.strictEqual(s.confidenceThresholds.monitor, 0.5);
    assert.strictEqual(s.confidenceThresholds.escalate, 0.2);
  });

  test("high confidence does not warn", () => {
    const s = new Space("t");
    s.addBody(new Bot("a"));
    s.setBrain(new FakeBrain());
    s.setConfidenceThresholds({ autoApprove: 0.8, monitor: 0.5, escalate: 0.2 });
    let warned = false;
    s.on("confidence_warning", () => { warned = true; });
    s.onBodyDecision("a", { x: 1 }, "act", { confidence: 0.95 });
    assert.strictEqual(warned, false);
    assert.strictEqual(s.stats.lowConfidenceCount, 0);
  });

  test("medium confidence emits warning", () => {
    const s = new Space("t");
    s.addBody(new Bot("a"));
    s.setBrain(new FakeBrain());
    s.setConfidenceThresholds({ autoApprove: 0.9, monitor: 0.6, escalate: 0.0 });
    let warned = null;
    s.on("confidence_warning", (e) => { warned = e; });
    s.onBodyDecision("a", { x: 1 }, "act", { confidence: 0.75 });
    assert.ok(warned);
    assert.strictEqual(warned.body, "a");
    assert.strictEqual(s.stats.lowConfidenceCount, 1);
  });

  test("below escalate threshold emits escalation", () => {
    const s = new Space("t");
    s.addBody(new Bot("a"));
    s.setBrain(new FakeBrain());
    s.setConfidenceThresholds({ autoApprove: 0.9, monitor: 0.6, escalate: 0.3 });
    let esc = null;
    s.on("confidence_escalation", (e) => { esc = e; });
    s.onBodyDecision("a", { x: 1 }, "act", { confidence: 0.15 });
    assert.ok(esc);
    assert.strictEqual(s.stats.escalatedByConfidence, 1);
  });

  test("avgConfidenceByBody tracks per body", () => {
    const s = new Space("t");
    s.addBody(new Bot("a"));
    s.setBrain(new FakeBrain());
    s.onBodyDecision("a", {}, "x", { confidence: 1.0 });
    s.onBodyDecision("a", {}, "x", { confidence: 0.5 });
    assert.strictEqual(s.stats.avgConfidenceByBody.a, 0.75);
  });

  test("no confidence field means no classification", () => {
    const s = new Space("t");
    s.addBody(new Bot("a"));
    s.setBrain(new FakeBrain());
    s.onBodyDecision("a", {}, "x", {}); // no confidence
    assert.strictEqual(s.stats.lowConfidenceCount, 0);
    assert.strictEqual(s.stats.escalatedByConfidence, 0);
  });
});

// ============================================================
// Lateral events
// ============================================================

describe("Space lateral links", () => {
  test("link requires known bodies", () => {
    const s = new Space("t");
    assert.throws(() => s.link("ghost", "b", ["x"]), /unknown body/);
    s.addBody(new Bot("a"));
    assert.throws(() => s.link("a", "ghost", ["x"]), /unknown body/);
  });

  test("link requires eventTypes array", () => {
    const s = new Space("t");
    s.addBody(new Bot("a"));
    s.addBody(new Bot("b"));
    assert.throws(() => s.link("a", "b", []), /non-empty/);
  });

  test("event fires onPeerEvent on target body", async () => {
    const s = new Space("t");
    const a = new Bot("a");
    const b = new Bot("b");
    s.addBody(a);
    s.addBody(b);
    s.link("a", "b", ["grip_slip"]);
    a.emit("grip_slip", { force: 3 }, "CRITICAL");
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(b.peerReceived.length, 1);
    assert.strictEqual(b.peerReceived[0].from, "a");
    assert.strictEqual(b.peerReceived[0].type, "grip_slip");
    assert.deepStrictEqual(b.peerReceived[0].payload, { force: 3 });
    assert.strictEqual(s.stats.peerEventsRouted, 1);
  });

  test("unlink stops delivery", async () => {
    const s = new Space("t");
    const a = new Bot("a");
    const b = new Bot("b");
    s.addBody(a); s.addBody(b);
    s.link("a", "b", ["x"]);
    s.unlink("a", "b", ["x"]);
    a.emit("x", {});
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(b.peerReceived.length, 0);
  });

  test("multiple targets fan out", async () => {
    const s = new Space("t");
    const a = new Bot("a");
    const b = new Bot("b");
    const c = new Bot("c");
    s.addBody(a); s.addBody(b); s.addBody(c);
    s.link("a", "b", ["ping"]);
    s.link("a", "c", ["ping"]);
    a.emit("ping", { n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(b.peerReceived.length, 1);
    assert.strictEqual(c.peerReceived.length, 1);
  });

  test("self-links are ignored (no infinite loop)", async () => {
    const s = new Space("t");
    const a = new Bot("a");
    s.addBody(a);
    s.link("a", "a", ["echo"]);
    a.emit("echo", {});
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(a.peerReceived.length, 0);
  });

  test("sendToPeer delivers event directly", async () => {
    const s = new Space("t");
    const a = new Bot("a");
    const b = new Bot("b");
    s.addBody(a); s.addBody(b);
    await a.sendToPeer("b", "ding", { n: 5 }, "HIGH");
    assert.strictEqual(b.peerReceived.length, 1);
    assert.strictEqual(b.peerReceived[0].priority, "HIGH");
  });
});
