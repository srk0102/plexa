<p align="center">
  <img src="https://raw.githubusercontent.com/srk0102/plexa/master/assets/logo/logo-full.svg" width="420" alt="Plexa"/>
</p>

<p align="center">
  <strong>One brain. Many bodies.</strong>
  <br/>
  Orchestration framework for embodied AI. Built on
  <a href="https://www.npmjs.com/package/scp-protocol">scp-protocol</a>.
</p>

<p align="center">
  <a href="https://npmjs.com/package/@srk0102/plexa"><img src="https://img.shields.io/npm/v/@srk0102/plexa?color=4F46E5&label=npm" alt="npm"/></a>
  <a href="https://github.com/srk0102/plexa"><img src="https://img.shields.io/github/license/srk0102/plexa?color=818CF8" alt="license"/></a>
  <a href="https://github.com/srk0102/plexa"><img src="https://img.shields.io/badge/tests-92%20passing-10B981" alt="tests"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/badge/built%20on-scp--protocol-818CF8" alt="scp-protocol"/></a>
</p>

---

## Demo: one brain, cart-pole body

[![Watch the demo](https://res.cloudinary.com/still-studying/video/upload/so_3/Screen_Recording_2026-04-13_010202_qlnftl.jpg)](https://res.cloudinary.com/still-studying/video/upload/Screen_Recording_2026-04-13_010202_qlnftl.mp4)

Plexa ticks the body at 60Hz, the body consults its local pattern cache first, and the LLM brain is called only when the cache misses.

---

## Overview

Plexa runs a single-process tick loop, aggregates every body's state into a brain prompt, dispatches the brain's tool intent as a direct async method call on the body, and owns the cross-session memory that makes the LLM quieter every run.

```
Sensor
  -> Reflex        (in-body, 0 ms)
    -> PatternStore      (scp-protocol, layer 2)
      -> AdaptiveMemory  (scp-protocol, layer 3)
        -> VerticalMemory  (plexa, cross-session)
          -> LLM brain     (Ollama / Bedrock / Anthropic)
              |
              Safety Rules -> Approval Hook -> body.invokeTool
              Body A  <--(lateral events, zero-latency)-->  Body B
```

Plexa is built on [`scp-protocol`](https://www.npmjs.com/package/scp-protocol). Use `scp-protocol` directly when you have one body. Use Plexa when you have several bodies and want one LLM to coordinate them.

```bash
npm install @srk0102/plexa
```

Node >= 18. One production dependency: `scp-protocol`. Plexa's own core has no other runtime packages; everything else is `node:*` built-ins.

---

## What it does

- Runs a 60Hz reactor loop that ticks every registered body each frame.
- Aggregates each body's state and events into a prompt that fits a configurable token budget (default 2000), trimming by event priority.
- Consults `VerticalMemory` before calling the brain so repeat situations skip the LLM entirely.
- Calls a brain (Ollama / Bedrock / Anthropic / your subclass) at most every `brainIntervalMs`. Brain base class handles retries on 5xx / 429 / network errors with exponential backoff and tracks per-call cost.
- Runs a hard safety gate (sync rules, cannot be bypassed) and an optional human-in-the-loop approval hook before dispatch.
- Validates the brain's tool intent against the body's declared schema, then dispatches as a direct async method call on the body.
- Auto-wraps a `static transport = "http"` body in a `NetworkBodyAdapter` that polls `/state`+`/events` and POSTs tool calls to `/tool`. If `static tools` is empty Plexa calls `/discover` and registers them.
- Routes lateral body-to-body events directly (no brain, no broadcast) via `space.link(from, to, [types])`.
- Sanitizes sensor payloads for prompt-injection patterns before they reach the LLM.
- Saves `VerticalMemory` and every body's pattern store on `stop()` and on `SIGINT/SIGTERM` when `installShutdownHandlers()` is called.
- Exposes an HTTP introspection server on port 4747 for the `plexa` CLI (status, bodies, logs).

It is a sequencer with gated dispatch and cross-session memory, not a planner. The brain chooses the tool; Plexa validates, gates, and dispatches it.

---

## 10-minute quick start

```bash
npm install @srk0102/plexa
```

```javascript
const { Space, BodyAdapter, VerticalMemory } = require("@srk0102/plexa")
const { OllamaBrain } = require("@srk0102/plexa/bridges/ollama")

class Cart extends BodyAdapter {
  static bodyName = "cart"
  static tools = {
    apply_force: {
      description: "push to balance",
      parameters: {
        direction: { type: "string", enum: ["left", "right"], required: true },
        magnitude: { type: "number", min: 0, max: 1, required: true },
      },
    },
  }
  async apply_force({ direction, magnitude }) { /* drive hardware */ }
  async tick() { await super.tick(); this.setState({ pole_angle: readAngle() }) }
}

const space = new Space("balancer", {
  verticalMemory: new VerticalMemory({ spaceName: "balancer", dbPath: "./plexa.db" }),
})
space.addBody(new Cart())
space.setBrain(new OllamaBrain({ model: "llama3.2" }))
space.addSafetyRule((cmd) =>
  cmd.tool === "apply_force" && cmd.parameters.magnitude > 0.9
    ? { allowed: false, reason: "magnitude too high" }
    : { allowed: true }
)
space.installShutdownHandlers()
await space.run()
```

That is a real, reviewable, persistable robot control loop. 60Hz body tick, local pattern-store muscle, cross-session memory, safety gate, an LLM brain that retries on 429 and tracks cost.

---

## Install

```bash
npm install @srk0102/plexa
```

This pulls in `scp-protocol` as its sole dependency. No AWS, no API keys, no external services required to run the examples.

To use a real LLM, install and run [Ollama](https://ollama.ai):

```bash
ollama pull llama3.2
```

If Ollama is not running, the bundled examples fall back to a stub brain so `npm run hello` still works end-to-end.

---

## Quick start

```javascript
const { Space, BodyAdapter, Brain } = require("@srk0102/plexa")
const { OllamaBrain } = require("@srk0102/plexa/bridges/ollama")

class CartpoleBody extends BodyAdapter {
  static bodyName = "cartpole"
  static tools = {
    apply_force: {
      description: "push the cart to balance the pole",
      parameters: {
        direction: { type: "string", enum: ["left", "right"], required: true },
        magnitude: { type: "number", min: 0, max: 1, required: true },
      },
    },
    hold: { description: "apply no force this frame", parameters: {} },
  }

  async apply_force({ direction, magnitude }) { /* physics */ }
  async hold()                                { /* no-op */ }

  async tick() {
    await super.tick()
    // sensor read; populate body state visible to the brain prompt
    this.setState({ pole_angle: readAngle() })
  }
}

const space = new Space("balancer", { tickHz: 60, brainIntervalMs: 1500 })
space.addBody(new CartpoleBody())
space.setBrain(new OllamaBrain({ model: "llama3.2" }))
space.setGoal("balance the pole upright")
await space.run()
```

Tools are methods. Bodies default to in-process; there is no port and no HTTP call between Plexa and a body in the same process. To run a body in another process, mark it `static transport = "http"` and give it a port.

---

## Run the bundled examples

```bash
git clone https://github.com/srk0102/plexa.git
cd plexa
npm install

node examples/hello-world/index.js     # one body, one tool loop
node examples/two-bodies/index.js      # cartpole + light, one brain
node examples/inprocess-demo/index.js  # cartpole physics, full stats
```

Each example prints brain calls, tools dispatched, and final stats. All three run without Ollama by falling back to the stub brain.

---

## How the reactor works

```
                 brainIntervalMs
                       |
   body.tick() --> aggregator --> brain --> translator --> body.invokeTool()
   body.tick()        (state +        |         (schema        (direct
   body.tick()         events)        |          check)         async call)
       ^                              |
       +------------------------------+
                 tickHz loop
```

Single thread. `setTimeout`-based tick. No locks. The brain call is async and non-blocking; body ticks continue while the brain is in flight. If the brain is still running when the next brain window opens, it is skipped.

---

## Managed mode

When a body is added to a Space it is in `managed` mode. Managed does not mean the body is dumb.

| Mode         | Who calls the LLM | Body's pattern store | Body's reflexes |
|--------------|-------------------|----------------------|-----------------|
| standalone   | the body          | used                 | fire            |
| managed      | Plexa             | still used           | still fire      |

In managed mode the body continues to resolve decisions locally via its own `scp-protocol` pattern store and fires a `body_decision` event to Plexa for each one. Plexa observes; it does not override.

---

## Vertical memory

`VerticalMemory` lives at the Space level and remembers what the brain decided for a given world state. On the next brain tick Plexa searches memory first; a confident match skips the LLM entirely.

```javascript
const mem = new VerticalMemory({ spaceName: "robot", dbPath: "./plexa.db", hitThreshold: 0.85 })
const space = new Space("robot", { verticalMemory: mem })
```

Storage: SQLite when `dbPath` is given (requires `better-sqlite3`), otherwise in-memory only. Similarity is Jaccard across bodies + tools + events + goal. Stats in `space.getStats().verticalMemory` and `space.stats.memoryHits / memoryMisses / memoryHitRate`.

---

## Lateral events

Bodies communicate directly, without the brain, without broadcast:

```javascript
class LeftArm extends BodyAdapter {
  async onPeerEvent(from, type, payload) {
    if (type === "grip_slip") await this.compensate(payload.force)
  }
}

space.link("right_arm", "left_arm", ["grip_slip", "balance_shift"])
await rightArm.sendToPeer("left_arm", "grip_slip", { force: 3 })
```

Direct async method call in-process. Zero latency. Plexa not in the routing path. Self-links are silently ignored.

---

## Safety rules and approval hook

```javascript
space.addSafetyRule((cmd) =>
  cmd.tool === "fire" ? { allowed: false, reason: "never fire" } : { allowed: true }
)

space.addApprovalHook(async (cmd) => {
  if (cmd.tool === "move" && cmd.parameters.speed > 0.8) {
    return { ...cmd, parameters: { speed: 0.5 } }  // modify
  }
  return true  // or false to reject
})
```

Safety rules run first, cannot be bypassed, and the first blocker wins. The approval hook runs after safety and may approve, reject, or return a modified command.

---

## Confidence gating

```javascript
space.setConfidenceThresholds({
  autoApprove: 0.9,   // act silently
  monitor:     0.6,   // act and emit "confidence_warning"
  escalate:    0.0,   // emit "confidence_escalation"
})
```

Decisions reported by bodies via `decideLocally` carry a confidence score. Plexa classifies each one and exposes per-body averages in `stats.avgConfidenceByBody`.

---

## Cost tracking and retry

Brain base class tracks per-call input + output tokens and accumulated USD cost using a built-in table (Nova Micro, Claude Haiku, GPT-4o Mini, and local models at $0). Access via `brain.stats()` or `space.getStats().estimatedCostUSD` and `costSavedByCacheUSD`.

Retry defaults: `maxRetries: 2`, `retryDelayMs: 1000` with exponential backoff on 429. Network errors and 5xx retry; 4xx (except 429) do not.

---

## Prompt-injection sanitizer

The aggregator strips role prefixes (`system:/user:/assistant:/human:`), chat template tokens (`<|...|>`), Anthropic `\n\nHuman:` markers, and known jailbreak directive phrases from body-supplied strings before they reach the brain. Tool definitions are preserved unchanged. Hits increment `stats.injectionHits` and a `security_event` fires.

Opt out per space: `new Space(name, { sanitizeInjection: false })`.

---

## Network bodies

Declare transport on the body class and Plexa auto-wraps it:

```javascript
class MuJoCoCart extends BodyAdapter {
  static bodyName = "cart"
  static transport = "http"
  static tools = { /* or leave empty to discover at runtime */ }
}
space.addBody(new MuJoCoCart({ port: 8002 }))
await space.ready()   // waits for /discover if tools were empty
```

Remote body contract:
- `GET /discover` returns `{ tools: { ... } }`
- `GET /health` returns `{ ok: true }`
- `GET /state` returns `{ data: { ... } }`
- `GET /events` drains a queue of `{ events: [{ type, payload, priority }] }`
- `POST /tool` receives `{ name, parameters }` and returns the tool result

---

## Tool intent contract

A brain response must be valid JSON matching:

```json
{
  "target_body": "cartpole",
  "tool": "apply_force",
  "parameters": { "direction": "left", "magnitude": 0.4 },
  "priority": 3,
  "fallback": "hold"
}
```

The translator rejects intents for seven reasons: unknown body, unknown tool, missing required parameter, wrong type, value out of range, value not in enum, or malformed response. Each rejection is counted in `space.getStats().translator.byReason`.

---

## Event priority

Bodies emit events with one of four priorities: `CRITICAL`, `HIGH`, `NORMAL`, `LOW`. The aggregator walks a seven-step reduction cascade when the prompt approaches the token budget: float compaction, string truncation, drop stale body fields, drop LOW events, drop NORMAL events, drop HIGH events, and finally drop bodies. CRITICAL events are preserved at every step.

---

## CLI

Installed globally or via `npx`:

```bash
npx @srk0102/plexa version     # version string
npx @srk0102/plexa status      # running space, tick, brain stats
npx @srk0102/plexa bodies      # connected bodies and tool lists
npx @srk0102/plexa logs        # live tail of body events and tool calls
npx @srk0102/plexa start ./space.js
```

The CLI reads from an HTTP server on port 4747. To expose it from your app:

```javascript
const { Space, attachIntrospection } = require("@srk0102/plexa")
const space = new Space("robot")
attachIntrospection(space)   // localhost:4747/plexa/{status,bodies,logs,health}
await space.run()
```

No dependencies beyond `node:http`. No bearer-token auth yet: treat the port as localhost-only.

---

## Tests

```bash
npm test
```

181 tests across 40 suites. Built-in `node:test`, no test framework dependency.

| File                       | Tests |
|----------------------------|------:|
| plexa.test.js              | 82 |
| managed-mode.test.js       | 10 |
| bridges.test.js            |  8 |
| safety-approval.test.js    | 15 |
| injection.test.js          | 10 |
| network-body.test.js       |  9 |
| confidence-lateral.test.js | 13 |
| vertical-memory.test.js    | 11 |
| cost-retry.test.js         | 13 |
| integration.test.js        | 10 |

`integration.test.js` exercises scp-protocol and plexa together end-to-end: in-process full lifecycle, pattern-store + space, adaptive-memory reducing LLM calls, safety block, approval modify, lateral event with no broadcast, confidence escalation, cost tracking, vertical memory cross-session, network body via mock HTTP server.

---

## Honest state of the code (v0.5)

What works:
- Four-layer decision stack end-to-end (reflex / pattern / adaptive / brain).
- In-process bodies. All three bundled examples run end to end.
- Network bodies with auto-wrap, `/discover`, polling, and POST tool dispatch.
- Safety gate, approval hook, prompt-injection sanitizer, confidence gating.
- Vertical memory with SQLite persistence and cross-session reuse.
- Lateral body-to-body events, zero-latency in-process.
- Cost tracking + retry + exponential backoff in Brain base class.
- Ollama, Bedrock, Anthropic brains. Claude Haiku default for Anthropic.
- Graceful shutdown: `space.installShutdownHandlers()` saves everything.

What exists but has a caveat:
- Introspection server is unauthenticated. Bind to localhost only.
- `better-sqlite3` must compile on the host. Without it, `VerticalMemory` and `AdaptiveMemory` silently fall back to in-memory only.

What is not implemented:
- CRDT or shared state between bodies.
- Process isolation per body. Bodies share the Node process.
- Python SDK. Python bodies still use raw HTTP against the network body contract.
- Godot / Unity plugins.

---

## Links

- Source: https://github.com/srk0102/plexa
- npm: https://npmjs.com/package/@srk0102/plexa
- SCP protocol: https://npmjs.com/package/scp-protocol

## License

MIT
