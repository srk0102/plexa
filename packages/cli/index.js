// plexa CLI -- starfish brand, zero dependencies.
//
// Commands:
//   plexa version
//   plexa start [configFile]
//   plexa status
//   plexa bodies
//   plexa logs

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const c = require("./colors");
const { box } = require("./panel");
const { Spinner } = require("./spinner");

const PKG_VERSION = readPackageVersion();
const STATE_HOST = process.env.PLEXA_HOST || "http://localhost:4747";

function readPackageVersion() {
  try {
    const p = require(path.resolve(__dirname, "..", "..", "package.json"));
    return p.version || "0.0.0";
  } catch { return "0.0.0"; }
}

// -- version --------------------------------------------------

function cmdVersion() {
  console.log();
  console.log(`${c.indigo(c.starfish)} ${c.bold(c.white(`plexa v${PKG_VERSION}`))}`);
  console.log(`${c.indigo(c.star)} ${c.violet("one brain. many bodies.")}`);
  console.log(`  ${c.dim("github.com/srk0102/plexa")}`);
  console.log();
}

// -- help -----------------------------------------------------

function cmdHelp() {
  console.log();
  console.log(`${c.indigo(c.starfish)} ${c.bold("plexa")} ${c.dim(`v${PKG_VERSION}`)}`);
  console.log();
  console.log(c.bold("USAGE"));
  console.log(`  plexa ${c.cyan("<command>")} ${c.dim("[options]")}`);
  console.log();
  console.log(c.bold("COMMANDS"));
  console.log(`  ${c.cyan("start")}     ${c.dim("[config]")}    start a space from a config file`);
  console.log(`  ${c.cyan("status")}                  show space + body health`);
  console.log(`  ${c.cyan("bodies")}                  list connected bodies and their tools`);
  console.log(`  ${c.cyan("logs")}                    tail live body events and tool calls`);
  console.log(`  ${c.cyan("version")}                 print version and exit`);
  console.log(`  ${c.cyan("help")}                    this screen`);
  console.log();
  console.log(c.bold("ENVIRONMENT"));
  console.log(`  ${c.dim("PLEXA_HOST")}  status/bodies/logs target      ${c.dim(`(default: ${STATE_HOST})`)}`);
  console.log(`  ${c.dim("NO_COLOR")}    set to 1 to disable color`);
  console.log();
}

// -- helpers --------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = http.request({
        method: "GET",
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        timeout: 800,
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    } catch (e) { reject(e); }
  });
}

