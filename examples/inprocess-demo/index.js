// Plexa -- in-process demo. Zero HTTP.
// A CartpoleBody with pure-JS physics as a class with tool methods.
// Plexa ticks it at 60fps, brain sees tool definitions, brain calls tools directly.

const { Space, BodyAdapter, Brain, PRIORITY, attachIntrospection } = require("../..");
const { OllamaBrain } = require("../../packages/bridges/ollama");

// -- Pure JS cartpole physics (no MuJoCo, no Python) --

class CartpolePhysics {
  constructor() { this.reset(); }

  reset() {
    this.x = 0;          // cart position
    this.v = 0;          // cart velocity
    this.theta = (Math.random() - 0.5) * 0.1; // small initial tilt
    this.omega = 0;      // pole angular velocity
    this.force = 0;
  }

  // Simplified inverted-pendulum step. Not physically exact, visually plausible.
  step(dt = 1 / 60) {
    const g = 9.8, mC = 1.0, mP = 0.1, L = 0.5;
    const total = mC + mP;
    const sinT = Math.sin(this.theta);
    const cosT = Math.cos(this.theta);
    const temp = (this.force + mP * L * this.omega * this.omega * sinT) / total;
    const alpha = (g * sinT - cosT * temp) / (L * (4 / 3 - (mP * cosT * cosT) / total));
    const accX = temp - (mP * L * alpha * cosT) / total;

    this.v += accX * dt;
    this.x += this.v * dt;
    this.omega += alpha * dt;
    this.theta += this.omega * dt;

    // Friction + reset if out of bounds
    this.v *= 0.999;
    this.omega *= 0.999;
    this.force = 0; // impulse only

    if (Math.abs(this.theta) > 1.2 || Math.abs(this.x) > 2.5) {
      this.reset();
      return true; // reset happened
    }
    return false;
  }

  apply(direction, magnitude = 0.5) {
    // Magnitude 0-1 scaled to +/- 15 N
    const f = Math.min(1, Math.max(0, magnitude)) * 15;
    this.force = direction === "left" ? -f : f;
  }
}

// -- CartpoleBody: tools are methods on this class --

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
    reset: {
      description: "Reset the cartpole to center with a small random tilt",
      parameters: {},
    },
    hold: {
      description: "Apply no force this frame",
      parameters: {},
    },
  };

  constructor() {
    super();
    this.physics = new CartpolePhysics();
    this._stateEmitTick = 0;
  }

  // -- Tools (methods matching static tools) --

  async apply_force({ direction, magnitude }) {
    this.physics.apply(direction, magnitude);
    return { applied: direction, magnitude };
  }

  async reset() {
    this.physics.reset();
    return { ok: true };
  }

  async hold() {
    this.physics.force = 0;
    return { ok: true };
  }

  // -- Sensor loop --

  async tick() {
    await super.tick();

    const wasReset = this.physics.step();
    const s = this.physics;

    this.setState({
      cart_pos: s.x,
      cart_vel: s.v,
      pole_angle: s.theta,
      pole_vel: s.omega,
    });

    // Reflex: emergency damping if pole past 0.5 rad with high velocity
    if (Math.abs(s.theta) > 0.5 && Math.abs(s.omega) > 0.5) {
      // Push opposite way (safety, not cached)
      this.physics.apply(s.theta > 0 ? "left" : "right", 0.6);
    }

    // Priority events
    if (Math.abs(s.theta) > 0.8) {
      this.emit("pole_critical", { angle: round(s.theta) }, "CRITICAL");
    } else if (Math.abs(s.theta) > 0.4) {
      this.emit("pole_warning", { angle: round(s.theta) }, "HIGH");
    }
    if (Math.abs(s.x) > 1.8) {
      this.emit("cart_boundary", { cart_pos: round(s.x) }, "HIGH");
    }
    if (wasReset) {
      this.emit("auto_reset", {}, "NORMAL");
    }

    // Periodic state update
    this._stateEmitTick++;
    if (this._stateEmitTick % 120 === 0) {
      this.emit("state_update", { angle: round(s.theta), cart: round(s.x) }, "NORMAL");
    }
  }
}

function round(n) { return Math.round(n * 1000) / 1000; }

// -- Stub brain: rotates through sensible cart-pole controls --

class StubBrain extends Brain {
  constructor() { super({ model: "stub" }); this._i = 0; }
  async _rawCall() {
    this._i++;
    // Prefer pushing opposite to tilt when we have state
    // Here we just rotate for demo purposes; real LLM uses world_state.
    const choices = [
      { tool: "apply_force", parameters: { direction: "left", magnitude: 0.5 } },
      { tool: "apply_force", parameters: { direction: "right", magnitude: 0.5 } },
      { tool: "hold", parameters: {} },
    ];
    const c = choices[this._i % choices.length];
    return JSON.stringify({
      target_body: "cartpole",
      tool: c.tool,
      parameters: c.parameters,
      priority: 3,
      fallback: "hold",
    });
  }
}

