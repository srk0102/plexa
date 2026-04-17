#!/usr/bin/env node
// ============================================================
// Fraud Detector -- SCP + Plexa in 50 lines.
//
// Demonstrates:
//   1. Brain teaches reasoning (not answers) on first request
//   2. Vertical memory evaluates per-case on subsequent requests
//   3. Attacker blocked. Innocent user allowed. Same reasoning.
//   4. Brain called ONCE. Everything else is CPU math.
//
// Run:   node examples/fraud-detector/index.js
// ============================================================

const { Space } = require("../../packages/core/space");
const { VerticalMemory } = require("../../packages/core/vertical-memory");
const { Brain } = require("../../packages/core/brain");
const { BodyAdapter } = require("../../packages/core/body-adapter");

// -- A simple body that guards an API endpoint --
class APIGuard extends BodyAdapter {
  static tools = {
    check: {
      description: "Evaluate an incoming API request",
      parameters: { signals: { type: "object" } },
    },
  };
  constructor() { super({ name: "api_guard" }); }
  async check({ signals }) {
    console.log("  [body] checking request with signals:", signals);
    return { checked: true };
  }
}

// -- A fake brain that returns reasoning JSON directly --
// In production, swap this for OllamaBrain, OpenAIBrain, etc.
class MockBrain extends Brain {
  constructor() { super({ model: "mock" }); this.calls = 0; }
  async _rawCall(prompt) {
    this.calls++;
    console.log(`  [brain] call #${this.calls} - generating reasoning...`);
    // This is what a real LLM would return when asked for reasoning.
    return JSON.stringify({
      target_body: "api_guard",
      tool: "check",
      parameters: { signals: {} },
      // The reasoning that gets stored in vertical memory:
      _reasoning: {
        decision: "block",
        indicators: [
          { variable: "account_age_hours", weight: 0.3, condition: "< 24" },
          { variable: "requests_per_hour", weight: 0.3, condition: "> 10", fuzzy: true },
          { variable: "has_2fa", weight: 0.2, condition: "false" },
          { variable: "is_vpn", weight: 0.2, condition: "true" },
        ],
        compounds: [
          { variables: ["account_age_hours", "is_vpn"], conditions: ["< 24", "true"], weight: 0.4, all: true },
        ],
        threshold: 0.6,
        explanation: "New account + high velocity + weak security = credential stuffing",
      },
    });
  }
}

async function main() {
  console.log("=== Fraud Detector (SCP + Plexa) ===\n");

  // Setup: Space + Body + Brain + Vertical Memory
  const memory = new VerticalMemory({
    spaceName: "fraud_demo",
    allowedVariables: ["account_age_hours", "requests_per_hour", "has_2fa", "is_vpn"],
  });

  // Level 1 guardrail: never block accounts older than 1 year
  memory.addGuardrail((input, proposedDecision) => {
    if (input.account_age_hours > 8760 && proposedDecision === "block") {
      return "allow";
    }
    return null;
  });

  const brain = new MockBrain();

  const space = new Space("fraud_detector", {
    verticalMemory: memory,
    inputExtractor: (worldState) => worldState._currentInput || {},
  });
  space.addBody(new APIGuard());
  space.setBrain(brain);

  // Store reasoning directly (simulating what brain would teach)
  console.log("Step 1: Brain teaches reasoning (ONE call)");
  const reasoning = {
    decision: "block",
    indicators: [
      { variable: "account_age_hours", weight: 0.3, condition: "< 24" },
      { variable: "requests_per_hour", weight: 0.3, condition: "> 10", fuzzy: true },
      { variable: "has_2fa", weight: 0.2, condition: "false" },
      { variable: "is_vpn", weight: 0.2, condition: "true" },
    ],
    compounds: [
      { variables: ["account_age_hours", "is_vpn"], conditions: ["< 24", "true"], weight: 0.4, all: true },
    ],
    threshold: 0.6,
    explanation: "New account + high velocity + weak security = credential stuffing",
  };

  await memory.store(
    "api_guard", "check",
    { goal: "protect_api", bodies: { api_guard: { tools: { check: {} } } } },
    "block", reasoning,
    { confidence: 0.9, source: "brain" }
  );
  console.log("  Reasoning stored. Brain done.\n");

  // -- Now evaluate 4 different people using ZERO brain calls --

  const testCases = [
    {
      label: "Attacker (new account, VPN, high velocity, no 2FA)",
      input: { account_age_hours: 2, requests_per_hour: 50, has_2fa: false, is_vpn: true },
      expected: "BLOCK",
    },
    {
      label: "Legitimate user (6 month account, low velocity, has 2FA)",
      input: { account_age_hours: 4320, requests_per_hour: 3, has_2fa: true, is_vpn: false },
      expected: "ALLOW",
    },
    {
      label: "New user with 2FA (12 hours old, normal usage)",
      input: { account_age_hours: 12, requests_per_hour: 5, has_2fa: true, is_vpn: false },
      expected: "ALLOW",
    },
    {
      label: "VIP on vacation VPN (1 year account, VPN)",
      input: { account_age_hours: 9000, requests_per_hour: 2, has_2fa: true, is_vpn: true },
      expected: "ALLOW (guardrail)",
    },
  ];

  console.log("Step 2: Evaluate 4 requests (ZERO brain calls)\n");

  for (const tc of testCases) {
    const result = memory.evaluate(tc.input, reasoning);
    const { decision: final, overriddenBy } = memory._applyGuardrails(
      tc.input,
      result.passes ? "block" : "allow",
      result.score
    );

    const matched = result.matched
      .map((m) => m.type === "compound"
        ? `COMPOUND(${m.variables.join("+")}):${m.weight}`
        : `${m.variable}=${m.value}:${m.weight}`)
      .join(", ") || "none";

    console.log(`  ${tc.label}`);
    console.log(`    score: ${result.score} / ${reasoning.threshold}`);
    console.log(`    matched: ${matched}`);
    console.log(`    decision: ${final.toUpperCase()}${overriddenBy ? ` (overridden by ${overriddenBy})` : ""}`);
    console.log(`    expected: ${tc.expected}`);
    console.log();
  }

  console.log(`Brain calls total: ${brain.calls}`);
  console.log("Evaluations total: 4");
  console.log("Cost: $0 (all evaluations are CPU math on stored reasoning)");
  console.log();
  console.log("=== Done ===");
}

main().catch(console.error);
