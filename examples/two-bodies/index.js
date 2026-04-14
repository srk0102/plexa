// Plexa -- two bodies, one brain (in-process, zero HTTP).
//
// A CartpoleBody (pure JS physics) and a LightBody (toggle state) share one Space.
// One brain coordinates both simultaneously.
//
// Run: node examples/two-bodies/index.js

const { Space, BodyAdapter, Brain } = require("../..");
const { OllamaBrain } = require("../../packages/bridges/ollama");

// -- Cartpole physics (simplified, visually plausible) --

class CartpolePhysics {
  constructor() { this.reset(); }
  reset() {
    this.x = 0; this.v = 0;
    this.theta = (Math.random() - 0.5) * 0.1;
    this.omega = 0; this.force = 0;
  }
  step(dt = 1 / 60) {
    const g = 9.8, mC = 1.0, mP = 0.1, L = 0.5;
    const total = mC + mP;
    const sinT = Math.sin(this.theta), cosT = Math.cos(this.theta);
    const temp = (this.force + mP * L * this.omega * this.omega * sinT) / total;
    const alpha = (g * sinT - cosT * temp) / (L * (4 / 3 - (mP * cosT * cosT) / total));
    const accX = temp - (mP * L * alpha * cosT) / total;
    this.v += accX * dt; this.x += this.v * dt;
    this.omega += alpha * dt; this.theta += this.omega * dt;
    this.v *= 0.999; this.omega *= 0.999; this.force = 0;
    if (Math.abs(this.theta) > 1.2 || Math.abs(this.x) > 2.5) {
      this.reset(); return true;
    }
    return false;
  }
  apply(direction, magnitude = 0.5) {
    const f = Math.min(1, Math.max(0, magnitude)) * 15;
    this.force = direction === "left" ? -f : f;
  }
}

class CartpoleBody extends BodyAdapter {
  static bodyName = "cartpole";
  static tools = {
    apply_force: {
      description: "Apply force to the cart to balance the pole",
      parameters: {
        direction: { type: "string", enum: ["left", "right"], required: true },
        magnitude: { type: "number", min: 0, max: 1, required: true },
      },
    },
    reset: { description: "Reset the cartpole", parameters: {} },
    hold:  { description: "Apply no force this frame", parameters: {} },
  };

  constructor() { super(); this.physics = new CartpolePhysics(); this._t = 0; }

  async apply_force({ direction, magnitude }) {
    this.physics.apply(direction, magnitude);
    return { applied: direction, magnitude };
  }
  async reset() { this.physics.reset(); return { ok: true }; }
  async hold()  { this.physics.force = 0; return { ok: true }; }

  async tick() {
    await super.tick();
    const wasReset = this.physics.step();
    const s = this.physics;
    this.setState({ cart_pos: s.x, pole_angle: s.theta, pole_vel: s.omega });
    if (Math.abs(s.theta) > 0.8) this.emit("pole_critical", { angle: round(s.theta) }, "CRITICAL");
    else if (Math.abs(s.theta) > 0.4) this.emit("pole_warning", { angle: round(s.theta) }, "HIGH");
    if (wasReset) this.emit("auto_reset", {}, "NORMAL");
    this._t++;
    if (this._t % 120 === 0) this.emit("state_update", { angle: round(s.theta) }, "NORMAL");
  }
}

// -- A simple toggle body (no physics) --

class LightBody extends BodyAdapter {
  static bodyName = "light";
  static tools = {
    turn_on:  { description: "Turn the light on",  parameters: {} },
    turn_off: { description: "Turn the light off", parameters: {} },
    toggle:   { description: "Toggle the light",   parameters: {} },
  };

  constructor() { super(); this.on = false; this.toggles = 0; }

  async turn_on()  { this.on = true;  this.setState({ on: true }); return { on: true }; }
  async turn_off() { this.on = false; this.setState({ on: false }); return { on: false }; }
  async toggle()   {
    this.on = !this.on;
    this.toggles++;
    this.setState({ on: this.on, toggles: this.toggles });
    this.emit("light_toggled", { on: this.on }, "NORMAL");
    return { on: this.on };
  }
}

function round(n) { return Math.round(n * 1000) / 1000; }

// -- Stub brain: alternates bodies --

class StubBrain extends Brain {
  constructor() { super({ model: "stub" }); this._i = 0; }
  async _rawCall() {
    this._i++;
    if (this._i % 3 === 0) {
      return JSON.stringify({
        target_body: "light",
        tool: "toggle",
        parameters: {},
        priority: 3,
        fallback: "turn_off",
      });
    }
    const dir = this._i % 2 === 0 ? "left" : "right";
    return JSON.stringify({
      target_body: "cartpole",
      tool: "apply_force",
      parameters: { direction: dir, magnitude: 0.4 },
      priority: 4,
      fallback: "hold",
    });
  }
}

// -- Main --

async function main() {
  console.log("[plexa] two-bodies demo starting");
  console.log("[plexa] two bodies sharing one brain, zero HTTP\n");

  const space = new Space("two_bodies", {
    tickHz: 60,
    aggregateEveryTicks: 60,
    brainIntervalMs: 1500,
  });

  const cart = new CartpoleBody();
  const light = new LightBody();
  space.addBody(cart);
  space.addBody(light);

  const ollamaUp = await OllamaBrain.isAvailable();
  if (ollamaUp) {
    console.log("[plexa] ollama detected -- using llama3.2");
    space.setBrain(new OllamaBrain({ model: "llama3.2", maxTokens: 120 }));
  } else {
    console.log("[plexa] ollama not running -- using stub brain (alternates bodies)");
    space.setBrain(new StubBrain());
  }

  space.setGoal("balance the pole and toggle the light periodically");

  space.on("tool_dispatched", (e) =>
    console.log(`[plexa] ${e.body}.${e.tool}(${JSON.stringify(e.parameters)})`));
  space.on("body_event", (e) => {
    if (e.priority === "CRITICAL") {
      console.log(`[plexa] [CRITICAL] ${e.body} -> ${e.type} ${JSON.stringify(e.payload)}`);
    }
  });
  space.on("intent_error", (e) => console.log(`[plexa] intent rejected: ${e.reason}`));
  space.on("brain_error", (e) => console.log(`[plexa] brain error: ${e.message}`));

  await space.run();
  for (const [name] of space.bodies) {
    console.log(`[plexa] body "${name}" registered`);
  }
  console.log(`[plexa] space running at ${space.tickHz}Hz\n`);

  const totalLoops = 8;
  let loop = 0;
  const timer = setInterval(() => {
    loop++;
    const s = space.getStats();
    console.log(
      `  Loop ${String(loop).padStart(2)}: ` +
      `tick=${s.tick} brain=${s.brainCalls} tools=${s.toolsDispatched} ` +
      `angle=${(cart.physics.theta).toFixed(2)} light=${light.on ? "on" : "off"} toggles=${light.toggles}`
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
    console.log(`  Bodies:            ${s.bodies}`);
    console.log(`  Reactor ticks:     ${s.tick}`);
    console.log(`  Brain calls:       ${s.brainCalls}`);
    console.log(`  Tools dispatched:  ${s.toolsDispatched}`);
    console.log(`  Tools rejected:    ${s.toolsRejected}`);
    console.log(`  Tool errors:       ${s.toolErrors}`);
    console.log(`  Light toggles:     ${light.toggles}`);
    process.exit(0);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
