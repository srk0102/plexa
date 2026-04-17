// Test: Three-tier safety architecture.
//
// Level 1: Guardrails (immutable, code-level, cannot be overridden)
// Level 2: Schema validation (reject hallucinated vars, bad weights)
// Level 3: Conflict resolution (confidence-weighted + recency + fail-open)

const { VerticalMemory } = require("../packages/core/vertical-memory");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

describe("Three-tier safety", () => {

  // ======= LEVEL 2: Schema Validation =======

  describe("Schema validation", () => {
    it("rejects hallucinated variable names", async () => {
      const vm = new VerticalMemory({
        spaceName: "schema_test",
        allowedVariables: ["account_age_hours", "requests_per_hour", "has_2fa", "is_vpn"],
      });

      await assert.rejects(
        () => vm.store("guard", "check", {}, "block", {
          indicators: [
            { variable: "days_since_creation", weight: 0.3, condition: "< 24" }, // HALLUCINATED
          ],
          threshold: 0.6,
        }),
        (err) => {
          assert.equal(err.code, "SCHEMA_VALIDATION_ERROR");
          assert.ok(err.message.includes("days_since_creation"));
          console.log("  rejected hallucinated var: days_since_creation");
          return true;
        }
      );
    });

    it("rejects weight out of range", async () => {
      const vm = new VerticalMemory({
        spaceName: "schema_test",
        allowedVariables: ["account_age_hours"],
      });

      await assert.rejects(
        () => vm.store("guard", "check", {}, "block", {
          indicators: [{ variable: "account_age_hours", weight: 1.5, condition: "< 24" }],
          threshold: 0.6,
        }),
        (err) => {
          assert.equal(err.code, "SCHEMA_VALIDATION_ERROR");
          assert.ok(err.message.includes("1.5"));
          console.log("  rejected weight 1.5 (must be 0-1)");
          return true;
        }
      );
    });

    it("accepts valid reasoning", async () => {
      const vm = new VerticalMemory({
        spaceName: "schema_test",
        allowedVariables: ["account_age_hours", "is_vpn"],
      });

      const entry = await vm.store("guard", "check", {}, "block", {
        indicators: [{ variable: "account_age_hours", weight: 0.5, condition: "< 24" }],
        compounds: [{ variables: ["account_age_hours", "is_vpn"], conditions: ["< 24", "true"], weight: 0.4 }],
        threshold: 0.6,
      });

      assert.ok(entry.id, "valid reasoning stored");
      console.log("  accepted valid reasoning with allowed vars");
    });

    it("allows any variables when allowedVariables is null", async () => {
      const vm = new VerticalMemory({ spaceName: "no_restrict" });

      const entry = await vm.store("guard", "check", {}, "block", {
        indicators: [{ variable: "anything_goes", weight: 0.5, condition: "true" }],
        threshold: 0.5,
      });
      assert.ok(entry.id);
      console.log("  no restriction mode: any variable accepted");
    });
  });

  // ======= LEVEL 1: Guardrails =======

  describe("Guardrails", () => {
    it("guardrail overrides block decision for VIP user", async () => {
      const vm = new VerticalMemory({ spaceName: "guardrail_test" });

      // Level 1: Never block accounts older than 1 year
      vm.addGuardrail((input, proposedDecision) => {
        if (input.account_age_hours > 8760 && proposedDecision === "block") {
          return "allow";
        }
        return null;
      });

      // Store a heuristic that would block VPN users
      await vm.store("guard", "check",
        { goal: "protect", bodies: { guard: { tools: { check: {} } } } },
        "block",
        {
          indicators: [{ variable: "is_vpn", weight: 0.8, condition: "true" }],
          threshold: 0.5,
        },
        { confidence: 1.0, source: "human" }
      );

      // VIP user on VPN: heuristic says BLOCK, guardrail says ALLOW
      const result = await vm.searchAndEvaluate(
        { goal: "protect", bodies: { guard: { tools: { check: {} } } } },
        { account_age_hours: 17520, is_vpn: true } // 2 year old account
      );

      assert.ok(result, "should have a result");
      assert.equal(result.decision, "allow", "guardrail overrides to ALLOW");
      assert.equal(result.guardrail_override, "guardrail_0");
      console.log("  VIP on VPN: heuristic=block, guardrail=allow. Final: ALLOW");
    });

    it("guardrail does NOT override when conditions not met", async () => {
      const vm = new VerticalMemory({ spaceName: "guardrail_test2" });

      vm.addGuardrail((input, proposedDecision) => {
        if (input.account_age_hours > 8760 && proposedDecision === "block") {
          return "allow";
        }
        return null;
      });

      await vm.store("guard", "check",
        { goal: "protect", bodies: { guard: { tools: { check: {} } } } },
        "block",
        {
          indicators: [{ variable: "is_vpn", weight: 0.8, condition: "true" }],
          threshold: 0.5,
        },
        { confidence: 1.0, source: "human" }
      );

      // New account on VPN: guardrail does NOT apply (age < 8760)
      const result = await vm.searchAndEvaluate(
        { goal: "protect", bodies: { guard: { tools: { check: {} } } } },
        { account_age_hours: 2, is_vpn: true }
      );

      assert.ok(result);
      assert.equal(result.decision, "block", "no guardrail override for new account");
      assert.equal(result.guardrail_override, null);
      console.log("  new account on VPN: guardrail not triggered. Final: BLOCK");
    });
  });

  // ======= LEVEL 3: Conflict Resolution =======

  describe("Conflict resolution", () => {
    it("highest confidence wins when two heuristics conflict", async () => {
      const vm = new VerticalMemory({ spaceName: "conflict_test" });
      const ws = { goal: "protect", bodies: { guard: { tools: { check: {} } } } };

      // March: block if VPN (confidence 0.6)
      await vm.store("guard", "check", ws, "block", {
        indicators: [{ variable: "is_vpn", weight: 0.8, condition: "true" }],
        threshold: 0.5,
      }, { confidence: 0.6, source: "brain" });

      // April: allow if has_2fa (confidence 0.9)
      await vm.store("guard", "check", ws, "allow", {
        indicators: [{ variable: "has_2fa", weight: 0.8, condition: "true" }],
        threshold: 0.5,
        decision: "allow",
      }, { confidence: 0.9, source: "human" });

      // User on VPN with 2FA: both heuristics trigger. Conflict.
      const result = await vm.searchAndEvaluate(ws, { is_vpn: true, has_2fa: true });

      assert.ok(result);
      assert.ok(result.conflict, "should detect conflict");
      assert.equal(result.conflict.total_passing, 2);
      // Higher confidence (0.9 human-approved ALLOW) should win
      assert.equal(result.decision, "allow", "higher confidence wins");
      console.log(`  conflict: block(0.6) vs allow(0.9). Winner: allow (higher confidence)`);
    });

    it("same confidence: most recent wins", async () => {
      const vm = new VerticalMemory({ spaceName: "recency_test" });
      const ws = { goal: "protect", bodies: { guard: { tools: { check: {} } } } };

      await vm.store("guard", "check", ws, "block", {
        indicators: [{ variable: "is_vpn", weight: 0.8, condition: "true" }],
        threshold: 0.5,
      }, { confidence: 0.7, source: "brain" });

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 10));

      await vm.store("guard", "check", ws, "allow", {
        indicators: [{ variable: "has_2fa", weight: 0.8, condition: "true" }],
        threshold: 0.5,
        decision: "allow",
      }, { confidence: 0.7, source: "brain" }); // SAME confidence

      const result = await vm.searchAndEvaluate(ws, { is_vpn: true, has_2fa: true });

      assert.ok(result);
      assert.ok(result.conflict);
      // Same confidence, newer wins
      assert.equal(result.decision, "allow", "more recent wins on tie");
      console.log("  same confidence (0.7): most recent wins");
    });
  });
});
