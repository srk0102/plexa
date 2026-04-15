// Plexa example: log stream as an SCP body.
// Simulated log events, no real log source required. Shows brain going
// silent as recurring patterns cache.
//
// Run:
//   node examples/log-monitor/index.js

const { Space, BodyAdapter, Brain } = require("../..");
const { OllamaBrain } = require("../../packages/bridges/ollama");
const { PatternStore } = require("scp-protocol");

// -- Simulated log events --

class LogStream {
  constructor() { this.tick = 0; }
  next() {
    this.tick++;
    const situations = [
      { kind: "error_pattern",     service: "checkout", rate: 12, trend: "spiking" },
      { kind: "perf_degradation",  service: "search",   p95: 3400, trend: "worsening" },
      { kind: "security_anomaly",  service: "auth",     source: "unknown_ip", attempts: 40 },
    ];
    return situations[this.tick % situations.length];
  }
}

// -- Body --

class LogMonitorBody extends BodyAdapter {
  static bodyName = "log_monitor";
  static tools = {
    create_ticket:       { description: "open an engineering ticket", parameters: { title: { type: "string", required: true }, severity: { type: "string", enum: ["p1", "p2", "p3"], required: true } } },
    page_oncall:         { description: "page on-call",               parameters: { severity: { type: "string", enum: ["high", "critical"], required: true } } },
    rollback_deployment: { description: "roll back last release",     parameters: { service: { type: "string", required: true } } },
    silence_alert:       { description: "silence noisy alert",        parameters: { minutes: { type: "number", min: 1, max: 180, required: true } } },
  };

  constructor() {
    super();
    this.stream = new LogStream();
    this.event = null;
    this.patternStore = new PatternStore({
      featureExtractor: (e) => ({
        kind: e.kind,
        service: e.service,
        trend: e.trend || (e.source === "unknown_ip" ? "attack" : "normal"),
      }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
    });
  }

  async create_ticket({ title, severity })  { return { ticket: title, severity }; }
  async page_oncall({ severity })           { return { paged: severity }; }
  async rollback_deployment({ service })    { return { rolled_back: service }; }
  async silence_alert({ minutes })          { return { silenced: minutes }; }

  async sampleAndEmit() {
    const e = this.stream.next();
    this.event = e;
    this.setState({ ...e });
    const priority = e.kind === "security_anomaly" ? "CRITICAL" : "HIGH";
    this.emit(e.kind, e, priority);
    console.log(`[scp] event [${priority}] ${e.kind} ${JSON.stringify({ service: e.service })}`);
    return e;
  }
}

// -- Stub brain --

class StubBrain extends Brain {
  constructor() { super({ model: "stub" }); }
  async _rawCall(prompt) {
    if (prompt.includes("security_anomaly")) {
      return JSON.stringify({ target_body: "log_monitor", tool: "page_oncall", parameters: { severity: "critical" } });
    }
    if (prompt.includes("perf_degradation")) {
      return JSON.stringify({ target_body: "log_monitor", tool: "create_ticket", parameters: { title: "p95 latency regression", severity: "p2" } });
    }
    if (prompt.includes("error_pattern")) {
      return JSON.stringify({ target_body: "log_monitor", tool: "rollback_deployment", parameters: { service: "checkout" } });
    }
    return JSON.stringify({ target_body: "log_monitor", tool: "silence_alert", parameters: { minutes: 30 } });
  }
}

// -- Main --

async function main() {
  console.log("[scp] log-monitor starting");

  const space = new Space("log_ops", { tickHz: 1000 });
  const body = new LogMonitorBody();
  space.addBody(body);

  const ollamaUp = await OllamaBrain.isAvailable();
  const brain = ollamaUp ? new OllamaBrain({ model: "llama3.2", maxTokens: 80 }) : new StubBrain();
  space.setBrain(brain);
  space.setGoal("escalate real incidents, silence noise, roll back bad releases");

  let brainCalls = 0;
  let cacheHits  = 0;
  const costPerCall = ollamaUp ? 0 : 0.00013 * 0.4;

  for (let loop = 1; loop <= 5; loop++) {
    for (let k = 0; k < 3; k++) {
      const e = await body.sampleAndEmit();
      const cached = body.patternStore.lookup(e);
      if (cached) {
        cacheHits++;
        await body.invokeTool(cached.decision.tool, cached.decision.parameters);
        console.log(`[scp] cache hit -> ${cached.decision.tool} (0.2ms $0)`);
      } else {
        const t0 = Date.now();
        const intent = await brain.invoke({
          bodies: { log_monitor: {
            status: "active",
            event_type: e.kind,
            ...e,
            pending_events: [{ type: e.kind, priority: "HIGH" }],
            tools: LogMonitorBody.tools,
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
