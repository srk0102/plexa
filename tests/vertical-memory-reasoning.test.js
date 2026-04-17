// Test: VerticalMemory stores reasoning and evaluates per-case.
//
// Proves: two different inputs with same pattern get DIFFERENT decisions
// based on how the reasoning applies to each specific case.
// This is NOT caching answers. This is applying learned principles.

const { VerticalMemory } = require("../packages/core/vertical-memory");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

describe("VerticalMemory reasoning", () => {
  let vm;

  it("setup", () => {
    vm = new VerticalMemory({ spaceName: "fraud_test" });
  });

  it("stores reasoning trace from brain", async () => {
    // Brain taught: "Fraud when account is new + high velocity + no 2FA"
    const reasoning = {
      decision: "block",
      indicators: [
        { variable: "account_age_hours", weight: 0.3, condition: "< 24" },
        { variable: "requests_per_hour", weight: 0.3, condition: "> 10" },
        { variable: "has_2fa", weight: 0.2, condition: "false" },
        { variable: "is_vpn", weight: 0.2, condition: "true" },
      ],
      threshold: 0.6,
      explanation: "New account + high velocity + weak security signals indicate credential stuffing",
    };

    const entry = await vm.store(
      "auth_guard", "check_request",
      { goal: "protect_api", bodies: { auth_guard: { tools: { check_request: {} } } } },
      "block",
      reasoning,
      { confidence: 0.9, source: "llm_brain" }
    );

    assert.ok(entry.reasoning, "reasoning should be stored");
    assert.equal(entry.reasoning.indicators.length, 4);
    assert.equal(entry.reasoning.threshold, 0.6);
  });

  it("evaluates FRAUD case correctly using reasoning", () => {
    // Attacker: new account, high velocity, no 2FA, using VPN
    const attackerInput = {
      account_age_hours: 2,        // < 24 -> matches (weight 0.3)
      requests_per_hour: 50,       // > 10 -> matches (weight 0.3)
      has_2fa: false,              // false -> matches (weight 0.2)
      is_vpn: true,               // true -> matches (weight 0.2)
    };

    const reasoning = vm.entries[0].reasoning;
    const result = vm.evaluate(attackerInput, reasoning);

    assert.equal(result.passes, true, "attacker should be blocked");
    assert.equal(result.score, 1.0, "all 4 indicators match = score 1.0");
    assert.equal(result.matched.length, 4, "all 4 indicators matched");
    assert.equal(result.missed.length, 0);
    console.log("  attacker: score=1.0, decision=block. Correct.");
  });

  it("evaluates LEGITIMATE user correctly - same reasoning, different decision", () => {
    // Real user: old account, low velocity, has 2FA, no VPN
    // A cached-answer system would return "block" for any similar request.
    // Reasoning evaluation lets this through.
    const legitimateInput = {
      account_age_hours: 2160,     // 90 days. NOT < 24 -> miss (0.3)
      requests_per_hour: 3,        // NOT > 10 -> miss (0.3)
      has_2fa: true,               // NOT false -> miss (0.2)
      is_vpn: false,               // NOT true -> miss (0.2)
    };

    const reasoning = vm.entries[0].reasoning;
    const result = vm.evaluate(legitimateInput, reasoning);

    assert.equal(result.passes, false, "legitimate user should NOT be blocked");
    assert.equal(result.score, 0, "zero indicators match");
    assert.equal(result.matched.length, 0);
    assert.equal(result.missed.length, 4, "all 4 indicators missed");
    console.log("  legitimate user: score=0, decision=null (allow). Correct.");
  });

  it("evaluates EDGE CASE - partial match below threshold", () => {
    // Suspicious but not clearly fraud: new account but has 2FA
    const edgeCaseInput = {
      account_age_hours: 5,        // < 24 -> matches (0.3)
      requests_per_hour: 15,       // > 10 -> matches (0.3)
      has_2fa: true,               // NOT false -> miss (0.2)
      is_vpn: false,               // NOT true -> miss (0.2)
    };

    const reasoning = vm.entries[0].reasoning;
    const result = vm.evaluate(edgeCaseInput, reasoning);

    // Score: 0.3 + 0.3 = 0.6, threshold is 0.6
    // This is ON the threshold - passes.
    assert.equal(result.score, 0.6);
    assert.equal(result.passes, true, "exactly at threshold = passes");
    assert.equal(result.matched.length, 2, "2 indicators matched");
    assert.equal(result.missed.length, 2, "2 indicators missed");
    console.log("  edge case: score=0.6 (threshold=0.6), decision=block. Borderline.");
  });

  it("evaluates DIFFERENT edge case - just below threshold", () => {
    // New account but low velocity, no VPN, no 2FA
    const justBelowInput = {
      account_age_hours: 5,        // < 24 -> matches (0.3)
      requests_per_hour: 3,        // NOT > 10 -> miss (0.3)
      has_2fa: false,              // false -> matches (0.2)
      is_vpn: false,               // NOT true -> miss (0.2)
    };

    const reasoning = vm.entries[0].reasoning;
    const result = vm.evaluate(justBelowInput, reasoning);

    // Score: 0.3 + 0.2 = 0.5, below threshold 0.6
    assert.equal(result.score, 0.5);
    assert.equal(result.passes, false, "below threshold = does NOT pass");
    console.log("  just below: score=0.5 (threshold=0.6), decision=null (allow). Correct.");
  });

  it("searchAndEvaluate finds reasoning and applies it", async () => {
    const worldState = { goal: "protect_api", bodies: { auth_guard: { tools: { check_request: {} } } } };

    // Attacker-shaped input
    const attackerResult = await vm.searchAndEvaluate(worldState, {
      account_age_hours: 1, requests_per_hour: 100, has_2fa: false, is_vpn: true,
    });
    assert.ok(attackerResult, "should find reasoning");
    assert.equal(attackerResult.passes, true);
    assert.equal(attackerResult.decision, "block");
    assert.equal(attackerResult.from_reasoning, true);

    // Legitimate-shaped input against SAME world state
    const legitResult = await vm.searchAndEvaluate(worldState, {
      account_age_hours: 8760, requests_per_hour: 2, has_2fa: true, is_vpn: false,
    });
    // Should either return null (no reasoning matched) or return passes=false
    if (legitResult) {
      assert.equal(legitResult.passes, false, "legit user should not be blocked");
    }
    console.log("  searchAndEvaluate: attacker blocked, legit user allowed. From same reasoning.");
  });

  it("summary: one reasoning pattern, four different decisions", () => {
    console.log("\n  === SUMMARY ===");
    console.log("  Same reasoning pattern applied to 4 different inputs:");
    console.log("  Attacker (all match):      score=1.0 -> BLOCK");
    console.log("  Legit user (none match):   score=0.0 -> ALLOW");
    console.log("  Edge case (2/4 match):     score=0.6 -> BLOCK (borderline)");
    console.log("  Just below (2/4 match):    score=0.5 -> ALLOW (below threshold)");
    console.log("  ");
    console.log("  A cached-answer system would block ALL of them.");
    console.log("  Reasoning evaluation blocks only the actual threats.");
  });
});
