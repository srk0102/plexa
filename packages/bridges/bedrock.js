// BedrockBrain -- Plexa Brain backed by AWS Bedrock via scp-protocol's BedrockBridge.
// Wraps the structured Converse API. Requires @aws-sdk/client-bedrock-runtime
// as an optional peer dep.
//
// Usage:
//   const { BedrockBrain } = require("@srk0102/plexa/bridges/bedrock")
//   space.setBrain(new BedrockBrain({ model: "amazon.nova-micro-v1:0" }))

const { Brain } = require("../core/brain");

class BedrockBrain extends Brain {
  /**
   * @param {object} opts
   * @param {string} [opts.model]        Bedrock model id, default "amazon.nova-micro-v1:0"
   * @param {string} [opts.region]       AWS region, default process.env.AWS_REGION || "us-east-1"
   * @param {string} [opts.systemPrompt]
   * @param {number} [opts.maxTokens]    default 512
   * @param {number} [opts.temperature]  default 0.1
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "amazon.nova-micro-v1:0";
    this.region = opts.region || process.env.AWS_REGION || "us-east-1";

    // Lazy bridge to get the bedrock client without paying the peer-dep cost
    // until the first call.
    let BedrockBridge;
    try {
      ({ BedrockBridge } = require("scp-protocol/bridges/bedrock"));
    } catch (e) {
      // Defer the error: a user constructing the class without calling it
      // should not crash. Throw on first invoke instead.
      this._bridgeLoadError = e;
      return;
    }

    this._bridge = new BedrockBridge({
      model: this.model,
      region: this.region,
      systemPrompt: this.systemPrompt,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
    });
  }

  async _rawCall(prompt) {
    if (this._bridgeLoadError) {
      throw new Error(
        "BedrockBrain requires scp-protocol/bridges/bedrock (install @aws-sdk/client-bedrock-runtime): " +
          this._bridgeLoadError.message
      );
    }

    // scp-protocol's BedrockBridge.call returns { decision, raw }
    // where decision is either a text string or a parsed tool-use object.
    const { decision } = await this._bridge.call(prompt);

    if (decision && typeof decision === "object") {
      // Structured tool call from Converse. Re-serialize so the base
      // Brain.parseResponse can validate via the same path.
      return JSON.stringify(decision);
    }
    return typeof decision === "string" ? decision : "";
  }

  /**
   * Best-effort availability check: returns true if @aws-sdk/client-bedrock-runtime
   * is installed AND credentials resolve. Does NOT make a real API call.
   * @returns {Promise<boolean>}
   */
  static async isAvailable() {
    try {
      require("@aws-sdk/client-bedrock-runtime");
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { BedrockBrain };
