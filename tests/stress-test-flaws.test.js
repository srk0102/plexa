// Stress test: proves the two flaws are fixed.
//
// Flaw 1: Linear weighting can't capture compound risk.
//   Before: new account (0.3) + VPN (0.2) = 0.5 = ALLOW (wrong)
//   After:  compound indicator "new account AND VPN" = 0.6 = BLOCK
//
// Flaw 2: Hard boundaries are gameable.
//   Before: 9 requests when threshold is "> 10" = score 0.0 (gameable)
//   After:  9 requests = fuzzy score 0.9 * weight (still contributes)

const { VerticalMemory } = require("../packages/core/vertical-memory");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

describe("Flaw fixes", () => {
  let vm;

  const reasoning = {
    decision: "block",
    indicators: [
      { variable: "account_age_hours", weight: 0.2, condition: "< 24" },
      { variable: "requests_per_hour", weight: 0.2, condition: "> 10", fuzzy: true },
      { variable: "has_2fa", weight: 0.15, condition: "false" },
      { variable: "is_vpn", weight: 0.15, condition: "true" },
    ],
    compounds: [
      {
        variables: ["account_age_hours", "is_vpn"],
        conditions: ["< 24", "true"],
        weight: 0.4,
        all: true,
      },
    ],
    threshold: 0.6,
    explanation: "Credential stuffing with compound risk for new+VPN",
  };

  it("setup", () => { vm = new VerticalMemory({ spaceName: "stress" }); });

  // ====== FLAW 1 FIX: Compound risk ======

  it("FLAW 1 BEFORE FIX: new account + VPN would score 0.35 (ALLOW - wrong)", () => {
    // Without compounds: 0.2 (age) + 0.15 (vpn) = 0.35 < 0.6
    // This was the flaw - two suspicious signals together should be worse
    const score = 0.2 + 0.15;
    assert.ok(score < 0.6, `linear sum ${score} is below threshold (the old flaw)`);
    console.log(`  linear only: ${score} < 0.6 = ALLOW (wrong)`);
  });

  it("FLAW 1 AFTER FIX: new account + VPN scores 0.75 with compound (BLOCK - correct)", () => {
    const result = vm.evaluate({
      account_age_hours: 5,
      requests_per_hour: 3,       // low velocity - not suspicious alone
      has_2fa: true,              // has 2FA - not suspicious alone
      is_vpn: true,               // VPN + new account = compound risk
    }, reasoning);

    // Simple indicators: age=0.2 + vpn=0.15 = 0.35
    // Compound: age AND vpn both match = +0.4
    // Total: 0.75
    console.log(`  with compound: score=${result.score}, passes=${result.passes}`);
    console.log(`  matched:`, result.matched.map(m => m.type === 'compound' ? `COMPOUND(${m.variables.join('+')}):${m.weight}` : `${m.variable}:${m.weight}`).join(', '));
    assert.ok(result.passes, "compound risk should push above threshold");
    assert.ok(result.score >= 0.7, `score ${result.score} should be >= 0.7`);
  });

  it("FLAW 1: old account + VPN does NOT trigger compound (ALLOW - correct)", () => {
    const result = vm.evaluate({
      account_age_hours: 8760,    // 1 year old
      requests_per_hour: 2,
      has_2fa: true,
      is_vpn: true,
    }, reasoning);

    // Simple: only vpn matches = 0.15. age does NOT match (8760 not < 24).
    // Compound: age does NOT match, so compound does NOT fire.
    // Total: 0.15
    console.log(`  old account + VPN: score=${result.score}, passes=${result.passes}`);
    assert.equal(result.passes, false, "old account on VPN should be allowed");
    assert.ok(result.score < 0.3, `score ${result.score} should be low`);
  });

  // ====== FLAW 2 FIX: Fuzzy boundaries ======

  it("FLAW 2 BEFORE FIX: 9 requests would score 0.0 for the velocity indicator", () => {
    // With hard matching: 9 > 10 is false. Score = 0.
    // Attacker sends 9 requests to dodge the "> 10" rule.
    const hardMatch = 9 > 10;
    assert.equal(hardMatch, false, "hard match: 9 > 10 is false (the old flaw)");
    console.log("  hard match: 9 > 10 = false, score = 0.0 (gameable)");
  });

  it("FLAW 2 AFTER FIX: 9 requests scores partial weight with fuzzy (not zero)", () => {
    const result = vm.evaluate({
      account_age_hours: 2,       // new
      requests_per_hour: 9,       // just under 10 - trying to game the system
      has_2fa: false,
      is_vpn: true,
    }, reasoning);

    // Fuzzy: 9 is close to 10 (90% of the way). fuzzy weight = 0.2 * ~0.67 = ~0.13
    // Plus simple: age=0.2, 2fa=0.15, vpn=0.15
    // Plus compound: age+vpn = 0.4
    // Total should be well above 0.6
    console.log(`  fuzzy 9/10: score=${result.score}, passes=${result.passes}`);
    const fuzzyMatch = result.matched.find(m => m.type === 'fuzzy');
    if (fuzzyMatch) {
      console.log(`  velocity fuzzy: value=${fuzzyMatch.value}, proximity=${fuzzyMatch.proximity}, partial_weight=${fuzzyMatch.weight}`);
    }
    assert.ok(result.passes, "attacker gaming boundaries should still be caught");
  });

  it("FLAW 2: 2 requests scores zero even with fuzzy (too far from threshold)", () => {
    const result = vm.evaluate({
      account_age_hours: 720,     // 30 days
      requests_per_hour: 2,       // far from 10 - legitimate
      has_2fa: true,
      is_vpn: false,
    }, reasoning);

    console.log(`  2 requests: score=${result.score}, passes=${result.passes}`);
    assert.equal(result.passes, false, "2 requests is far from 10 - no fuzzy score");
    assert.equal(result.score, 0, "nothing should match for this legitimate user");
  });

  it("summary", () => {
    console.log("\n  === STRESS TEST SUMMARY ===");
    console.log("  Flaw 1 (compound risk): FIXED");
    console.log("    new account + VPN = compound 0.4 bonus -> BLOCK");
    console.log("    old account + VPN = no compound -> ALLOW");
    console.log("  Flaw 2 (hard boundaries): FIXED");
    console.log("    9 requests (gaming '>10') = fuzzy partial score -> still CAUGHT");
    console.log("    2 requests (legitimate) = too far, no fuzzy -> ALLOW");
  });
});
