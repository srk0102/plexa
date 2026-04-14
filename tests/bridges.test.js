const { describe, test } = require("node:test");
const assert = require("node:assert");

const { BedrockBrain } = require("../packages/bridges/bedrock");
const { AnthropicBrain } = require("../packages/bridges/anthropic");

// ============================================================
// BedrockBrain
// ============================================================

describe("BedrockBrain", () => {
  test("constructs with defaults", () => {
    const b = new BedrockBrain();
    assert.strictEqual(b.model, "amazon.nova-micro-v1:0");
    assert.strictEqual(typeof b.region, "string");
  });

  test("accepts custom model and region", () => {
    const b = new BedrockBrain({ model: "anthropic.claude-3-5-sonnet-20241022-v2:0", region: "us-west-2" });
    assert.strictEqual(b.model, "anthropic.claude-3-5-sonnet-20241022-v2:0");
    assert.strictEqual(b.region, "us-west-2");
  });

  test("isAvailable returns a boolean", async () => {
    const v = await BedrockBrain.isAvailable();
    assert.strictEqual(typeof v, "boolean");
  });

  test("_rawCall throws a clear error when @aws-sdk missing or call fails", async () => {
    const b = new BedrockBrain();
    // Either the peer dep is absent (bridgeLoadError) or the call will fail
    // because no real credentials/network are available. Either way we expect
    // an Error, never a silent success.
    await assert.rejects(() => b._rawCall({ bodies: {} }));
  });
});

// ============================================================
// AnthropicBrain
// ============================================================

describe("AnthropicBrain", () => {
  test("constructs with defaults", () => {
    const b = new AnthropicBrain({ apiKey: "sk-test" });
    assert.strictEqual(b.model, "claude-haiku-4-5-20251001");
    assert.strictEqual(b.host, "api.anthropic.com");
    assert.strictEqual(b.path, "/v1/messages");
    assert.strictEqual(b.version, "2023-06-01");
    assert.strictEqual(b.apiKey, "sk-test");
  });

  test("picks apiKey from env when not passed", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-from-env";
    try {
      const b = new AnthropicBrain();
      assert.strictEqual(b.apiKey, "sk-from-env");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("_rawCall throws when apiKey missing", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const b = new AnthropicBrain();
      await assert.rejects(() => b._rawCall("hi"), /missing apiKey/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test("isAvailable reflects env var presence", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    assert.strictEqual(AnthropicBrain.isAvailable(), false);
    process.env.ANTHROPIC_API_KEY = "sk-any";
    assert.strictEqual(AnthropicBrain.isAvailable(), true);
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });
});
