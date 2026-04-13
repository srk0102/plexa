// Project G -- hello world
//
// Starts the template SCP muscle as a subprocess, connects it via
// HTTPTransport, wires an OllamaBrain, and runs the Space.
//
// If Ollama is not available, falls back to a stub brain so the demo
// still runs end-to-end.

const { spawn } = require("node:child_process");
const path = require("node:path");
const { Space, BodyAdapter, Brain, OllamaBrain } = require("../..");
const { HTTPTransport } = require("scp-protocol");

const SPACE_PORT = 3000;
const MUSCLE_PORT = 8001;

// -- Fallback stub brain (used if Ollama is not running) --

class StubBrain extends Brain {
  constructor() {
    super({ model: "stub" });
    this._counter = 0;
  }
  async _rawCall(prompt) {
    // Rotate through a few reasonable actions
    const actions = ["move_to", "halt", "avoid", "engage"];
    const action = actions[this._counter++ % actions.length];
    return JSON.stringify({
      target_body: "cartpole",
      action,
      parameters: action === "move_to" ? { x: 0.5, y: 0 } : {},
      priority: 3,
      fallback: "halt",
    });
  }
}

// -- BodyAdapter that speaks to the template muscle over HTTP --

class TemplateBody extends BodyAdapter {
  constructor({ transport, musclePort }) {
    super({
      name: "cartpole",
      capabilities: ["move_to", "halt", "avoid", "engage"],
      transport,
    });
    this.musclePort = musclePort;
    this.lastHeartbeatTick = 0;
  }

  async onConfigure() {
    await super.onConfigure();

    // When the transport receives events from the muscle, push them up.
    this.transport.on("entity_detected", (msg) => {
      this.emit("entity_detected", msg.payload || {});
      if (msg.state) this.setState({ last_entity: (msg.payload || {}).kind });
    });

    this.transport.on("obstacle_too_close", () => {
      this.emit("obstacle_too_close", {});
    });

    this.transport.on("heartbeat", (msg) => {
      if (msg.payload) this.setState({ heartbeat: msg.payload });
    });
  }

  // Override to POST commands directly to the muscle (not via transport broadcast)
  async _scpCall(method, args) {
    const http = require("node:http");
    const body = JSON.stringify({ type: "command", method, args, ts: Date.now() });
    return new Promise((resolve) => {
      const req = http.request({
        method: "POST",
        hostname: "localhost",
        port: this.musclePort,
        path: "/",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 500,
      }, (res) => { res.on("data", () => {}); res.on("end", () => resolve({ ok: true })); });
      req.on("error", () => resolve({ ok: false }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
      req.write(body);
      req.end();
    });
  }
}

// -- Main --

async function main() {
  console.log("[project-g] hello-world starting\n");

  // 1. Start the template muscle as a subprocess
  const musclePath = path.resolve(__dirname, "../../adapters/template/muscle.js");
  const muscle = spawn("node", [musclePath], {
    env: {
      ...process.env,
      SCP_PORT: String(MUSCLE_PORT),
      SPACE_URL: `http://localhost:${SPACE_PORT}`,
      BODY_NAME: "cartpole",
    },
    stdio: "inherit",
  });

  // Give the muscle time to start listening
  await new Promise((r) => setTimeout(r, 800));

  // 2. HTTPTransport receives events from the muscle
  const transport = new HTTPTransport({ port: SPACE_PORT });
  await transport.start();

  // 3. Pick a brain (Ollama if running, else stub)
  let brain;
  const ollamaUp = await OllamaBrain.isAvailable();
  if (ollamaUp) {
    console.log("[project-g] ollama detected -- using llama3.2");
    brain = new OllamaBrain({ model: "llama3.2" });
  } else {
    console.log("[project-g] ollama not running -- using stub brain (rotates actions)");
    brain = new StubBrain();
  }

  // 4. Assemble the Space
  const space = new Space("hello_world", {
    tickHz: 120,
    aggregateEveryTicks: 60,  // aggregate every 500ms
    brainIntervalMs: 2000,    // brain call every 2s max
  });

  space.addBody(new TemplateBody({ transport, musclePort: MUSCLE_PORT }));
  space.setBrain(brain);
  space.setGoal("stay safe and explore the environment");

  space.on("intent_error", (e) => {
    console.log(`[space] intent rejected: ${e.reason} -- ${e.error}`);
  });
  space.on("brain_error", (e) => {
    console.log(`[space] brain error: ${e.message}`);
  });

  // 5. Run it
  await space.run();

  console.log(`\n[project-g] space running at ${SPACE_PORT}Hz\n`);

  // Print stats every 3 seconds for 15 seconds total
  let loops = 0;
  const totalLoops = 5;
  const statsInterval = setInterval(() => {
    loops++;
    const s = space.getStats();
    console.log(
      `  Loop ${loops}: brain=${s.brainCalls}  dispatched=${s.commandsDispatched}  ` +
      `rejected=${s.commandsRejected}  errors=${s.brainErrors}  ` +
      `agg=${s.aggregations}`
    );

    if (loops >= totalLoops) {
      clearInterval(statsInterval);
      cleanup();
    }
  }, 3000);

  async function cleanup() {
    console.log("\n[project-g] shutting down...\n");
    await space.stop();
    await transport.stop();
    muscle.kill();

    const s = space.getStats();
    console.log("=== Final Stats ===");
    console.log(`  Brain calls:         ${s.brainCalls}`);
    console.log(`  Brain errors:        ${s.brainErrors}`);
    console.log(`  Commands dispatched: ${s.commandsDispatched}`);
    console.log(`  Commands rejected:   ${s.commandsRejected}`);
    console.log(`  Aggregations:        ${s.aggregations}`);
    console.log(`  Reactor ticks:       ${s.tick}`);
    console.log(`  Translator rejects:  ${JSON.stringify(s.translator.byReason)}`);
    console.log(`  Aggregator max tok:  ${s.aggregator.maxTokens}`);
    if (s.brain) console.log(`  Avg brain call:      ${s.brain.avgCallMs}ms`);

    process.exit(0);
  }
}

main().catch((e) => {
  console.error("[project-g] fatal:", e);
  process.exit(1);
});
