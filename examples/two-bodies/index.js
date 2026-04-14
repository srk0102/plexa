// Plexa -- two bodies, one brain.
// template adapter on port 8001 + MuJoCo cartpole on port 8002.
// One Ollama/stub brain coordinates both simultaneously.
//
// Run: node examples/two-bodies/index.js
// The MuJoCo window will open visibly while the template runs headless.

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

// Resolve a real Python interpreter, not the Microsoft Store stub.
function resolvePython() {
  if (process.platform !== "win32") return "python3";

  // 1. Try pyenv-win location
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const pyenvDir = path.join(home, ".pyenv", "pyenv-win", "versions");
  try {
    if (fs.existsSync(pyenvDir)) {
      const versions = fs.readdirSync(pyenvDir).sort().reverse();
      for (const v of versions) {
        const exe = path.join(pyenvDir, v, "python.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {}

  // 2. Try `py` launcher
  try {
    const r = spawnSync("py", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
    if (r.status === 0) {
      const p = r.stdout.trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {}

  // 3. Fallback
  return "python";
}
const { Space, BodyAdapter, Brain, OllamaBrain } = require("../..");
const { HTTPTransport } = require("scp-protocol");

const SPACE_PORT = 3000;
const TEMPLATE_PORT = 8001;
const CARTPOLE_PORT = 8002;

// -- Fallback stub brain (rotates sensible commands for both bodies) --

class StubBrain extends Brain {
  constructor() {
    super({ model: "stub" });
    this._counter = 0;
  }
  async _rawCall() {
    this._counter++;
    // Alternate between the two bodies so both visibly get commands
    const n = this._counter;
    if (n % 3 === 0) {
      return JSON.stringify({
        target_body: "template",
        action: ["move_to", "halt", "avoid"][Math.floor(Math.random() * 3)],
        parameters: { x: 0.3, y: 0 },
        priority: 3,
        fallback: "halt",
      });
    }
    // Cartpole: decide force direction based on rotation
    const dir = n % 2 === 0 ? "left" : "right";
    return JSON.stringify({
      target_body: "cartpole",
      action: "apply_force",
      parameters: { direction: dir, magnitude: 0.4 },
      priority: 4,
      fallback: "hold",
    });
  }
}

// -- Base body that shares one transport and filters by body name --

class SharedTransportBody extends BodyAdapter {
  constructor({ name, capabilities, transport, musclePort, musclePath }) {
    super({ name, capabilities, transport });
    this.musclePort = musclePort;
    this.musclePath = musclePath || "/";
  }

  async onConfigure() {
    await super.onConfigure();
    // Register listeners that filter by body name
    const types = [
      "entity_detected", "obstacle_too_close", "heartbeat",
      "pole_critical", "pole_warning", "cart_boundary", "state_update",
    ];
    for (const type of types) {
      this.transport.on(type, (msg) => {
        if (!msg || msg.body !== this.name) return;
        const priority = msg.priority || "NORMAL";
        this.emit(type, msg.payload || {}, priority);
        if (msg.state) this.setState(msg.state);
      });
    }
  }

  // Commands go DIRECTLY to the muscle's HTTP port, not via transport broadcast.
  async _scpCall(method, args) {
    const body = JSON.stringify({ type: "command", method, args, ts: Date.now() });
    return new Promise((resolve) => {
      const req = http.request({
        method: "POST", hostname: "localhost", port: this.musclePort,
        path: this.musclePath,
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
  console.log("[plexa] two-bodies demo starting\n");

  // 1. Start template muscle (headless, port 8001)
  const templateMuscle = spawn("node",
    [path.resolve(__dirname, "../../adapters/template/muscle.js")],
    {
      env: { ...process.env, SCP_PORT: String(TEMPLATE_PORT),
             SPACE_URL: `http://localhost:${SPACE_PORT}`, BODY_NAME: "template" },
      stdio: ["ignore", "inherit", "inherit"],
    }
  );

  // 2. Start cartpole muscle (MuJoCo viewer visible, port 8002)
  // On Windows, "python" may be the Microsoft Store stub. Resolve to real interpreter.
  const PYTHON = process.env.PYTHON || resolvePython();
  const cartpolePath = path.resolve(__dirname, "../../adapters/mujoco-cartpole/muscle.py");
  const cartpoleArgs = ["--managed"];
  if (!process.env.PLEXA_HEADLESS) cartpoleArgs.push("--view");
  console.log(`[plexa] python: ${PYTHON}`);
  const cartpoleMuscle = spawn(PYTHON, [cartpolePath, ...cartpoleArgs], {
    env: { ...process.env, SCP_PORT: String(CARTPOLE_PORT),
           SPACE_URL: `http://localhost:${SPACE_PORT}`, BODY_NAME: "cartpole" },
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Give both muscles time to start listening
  await new Promise((r) => setTimeout(r, 1500));

  // 3. Plexa HTTPTransport receives events from both muscles
  const transport = new HTTPTransport({ port: SPACE_PORT });
  await transport.start();

  // 4. Brain: Ollama if available, else stub
  let brain;
  const ollamaUp = await OllamaBrain.isAvailable();
  if (ollamaUp) {
    console.log("[plexa] ollama detected -- using llama3.2");
    brain = new OllamaBrain({ model: "llama3.2" });
  } else {
    console.log("[plexa] ollama not running -- using stub brain (alternates bodies)");
    brain = new StubBrain();
  }

  // 5. Space
  const space = new Space("two_bodies", {
    tickHz: 120,
    aggregateEveryTicks: 60,
    brainIntervalMs: 2000,
  });

  space.addBody(new SharedTransportBody({
    name: "template",
    capabilities: ["move_to", "halt", "avoid", "engage"],
    transport,
    musclePort: TEMPLATE_PORT,
  }));

  space.addBody(new SharedTransportBody({
    name: "cartpole",
    capabilities: ["apply_force", "reset", "hold"],
    transport,
    musclePort: CARTPOLE_PORT,
  }));

  space.setBrain(brain);
  space.setGoal("balance the pole while keeping template active");

  // Surface errors so we can see problems
  space.on("intent_error", (e) =>
    console.log(`[plexa] intent rejected: ${e.reason} -- ${e.error}`));
  space.on("brain_error", (e) =>
    console.log(`[plexa] brain error: ${e.message}`));
  space.on("body_event", (e) => {
    const tag = e.priority === "CRITICAL" ? " [CRITICAL]" : "";
    if (e.priority === "CRITICAL" || e.priority === "HIGH") {
      console.log(`[plexa] event${tag}: ${e.body} -> ${e.type}`);
    }
  });

  await space.run();

  for (const [name] of space.bodies) {
    console.log(`[plexa] body "${name}" connected (managed)`);
  }
  console.log("");

  // 6. Stats loop
  let loops = 0;
  const totalLoops = 10;

  const printer = setInterval(() => {
    loops++;
    const s = space.getStats();
    const tokens = s.aggregator.maxTokens;
    console.log(
      `  Loop ${String(loops).padStart(2)}: ` +
      `brain=${s.brainCalls} dispatched=${s.commandsDispatched} ` +
      `rejected=${s.commandsRejected} bodies=${s.bodies} tokens=${tokens}`
    );

    if (loops >= totalLoops) {
      clearInterval(printer);
      cleanup();
    }
  }, 3000);

  async function cleanup() {
    console.log("\n[plexa] shutting down...\n");
    await space.stop();
    await transport.stop();
    try { templateMuscle.kill(); } catch {}
    try { cartpoleMuscle.kill(); } catch {}

    const s = space.getStats();
    console.log("=== Final Stats ===");
    console.log(`  Bodies:                ${s.bodies}`);
    console.log(`  Brain calls:           ${s.brainCalls}`);
    console.log(`  Brain errors:          ${s.brainErrors}`);
    console.log(`  Commands dispatched:   ${s.commandsDispatched}`);
    console.log(`  Commands rejected:     ${s.commandsRejected}`);
    console.log(`  Aggregations:          ${s.aggregations}`);
    console.log(`  Reactor ticks:         ${s.tick}`);
    console.log(`  Max tokens:            ${s.aggregator.maxTokens}`);
    console.log(`  Events dropped:        ${s.aggregator.droppedEvents}`);
    console.log(`  Dropped by priority:   ${JSON.stringify(s.aggregator.droppedByPriority)}`);
    console.log(`  Translator rejects:    ${JSON.stringify(s.translator.byReason)}`);
    if (s.brain && typeof s.brain.avgCallMs === "number")
      console.log(`  Avg brain call:        ${s.brain.avgCallMs}ms`);

    process.exit(0);
  }
}

main().catch((e) => {
  console.error("[plexa] fatal:", e);
  process.exit(1);
});