function formatUptime(ms) {
  if (!ms || ms < 0) return "--";
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${ss}`;
}

async function fetchStatus() {
  try { return await httpGet(`${STATE_HOST}/plexa/status`); }
  catch { return null; }
}

async function fetchBodies() {
  try { return await httpGet(`${STATE_HOST}/plexa/bodies`); }
  catch { return null; }
}

// -- status ---------------------------------------------------

async function cmdStatus() {
  console.log();
  console.log(`${c.indigo(c.star)} ${c.bold(c.white(`plexa v${PKG_VERSION}`))}`);
  console.log();

  const status = await fetchStatus();

  if (!status) {
    console.log(box([
      `${c.red("offline")}  no running space at ${c.dim(STATE_HOST)}`,
      `${c.dim("hint: start a Space in your app, or set PLEXA_HOST")}`,
    ], { color: c.red }));
    console.log();
    return;
  }

  const brain = status.brain ? `${status.brain.provider || "brain"}/${status.brain.model || "?"}` : "(none)";
  const reactor = `${status.tickHz || "?"}Hz`;
  const bodyCount = (status.bodies || []).length;

  console.log(box([
    `${c.bold("space:")}   ${status.name || "(unnamed)"}`,
    `${c.bold("brain:")}   ${brain}   ${status.brain ? c.green("active") : c.dim("idle")}`,
    `${c.bold("reactor:")} ${reactor}          ${status.running ? c.green("running") : c.red("stopped")}`,
  ]));
  console.log();

  if (bodyCount > 0) {
    console.log(c.bold(`bodies (${bodyCount} connected)`));
    for (const b of status.bodies) {
      const transport = b.transport === "inprocess" ? c.green("inprocess") : c.yellow(`http :${b.port}`);
      const tools = (b.tools || []).join(" ");
      console.log(`  ${c.indigo(c.starfish)} ${c.bold(pad(b.name, 12))} ${transport}    ${c.cyan(tools)}`);
    }
    console.log();
  }

  const s = status.stats || {};
  console.log(c.bold("stats"));
  console.log(`  brain calls:       ${c.white(String(s.brainCalls ?? 0).padStart(4))}     tools dispatched:  ${c.white(String(s.toolsDispatched ?? 0).padStart(4))}`);
  console.log(`  tools rejected:    ${c.white(String(s.toolsRejected ?? 0).padStart(4))}     cache hits:        ${c.white(String(s.cacheHits ?? s.bodyDecisions ?? 0).padStart(4))}`);
  const avg = s.avgBrainMs ?? (s.brain && s.brain.avgCallMs) ?? 0;
  console.log(`  avg brain ms:      ${c.white(String(avg).padStart(4))}     uptime:            ${c.white(formatUptime(s.uptimeMs))}`);
  console.log();

  if (status.running) console.log(`${c.indigo(c.starfish)} ${c.dim("listening...")}`);
  console.log();
}

function pad(s, w) { s = String(s); return s.length >= w ? s : s + " ".repeat(w - s.length); }

// -- bodies ---------------------------------------------------

async function cmdBodies() {
  console.log();
  const bodies = await fetchBodies();
  if (!bodies || !Array.isArray(bodies.bodies)) {
    console.log(`${c.red("offline")} no plexa instance reachable at ${c.dim(STATE_HOST)}`);
    console.log();
    return;
  }

  console.log(`${c.indigo(c.starfish)} ${c.bold("bodies")} ${c.dim(`(${bodies.bodies.length})`)}`);
  console.log();
  for (const b of bodies.bodies) {
    console.log(`  ${c.bold(c.indigo(c.starfish))} ${c.bold(b.name)}`);
    console.log(`     transport: ${b.transport}${b.port ? `  port: ${b.port}` : ""}`);
    console.log(`     mode:      ${b.mode || "managed"}`);
    console.log(`     status:    ${b.status || "unknown"}`);
    if (Array.isArray(b.tools) && b.tools.length > 0) {
      console.log(`     tools:     ${c.cyan(b.tools.join(", "))}`);
    }
    console.log();
  }
}

// -- logs (live tail) -----------------------------------------

async function cmdLogs() {
  console.log();
  console.log(`${c.indigo(c.starfish)} ${c.bold("plexa logs")} ${c.dim(`(polling ${STATE_HOST}/plexa/logs)`)}`);
  console.log();

  let offset = 0;
  const spinner = new Spinner("waiting for events...");

  let hadAny = false;

  // Initial spinner if nothing yet
  setTimeout(() => { if (!hadAny) spinner.start(); }, 500);

  while (true) {
    try {
      const res = await httpGet(`${STATE_HOST}/plexa/logs?offset=${offset}`);
      const lines = res.lines || [];
      if (lines.length > 0) {
        if (!hadAny) { spinner.stop(); hadAny = true; }
        for (const line of lines) printLogLine(line);
        offset = res.offset;
      }
    } catch {
      // keep polling silently
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

function printLogLine(entry) {
  if (!entry || typeof entry !== "object") return;

  if (entry.kind === "event") {
    const tag = (c.priority[entry.priority] || c.priority.NORMAL)(`[${entry.priority || "NORMAL"}]`);
    const body = c.bold(entry.body);
    const type = entry.type;
    const payload = entry.payload ? c.dim(JSON.stringify(entry.payload)) : "";
    console.log(`${tag} ${body} \u2192 ${type} ${payload}`);
    return;
  }

  if (entry.kind === "tool") {
    const mark = c.indigo(c.starfish);
    const head = c.cyan(`${entry.body}.${entry.tool}`);
    const args = entry.parameters ? c.dim(Object.entries(entry.parameters).map(([k,v]) => `${k}=${v}`).join(" ")) : "";
    console.log(`${mark} ${head} \u2190 ${args}`);
    return;
  }

  if (entry.kind === "decision") {
    const head = c.indigo(`${entry.body}.local`);
    console.log(`${c.dim("cache")} ${head} \u2192 ${entry.decision}`);
    return;
  }

  if (entry.line) console.log(entry.line);
}

// -- start ----------------------------------------------------

async function cmdStart(args) {
  const configFile = args[0];
  console.log();
  console.log(`${c.indigo(c.starfish)} ${c.bold("plexa start")}`);
  console.log();

  if (!configFile) {
    console.log(c.yellow("  no config file provided"));
    console.log(c.dim("  usage: plexa start <path/to/space.js>"));
    console.log();
    console.log(c.dim("  the file must export a function that receives { Space, BodyAdapter, OllamaBrain }"));
    console.log(c.dim("  and returns a configured Space."));
    console.log();
    return;
  }

  const abs = path.resolve(process.cwd(), configFile);
  if (!fs.existsSync(abs)) {
    console.log(`${c.red("  error:")} ${abs} not found`);
    console.log();
    process.exit(1);
  }

  const plexa = require(path.resolve(__dirname, "..", "..", "index.js"));
  let factory;
  try { factory = require(abs); }
  catch (e) { console.log(`${c.red("  error loading config:")} ${e.message}`); process.exit(1); }

  if (typeof factory !== "function") {
    console.log(`${c.red("  error:")} config file must export a function`);
    process.exit(1);
  }

  const space = await factory(plexa);
  if (!space || typeof space.run !== "function") {
    console.log(`${c.red("  error:")} config function must return a Space`);
    process.exit(1);
  }

  const spinner = new Spinner("starting...").start();
  try {
    await space.run();
    spinner.stop(`${c.green("\u2713")} space ${c.bold(space.name || "unnamed")} running`);
    console.log();
    console.log(c.dim(`run "plexa status" in another terminal to see health`));
    console.log();
  } catch (e) {
    spinner.stop();
    console.log(`${c.red("fatal:")} ${e.message}`);
    process.exit(1);
  }
}

// -- dispatch -------------------------------------------------

async function main() {
  const [, , cmd = "help", ...rest] = process.argv;
  switch (cmd) {
    case "version":
    case "-v":
    case "--version":
      return cmdVersion();
    case "status":
      return cmdStatus();
    case "bodies":
      return cmdBodies();
    case "logs":
      return cmdLogs();
    case "start":
      return cmdStart(rest);
    case "help":
    case "-h":
    case "--help":
    default:
      return cmdHelp();
  }
}

main().catch((e) => {
  console.error(`${c.red("fatal:")} ${e.message}`);
  process.exit(1);
});
