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

Plexa runs a single-process tick loop, aggregates every body's state into a brain prompt, dispatches the brain's tool intent as a direct async method call on the body.

Plexa is built on [`scp-protocol`](https://www.npmjs.com/package/scp-protocol). Use `scp-protocol` directly when you have one body. Use Plexa when you have several bodies and want one LLM to coordinate them.

```bash
npm install @srk0102/plexa
```

Node >= 18. One production dependency: `scp-protocol`. Plexa's own core has no other runtime packages; everything else is `node:*` built-ins.

---

## What it does

- Runs a 60Hz reactor loop that ticks every registered body each frame.
- Aggregates each body's state and events into a prompt that fits a configurable token budget (default 2000), trimming by event priority.
- Calls a brain (OllamaBrain, or a subclass you write) at most every `brainIntervalMs`.
- Validates the brain's tool intent against the body's declared schema, then dispatches as a direct async method call on the body.
- Exposes an HTTP introspection server on port 4747 for the `plexa` CLI (status, bodies, logs).

It is a sequencer and a prompt packer, not a planner or a safety layer. The brain chooses the tool; Plexa only validates and dispatches it.

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

92 tests across 14 suites. Built-in `node:test`, no test framework dependency.

| File                | Tests |
|---------------------|------:|
| plexa.test.js       | 82 |
| managed-mode.test.js| 10 |

The test suite covers Space lifecycle, addBody transport validation, reactor loop, Aggregator priority trimming, Translator rejection reasons, Brain base class, and managed-mode decision handoff. It does not cover: CLI, introspection server, or the bundled examples. Those are exercised by running them manually.

---

## Honest state of the code

What works:
- In-process bodies. `examples/inprocess-demo` and both updated `hello-world` / `two-bodies` examples run end to end.
- Aggregator with CRITICAL-preserving trim cascade.
- Translator with per-parameter type / enum / min / max / required validation.
- Ollama bridge over raw `node:http`.
- CLI with colored output, spinner, and panel rendering using only `node:*`.

What exists but has a caveat:
- `NetworkBodyAdapter` proxies tool calls to a remote body over HTTP, but `Space.addBody` does not yet auto-wrap HTTP-transport bodies in it. You have to instantiate the proxy yourself.
- Introspection server is unauthenticated. Bind to localhost only.
- The bundled `scp-protocol` dependency is pinned to `^0.3.0`; the two packages are developed together.

What is not implemented yet:
- CRDT or shared state between bodies.
- Body-to-body lateral events.
- Persistent vertical memory across sessions. The current `body_decision` history is in-memory and bounded to the last 10 entries.
- Safety gate that validates LLM intents against policy before dispatch.
- Process isolation per body. Bodies share the Node process.
- Retry and cost tracking in the Brain base class.

---

## Links

- Source: https://github.com/srk0102/plexa
- npm: https://npmjs.com/package/@srk0102/plexa
- SCP protocol: https://npmjs.com/package/scp-protocol

## License

MIT
