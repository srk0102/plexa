// Plexa -- hello world (in-process, zero HTTP).
//
// Minimal single-body demo. A GreeterBody with one tool, ticked by Plexa at 60fps.
// If Ollama is available it drives the brain; otherwise a stub brain rotates actions.
//
// Run: node examples/hello-world/index.js

const { Space, BodyAdapter, Brain } = require("../..");
const { OllamaBrain } = require("../../packages/bridges/ollama");

// -- A tiny body with two tools --

class GreeterBody extends BodyAdapter {
  static bodyName = "greeter";

  static tools = {
    say_hello: {
      description: "Emit a hello message with a given name",
      parameters: {
        name: { type: "string", required: true },
      },
    },
    wave: {
      description: "Wave (no parameters)",
      parameters: {},
    },
  };

  constructor() {
    super();
    this.greetings = 0;
    this.waves = 0;
  }

  async say_hello({ name }) {
    this.greetings++;
    this.setState({ last_greeting: name, greetings: this.greetings });
    this.emit("hello_said", { name }, "NORMAL");
    return { ok: true, greeted: name };
  }

  async wave() {
    this.waves++;
    this.setState({ waves: this.waves });
    return { ok: true };
  }

  async tick() {
    await super.tick();
    // Periodic heartbeat so the aggregator always has something to show
    if (this._tickCount === undefined) this._tickCount = 0;
    this._tickCount++;
    if (this._tickCount % 120 === 0) {
      this.emit("heartbeat", { tick: this._tickCount }, "LOW");
    }
  }
}

// -- Stub brain (rotates between the two tools) --

class StubBrain extends Brain {
  constructor() { super({ model: "stub" }); this._i = 0; }
  async _rawCall() {
    this._i++;
    const names = ["world", "plexa", "srk", "friend"];
    const useHello = this._i % 2 === 0;
    return JSON.stringify({
      target_body: "greeter",
      tool: useHello ? "say_hello" : "wave",
      parameters: useHello ? { name: names[this._i % names.length] } : {},
      priority: 3,
      fallback: "wave",
    });
  }
}

// -- Main --

async function main() {
  console.log("[plexa] hello-world starting");
  console.log("[plexa] zero HTTP between Plexa and bodies\n");

  const space = new Space("hello_world", {
    tickHz: 60,
    aggregateEveryTicks: 60,
    brainIntervalMs: 1500,
  });

  const body = new GreeterBody();
  space.addBody(body);

  const ollamaUp = await OllamaBrain.isAvailable();
  if (ollamaUp) {
    console.log("[plexa] ollama detected -- using llama3.2");
    space.setBrain(new OllamaBrain({ model: "llama3.2", maxTokens: 80 }));
  } else {
    console.log("[plexa] ollama not running -- using stub brain");
    space.setBrain(new StubBrain());
  }

  space.setGoal("greet the world periodically");

  space.on("tool_dispatched", (e) =>
    console.log(`[plexa] ${e.body}.${e.tool}(${JSON.stringify(e.parameters)})`));
  space.on("intent_error", (e) => console.log(`[plexa] intent rejected: ${e.reason}`));
  space.on("brain_error", (e) => console.log(`[plexa] brain error: ${e.message}`));

  await space.run();
  console.log(`[plexa] space running at ${space.tickHz}Hz\n`);

  const totalLoops = 5;
  let loop = 0;
  const timer = setInterval(() => {
    loop++;
    const s = space.getStats();
    console.log(
      `  Loop ${loop}: tick=${s.tick} brain=${s.brainCalls} tools=${s.toolsDispatched} ` +
      `greetings=${body.greetings} waves=${body.waves}`
    );
    if (loop >= totalLoops) {
      clearInterval(timer);
      cleanup();
    }
  }, 3000);

  async function cleanup() {
    console.log("\n[plexa] shutting down...");
    await space.stop();
    const s = space.getStats();
    console.log("\n=== Final Stats ===");
    console.log(`  Reactor ticks:     ${s.tick}`);
    console.log(`  Brain calls:       ${s.brainCalls}`);
    console.log(`  Tools dispatched:  ${s.toolsDispatched}`);
    console.log(`  Tools rejected:    ${s.toolsRejected}`);
    console.log(`  Tool errors:       ${s.toolErrors}`);
    console.log(`  Greetings:         ${body.greetings}`);
    console.log(`  Waves:             ${body.waves}`);
    process.exit(0);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
