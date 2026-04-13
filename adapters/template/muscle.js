// Template SCP adapter for Project G testing.
// Pure Node.js. No MuJoCo. No local LLM bridge. No pattern-store decisions.
//
// The muscle:
//   Runs a simple simulation at 60fps (random entities appear).
//   Fires reflexes locally (emergency halt if entity too close).
//   Emits semantic events to Project G via HTTPTransport.
//   Executes commands received from Project G.
//   Starts in managed mode and waits for set_mode confirmation.

const http = require("node:http");

// Config
const PORT = parseInt(process.env.SCP_PORT || "8001", 10);
const SPACE_URL = process.env.SPACE_URL || "http://localhost:3000";
const BODY_NAME = process.env.BODY_NAME || "template_body";
const TICK_HZ = 60;

// Entity kinds the simulation spawns
const ENTITY_KINDS = ["obstacle", "target", "noise"];

// -- Local state --

const state = {
  mode: "standalone",       // flipped to "managed" when Project G sends set_mode
  tick: 0,
  position: { x: 0, y: 0 },
  velocity: { x: 0, y: 0 },
  last_action: null,
  entities: [],
  stats: {
    ticks: 0,
    reflexes: 0,
    commandsExecuted: 0,
    eventsEmitted: 0,
  },
};

// -- Outbound: post events to Project G --

function post(path, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(path, SPACE_URL);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: 500,
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(true));
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    } catch {
      resolve(false);
    }
  });
}

function emit(eventType, payload) {
  state.stats.eventsEmitted++;
  // Fire-and-forget; Project G's HTTPTransport receives via POST /emit
  post("/emit", { type: eventType, body: BODY_NAME, state: snapshot(), payload, ts: Date.now() });
}

// -- Inbound: HTTP server for Project G to send commands --

function startCommandServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405); res.end(); return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400); res.end(); return;
      }

      if (msg.type === "set_mode") {
        state.mode = msg.mode || "standalone";
        console.log(`[muscle] mode -> ${state.mode}`);
      } else if (msg.type === "command") {
        executeCommand(msg);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.listen(PORT);
  console.log(`[muscle] listening on :${PORT}`);
  return server;
}

// -- Action executors --

function executeCommand(msg) {
  const action = msg.method || msg.action;
  const args = msg.args || msg.parameters || {};

  state.last_action = action;
  state.stats.commandsExecuted++;

  switch (action) {
    case "move_to":
      state.velocity.x = (args.x || 0) * 0.1;
      state.velocity.y = (args.y || 0) * 0.1;
      break;
    case "halt":
      state.velocity.x = 0;
      state.velocity.y = 0;
      break;
    case "avoid":
      // push away from target entity
      state.velocity.x = -0.2;
      state.velocity.y = -0.2;
      break;
    case "engage":
      state.velocity.x = 0.3;
      state.velocity.y = 0;
      break;
    default:
      // unknown action -- drift
      break;
  }

  console.log(`[muscle] exec ${action} ${JSON.stringify(args)}`);
}

// -- Reflex (always runs, regardless of mode) --

function reflex() {
  for (const e of state.entities) {
    const d = Math.hypot(e.x - state.position.x, e.y - state.position.y);
    if (d < 0.5) {
      state.velocity.x = 0;
      state.velocity.y = 0;
      state.stats.reflexes++;
      return true;
    }
  }
  return false;
}

// -- Simulation step --

function simulate() {
  // Move
  state.position.x += state.velocity.x;
  state.position.y += state.velocity.y;

  // Spawn random entities occasionally
  if (Math.random() < 0.02) {
    state.entities.push({
      id: `e${state.tick}`,
      kind: ENTITY_KINDS[Math.floor(Math.random() * ENTITY_KINDS.length)],
      x: (Math.random() - 0.5) * 10,
      y: (Math.random() - 0.5) * 10,
      born_at: state.tick,
    });
  }

  // Age out entities after 200 ticks
  state.entities = state.entities.filter((e) => state.tick - e.born_at < 200);
}

// -- Snapshot (read by emit()) --

function snapshot() {
  return {
    mode: state.mode,
    tick: state.tick,
    position: { ...state.position },
    velocity: { ...state.velocity },
    entities_visible: state.entities.length,
    last_action: state.last_action,
  };
}

// -- Main loop --

async function main() {
  console.log(`[muscle] ${BODY_NAME} starting`);
  console.log(`[muscle] will emit events to ${SPACE_URL}/emit`);
  console.log(`[muscle] will accept commands on :${PORT}`);

  startCommandServer();

  const tickMs = 1000 / TICK_HZ;

  while (true) {
    const t = Date.now();
    state.tick++;
    state.stats.ticks++;

    // Reflex first (always)
    const reflexFired = reflex();

    // Simulation step
    simulate();

    // Emit semantic events
    if (reflexFired && state.tick % 30 === 0) {
      emit("obstacle_too_close", {});
    }

    // Emit an "entity_detected" event when a new one spawns
    const newest = state.entities[state.entities.length - 1];
    if (newest && newest.born_at === state.tick - 1) {
      emit("entity_detected", { kind: newest.kind });
    }

    // Periodic heartbeat
    if (state.tick % 300 === 0) {
      emit("heartbeat", {
        ticks: state.stats.ticks,
        reflexes: state.stats.reflexes,
        commands: state.stats.commandsExecuted,
      });
    }

    // Sleep to maintain tick rate
    const elapsed = Date.now() - t;
    const wait = Math.max(0, tickMs - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((e) => {
  console.error("[muscle] fatal:", e.message);
  process.exit(1);
});