// -- Main --

async function main() {
  console.log("[plexa] inprocess demo starting");
  console.log("[plexa] zero HTTP between Plexa and bodies (all direct method calls)\n");

  const space = new Space("inprocess_demo", {
    tickHz: 60,
    aggregateEveryTicks: 60,  // aggregate once per second
    brainIntervalMs: 1500,    // brain call at most every 1.5s
  });

  const body = new CartpoleBody();

  // ZERO-PORT GUARANTEE: prove this body has no transport configuration
  console.log(`[plexa] body class:        ${body.constructor.name}`);
  console.log(`[plexa] body transport:    ${body.transport}`);
  console.log(`[plexa] body port:         ${body.port === null ? "(none -- inprocess)" : body.port}`);
  console.log(`[plexa] body host:         ${body.host === null ? "(none -- inprocess)" : body.host}`);

  if (body.transport !== "inprocess" || body.port !== null) {
    throw new Error("FAIL: this demo expects a pure inprocess body. Found transport=" + body.transport);
  }

  space.on("body_registered", (e) => {
    console.log(`[plexa] registered "${e.name}" via ${e.transport}` +
      (e.port ? ` (port ${e.port})` : "") +
      ` -- tools: ${e.tools.join(", ")}`);
  });

  space.addBody(body);

  const ollamaUp = await OllamaBrain.isAvailable();
  if (ollamaUp) {
    console.log("[plexa] ollama detected -- using llama3.2 (warming up...)");
    const ollama = new OllamaBrain({ model: "llama3.2", maxTokens: 80 });
    // Pre-warm so the first cold call doesn't burn the demo budget
    try {
      await ollama.invoke({ bodies: {}, active_goal: "warmup" });
      console.log(`[plexa] warmup ok (${ollama.lastCallMs}ms)`);
    } catch (e) {
      console.log(`[plexa] warmup error: ${e.message}`);
    }
    space.setBrain(ollama);
  } else {
    console.log("[plexa] ollama not running -- using stub brain");
    space.setBrain(new StubBrain());
  }

  space.setGoal("balance the pole upright at the cart center\n");

  // Expose localhost:4747 so the plexa CLI can show status / bodies / logs
  attachIntrospection(space);
  console.log(`[plexa] introspection on http://localhost:4747/plexa/status\n`);

  // Event hooks
  space.on("body_event", (e) => {
    if (e.priority === "CRITICAL") {
      console.log(`[plexa] event [CRITICAL] ${e.body} -> ${e.type} ${JSON.stringify(e.payload)}`);
    }
  });
  space.on("tool_dispatched", (e) => {
    console.log(`[plexa] tool dispatched: ${e.body}.${e.tool}(${JSON.stringify(e.parameters)})  exec=${e.durationMs}ms`);
  });
  space.on("intent_error", (e) => console.log(`[plexa] intent rejected: ${e.reason} -- ${e.error}`));
  space.on("tool_error", (e) => console.log(`[plexa] tool error: ${e.body}.${e.tool} -- ${e.error}`));
  space.on("brain_error", (e) => console.log(`[plexa] brain error: ${e.message}`));

  await space.run();
  console.log(`[plexa] space running at ${space.tickHz}Hz\n`);

  // Run for 30 seconds, print stats every 3s
  const totalLoops = 10;
  let loop = 0;

  const timer = setInterval(() => {
    loop++;
    const s = space.getStats();
    const b = body.snapshot();
    console.log(
      `  Loop ${String(loop).padStart(2)}: ` +
      `tick=${s.tick} brain=${s.brainCalls} tools=${s.toolsDispatched} ` +
      `angle=${(b.pole_angle ?? 0).toFixed(2)} cart=${(b.cart_pos ?? 0).toFixed(2)} ` +
      `tokens=${s.aggregator.maxTokens}`
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
    console.log(`  Reactor ticks:         ${s.tick}`);
    console.log(`  Bodies:                ${s.bodies}`);
    console.log(`  Tools registered:      ${s.tools}`);
    console.log(`  Brain calls:           ${s.brainCalls}`);
    console.log(`  Brain errors:          ${s.brainErrors}`);
    console.log(`  Tools dispatched:      ${s.toolsDispatched}`);
    console.log(`  Tools rejected:        ${s.toolsRejected}`);
    console.log(`  Tool errors:           ${s.toolErrors}`);
    console.log(`  Max tokens:            ${s.aggregator.maxTokens}`);
    console.log(`  Events dropped:        ${s.aggregator.droppedEvents}`);
    console.log(`  Translator rejects:    ${JSON.stringify(s.translator.byReason)}`);
    if (s.brain) console.log(`  Avg brain call:        ${s.brain.avgCallMs}ms`);
    console.log(`  Body stats:            ${JSON.stringify(body.stats)}`);
    process.exit(0);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
