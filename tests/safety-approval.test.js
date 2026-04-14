const { describe, test } = require("node:test");
const assert = require("node:assert");

const { Space, BodyAdapter, Brain } = require("..");

class FakeBrain extends Brain {
  constructor(response) { super({ model: "fake" }); this._response = response; }
  async _rawCall() {
    return typeof this._response === "string"
      ? this._response
      : JSON.stringify(this._response);
  }
}

class Robot extends BodyAdapter {
  static tools = {
    move: {
      description: "move",
      parameters: {
        speed: { type: "number", min: 0, max: 1, required: true },
      },
    },
    halt: { description: "halt", parameters: {} },
  };
  constructor(name = "robot") {
    super({ name });
    this.moves = [];
    this.halts = 0;
  }
  async move({ speed }) { this.moves.push(speed); return { speed }; }
  async halt() { this.halts++; return { ok: true }; }
}

function makeSpace() {
  const s = new Space("t", { tickHz: 1000 });
  s.addBody(new Robot());
  s.setBrain(new FakeBrain({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } }));
  return s;
}

// ============================================================
// Safety gate
// ============================================================

describe("Space safety rules", () => {
  test("addSafetyRule requires a function", () => {
    const s = new Space("t");
    assert.throws(() => s.addSafetyRule("nope"), /must be a function/);
  });

  test("safety rule that allows does not block", async () => {
    const s = makeSpace();
    s.addSafetyRule(() => ({ allowed: true }));
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(s.stats.toolsDispatched, 1);
    assert.strictEqual(s.stats.safetyBlocked, 0);
  });

  test("safety rule that blocks prevents dispatch", async () => {
    const s = makeSpace();
    s.addSafetyRule((cmd) =>
      cmd.tool === "move" && cmd.parameters.speed > 0.9
        ? { allowed: false, reason: "too fast" }
        : { allowed: true }
    );
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.95 } });
    assert.strictEqual(s.stats.toolsDispatched, 0);
    assert.strictEqual(s.stats.safetyBlocked, 1);
    assert.strictEqual(s.stats.toolsRejected, 1);
  });

  test("safety rule cannot be bypassed by approval hook", async () => {
    const s = makeSpace();
    s.addSafetyRule(() => ({ allowed: false, reason: "nope" }));
    s.addApprovalHook(() => true);
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.strictEqual(s.stats.toolsDispatched, 0);
    assert.strictEqual(s.stats.safetyBlocked, 1);
  });

  test("multiple safety rules: first blocker wins", async () => {
    const s = makeSpace();
    s.addSafetyRule(() => ({ allowed: true }));
    s.addSafetyRule(() => ({ allowed: false, reason: "second-rule" }));
    s.addSafetyRule(() => ({ allowed: false, reason: "never-reached" }));
    let emittedReason = null;
    s.on("safety_blocked", (e) => { emittedReason = e.reason; });
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.strictEqual(emittedReason, "second-rule");
  });

  test("safety rule that throws is treated as block", async () => {
    const s = makeSpace();
    s.addSafetyRule(() => { throw new Error("bug in rule"); });
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.strictEqual(s.stats.toolsDispatched, 0);
    assert.strictEqual(s.stats.safetyBlocked, 1);
  });

  test("safety runs before approval", async () => {
    const s = makeSpace();
    const order = [];
    s.addSafetyRule(() => { order.push("safety"); return { allowed: true }; });
    s.addApprovalHook(() => { order.push("approval"); return true; });
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.deepStrictEqual(order, ["safety", "approval"]);
  });
});

// ============================================================
// Approval hook
// ============================================================

describe("Space approval hook", () => {
  test("addApprovalHook requires a function", () => {
    const s = new Space("t");
    assert.throws(() => s.addApprovalHook("nope"), /must be a function/);
  });

  test("no hook: auto-approve", async () => {
    const s = makeSpace();
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(s.stats.toolsDispatched, 1);
    assert.strictEqual(s.stats.approvalRejected, 0);
  });

  test("hook returning true approves", async () => {
    const s = makeSpace();
    s.addApprovalHook(() => true);
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(s.stats.toolsDispatched, 1);
  });

  test("hook returning false rejects", async () => {
    const s = makeSpace();
    s.addApprovalHook(() => false);
    let rejected = false;
    s.on("approval_rejected", () => { rejected = true; });
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.strictEqual(s.stats.toolsDispatched, 0);
    assert.strictEqual(s.stats.approvalRejected, 1);
    assert.strictEqual(rejected, true);
  });

  test("hook can modify parameters", async () => {
    const s = makeSpace();
    s.addApprovalHook(async (cmd) => ({ ...cmd, parameters: { speed: 0.1 } }));
    let dispatchedParams = null;
    s.on("tool_dispatched", (e) => { dispatchedParams = e.parameters; });
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.9 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(s.stats.approvalModified, 1);
    assert.deepStrictEqual(dispatchedParams, { speed: 0.1 });
  });

  test("hook retargeting to invalid body is rejected", async () => {
    const s = makeSpace();
    s.addApprovalHook((cmd) => ({ ...cmd, body: "ghost" }));
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.strictEqual(s.stats.toolsDispatched, 0);
  });

  test("hook that throws rejects the intent", async () => {
    const s = makeSpace();
    let errEmitted = false;
    s.on("approval_error", () => { errEmitted = true; });
    s.addApprovalHook(() => { throw new Error("bug"); });
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    assert.strictEqual(s.stats.toolsDispatched, 0);
    assert.strictEqual(errEmitted, true);
    assert.strictEqual(s.stats.approvalRejected, 1);
  });

  test("second addApprovalHook replaces the first", async () => {
    const s = makeSpace();
    s.addApprovalHook(() => false);
    s.addApprovalHook(() => true);
    await s._dispatchIntent({ target_body: "robot", tool: "move", parameters: { speed: 0.5 } });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(s.stats.toolsDispatched, 1);
  });
});
