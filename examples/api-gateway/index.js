// Plexa example: API gateway as an SCP body.
// Simulated request patterns, no real gateway required. Shows brain calls
// dropping to zero as traffic patterns cache.
//
// Run:
//   node examples/api-gateway/index.js

const { Space, BodyAdapter, Brain } = require("../..");
const { OllamaBrain } = require("../../packages/bridges/ollama");
const { PatternStore } = require("scp-protocol");

// -- Simulated traffic patterns --

class TrafficShapes {
  constructor() { this.tick = 0; }
  next() {
    this.tick++;
    const situations = [
      { kind: "rate_limit_breach",  client: "client-123", rpm: 2400, limit: 1000 },
      { kind: "suspicious_pattern", client: "client-987", entropy: 0.2, repeats: 50 },
      { kind: "downstream_slow",    upstream: "payments",  p95: 4200, baseline: 300 },
      { kind: "circuit_open",       upstream: "shipping",  failures: 8, window: 10 },
    ];
    return situations[this.tick % situations.length];
  }
}

// -- Body --

class ApiGatewayBody extends BodyAdapter {
  static bodyName = "api_gateway";
  static tools = {
    block_client:        { description: "block a client",               parameters: { client: { type: "string", required: true }, minutes: { type: "number", min: 1, max: 1440, required: true } } },
    throttle_client:     { description: "throttle a client",            parameters: { client: { type: "string", required: true }, rpm: { type: "number", min: 1, required: true } } },
    switch_to_fallback:  { description: "switch upstream to fallback",  parameters: { upstream: { type: "string", required: true } } },
    open_circuit:        { description: "open the circuit breaker",    parameters: { upstream: { type: "string", required: true }, seconds: { type: "number", min: 1, max: 600, required: true } } },
  };

  constructor() {
    super();
    this.shapes = new TrafficShapes();
    this.event = null;
    this.patternStore = new PatternStore({
      featureExtractor: (e) => ({
        kind: e.kind,
        target: e.client || e.upstream || "",
      }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
    });
  }

  async block_client({ client, minutes })       { return { blocked: client, minutes }; }
  async throttle_client({ client, rpm })        { return { throttled: client, rpm }; }
  async switch_to_fallback({ upstream })        { return { fallback: upstream }; }
  async open_circuit({ upstream, seconds })     { return { circuit: upstream, seconds }; }

  async sampleAndEmit() {
    const e = this.shapes.next();
    this.event = e;
    this.setState({ ...e });
    const priority = e.kind === "suspicious_pattern" ? "CRITICAL" : "HIGH";
    this.emit(e.kind, e, priority);
    console.log(`[scp] event [${priority}] ${e.kind} ${JSON.stringify({ target: e.client || e.upstream })}`);
    return e;
  }
}

// -- Stub brain --

class StubBrain extends Brain {
  constructor() { super({ model: "stub" }); }
  async _rawCall(prompt) {
    if (prompt.includes("suspicious_pattern")) {
      return JSON.stringify({ target_body: "api_gateway", tool: "block_client", parameters: { client: "client-987", minutes: 60 } });
    }
    if (prompt.includes("rate_limit_breach")) {
      return JSON.stringify({ target_body: "api_gateway", tool: "throttle_client", parameters: { client: "client-123", rpm: 500 } });
    }
    if (prompt.includes("downstream_slow")) {
      return JSON.stringify({ target_body: "api_gateway", tool: "switch_to_fallback", parameters: { upstream: "payments" } });
    }
    if (prompt.includes("circuit_open")) {
      return JSON.stringify({ target_body: "api_gateway", tool: "open_circuit", parameters: { upstream: "shipping", seconds: 30 } });
    }
    return JSON.stringify({ target_body: "api_gateway", tool: "throttle_client", parameters: { client: "*", rpm: 1000 } });
  }
}

// -- Main --

async function main() {
  console.log("[scp] api-gateway starting");

  const space = new Space("gateway_ops", { tickHz: 1000 });
  const body = new ApiGatewayBody();
  space.addBody(body);

  const ollamaUp = await OllamaBrain.isAvailable();
  const brain = ollamaUp ? new OllamaBrain({ model: "llama3.2", maxTokens: 80 }) : new StubBrain();
  space.setBrain(brain);
  space.setGoal("protect upstreams, punish abuse, fall back before failure");

  let brainCalls = 0;
  let cacheHits  = 0;
  const costPerCall = ollamaUp ? 0 : 0.00013 * 0.4;

  for (let loop = 1; loop <= 5; loop++) {
    for (let k = 0; k < 4; k++) {
      const e = await body.sampleAndEmit();
      const cached = body.patternStore.lookup(e);
      if (cached) {
        cacheHits++;
        await body.invokeTool(cached.decision.tool, cached.decision.parameters);
        console.log(`[scp] cache hit -> ${cached.decision.tool} (0.2ms $0)`);
      } else {
        const t0 = Date.now();
        const intent = await brain.invoke({
          bodies: { api_gateway: {
            status: "active",
            event_type: e.kind,
            ...e,
            pending_events: [{ type: e.kind, priority: "HIGH" }],
            tools: ApiGatewayBody.tools,
          } },
          active_goal: space.activeGoal || "",
          recent_history: [],
        });
        const dt = Date.now() - t0;
        if (intent && intent.tool) {
          brainCalls++;
          body.patternStore.learn(e, { tool: intent.tool, parameters: intent.parameters });
          await body.invokeTool(intent.tool, intent.parameters);
          console.log(`[scp] brain call -> ${intent.tool} ${JSON.stringify(intent.parameters)} (${dt}ms)`);
        }
      }
    }
    const cost = (brainCalls * costPerCall).toFixed(6);
    console.log(`Loop ${loop}: brain=${brainCalls} cache=${cacheHits} cost=$${cost}`);
  }

  console.log("[scp] brain silent. patterns learned.");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
