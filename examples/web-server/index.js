// Plexa example: web server metrics as an SCP body.
// Zero dependencies beyond plexa + scp-protocol. No real server required;
// metrics are simulated. Shows brain calls going to zero as patterns cache.
//
// Run:
//   node examples/web-server/index.js

const { Space, BodyAdapter, Brain } = require("../..");
const { OllamaBrain } = require("../../packages/bridges/ollama");
const { PatternStore } = require("scp-protocol");

// -- Simulated metrics source --

class MetricsSource {
  constructor() { this.tick = 0; }
  next() {
    this.tick++;
    // Each loop fires one of a small menu of situations so the cache can learn.
    const situations = [
      { errorRate: 0.08, p99: 850,  rps: 1200, baselineRps: 1000 }, // error_spike
      { errorRate: 0.01, p99: 2600, rps: 1100, baselineRps: 1000 }, // slow_request
      { errorRate: 0.02, p99: 800,  rps: 3400, baselineRps: 1000 }, // unusual_traffic
    ];
    return situations[this.tick % situations.length];
  }
}

// -- Body --

class WebServerBody extends BodyAdapter {
  static bodyName = "web_server";
  static tools = {
    scale_up:        { description: "add capacity",    parameters: { factor: { type: "number", min: 1, max: 10, required: true } } },
    rate_limit:      { description: "throttle",        parameters: { requestsPerMinute: { type: "number", min: 1, required: true } } },
    alert_team:      { description: "page on-call",    parameters: { severity: { type: "string", enum: ["low", "high", "critical"], required: true } } },
    restart_worker:  { description: "restart worker",  parameters: { workerId: { type: "string", required: true } } },
  };

  constructor() {
    super();
    this.source = new MetricsSource();
    this.metrics = null;
    this.patternStore = new PatternStore({
      featureExtractor: (m) => ({
        err: m.errorRate > 0.05 ? "high" : "low",
        lat: m.p99 > 2000 ? "slow" : "ok",
        traf: m.rps > m.baselineRps * 2 ? "spike" : "normal",
      }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
    });
  }

  // Tools
  async scale_up({ factor })              { return { scaled: factor }; }
  async rate_limit({ requestsPerMinute }) { return { limited: requestsPerMinute }; }
  async alert_team({ severity })          { return { alerted: severity }; }
  async restart_worker({ workerId })      { return { restarted: workerId }; }

  async sampleAndEmit() {
    this.metrics = this.source.next();
    this.setState({ ...this.metrics });
    const m = this.metrics;
    if (m.errorRate > 0.05) {
      this.emit("error_spike", { rate: m.errorRate }, "CRITICAL");
      console.log(`[scp] event [CRITICAL] error_spike {"rate":${m.errorRate}}`);
    } else if (m.p99 > 2000) {
      this.emit("slow_request", { p99: m.p99 }, "HIGH");
      console.log(`[scp] event [HIGH] slow_request {"p99":${m.p99}}`);
    } else if (m.rps > m.baselineRps * 2) {
      this.emit("unusual_traffic", { rps: m.rps }, "HIGH");
      console.log(`[scp] event [HIGH] unusual_traffic {"rps":${m.rps}}`);
    }
    return m;
  }
}

// -- Stub brain: maps situation -> sensible tool --

class StubBrain extends Brain {
  constructor() { super({ model: "stub" }); }
  async _rawCall(prompt) {
    const p = prompt.toLowerCase();
    if (p.includes("error_spike")) {
      return JSON.stringify({ target_body: "web_server", tool: "scale_up", parameters: { factor: 2 } });
    }
    if (p.includes("slow_request")) {
      return JSON.stringify({ target_body: "web_server", tool: "rate_limit", parameters: { requestsPerMinute: 300 } });
    }
    if (p.includes("unusual_traffic")) {
      return JSON.stringify({ target_body: "web_server", tool: "alert_team", parameters: { severity: "high" } });
    }
    return JSON.stringify({ target_body: "web_server", tool: "restart_worker", parameters: { workerId: "w1" } });
  }
}

// -- Main --

async function main() {
  console.log("[scp] web-server starting");

  const space = new Space("web_ops", { tickHz: 1000 });
  const body = new WebServerBody();
  space.addBody(body);

  const ollamaUp = await OllamaBrain.isAvailable();
  const brain = ollamaUp ? new OllamaBrain({ model: "llama3.2", maxTokens: 80 }) : new StubBrain();
  space.setBrain(brain);
  space.setGoal("keep error rate < 5%, p99 < 2s, traffic within 2x baseline");

  let brainCalls = 0;
  let cacheHits  = 0;
  const costPerCall = ollamaUp ? 0 : 0.00013 * 0.4; // ~400 tokens, Nova-equivalent for illustration

  for (let loop = 1; loop <= 5; loop++) {
    // Three situations per loop.
    for (let k = 0; k < 3; k++) {
      const m = await body.sampleAndEmit();
      const cached = body.patternStore.lookup(m);
      if (cached) {
        cacheHits++;
        await body.invokeTool(cached.decision.tool, cached.decision.parameters);
        console.log(`[scp] cache hit -> ${cached.decision.tool} (0.3ms $0)`);
      } else {
        const t0 = Date.now();
        const eventName = m.errorRate > 0.05 ? "error_spike"
                         : m.p99 > 2000       ? "slow_request"
                         : "unusual_traffic";
        const intent = await brain.invoke({
          bodies: { web_server: {
            status: "active",
            event_type: eventName,
            ...m,
            pending_events: [{ type: eventName, priority: "HIGH" }],
            tools: WebServerBody.tools,
          } },
          active_goal: space.activeGoal || "",
          recent_history: [],
        });
        const dt = Date.now() - t0;
        if (intent && intent.tool) {
          brainCalls++;
          body.patternStore.learn(m, { tool: intent.tool, parameters: intent.parameters });
          await body.invokeTool(intent.tool, intent.parameters);
          console.log(`[scp] brain call -> ${intent.tool} ${JSON.stringify(intent.parameters)} (${dt}ms)`);
        }
      }
    }
    const cost = (brainCalls * costPerCall).toFixed(6);
    console.log(`Loop ${loop}: brain=${brainCalls} cache=${cacheHits} cost=$${cost}`);
  }

  if (brainCalls > 0 && cacheHits >= brainCalls * 2) {
    console.log("[scp] brain silent. patterns learned.");
  } else if (brainCalls === 0) {
    console.log("[scp] brain silent. patterns learned.");
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
