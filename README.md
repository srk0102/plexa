<h1 align="center">Plexa</h1>

<p align="center">
  One brain. Many bodies.
  <br/>
  <strong>Orchestration framework for embodied AI systems.</strong>
</p>

<p align="center">
  <a href="https://npmjs.com/package/@srk0102/plexa"><img src="https://img.shields.io/npm/v/@srk0102/plexa?color=4F46E5&label=npm" alt="npm"/></a>
  <a href="https://github.com/srk0102/plexa"><img src="https://img.shields.io/github/license/srk0102/plexa?color=818CF8" alt="license"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/badge/built%20on-scp--protocol-818CF8" alt="scp"/></a>
</p>

> SCP gives AI one body. Plexa gives AI a whole body.

---

## What it does

Plexa is an orchestration layer that sits above [SCP](https://github.com/srk0102/SCP). It coordinates multiple SCP adapters under a single LLM brain.

```
LLM (Brain)
    |
Plexa (Orchestrator)
    |
Multiple SCP adapters (Body parts)
    |
Environment
```

---

## Four jobs only

| Job | Where | What |
|-----|-------|------|
| Translate | `translator.js` | Convert LLM intent to SCP commands |
| Sequence | `space.js` | Manage execution order across bodies |
| Aggregate | `aggregator.js` | Compress all body state under 2000 tokens |
| Gate | `body-adapter.js` | Enforce capabilities and safety contracts |

No reasoning. No safety logic. No pattern matching. Four jobs only.

---

## Decision authority

```
LLM decides:           WHAT (intent, goals)
Plexa decides:     WHEN and HOW (sequencing, timing)
SCP adapters decide:   WHETHER (safety veto, hardware limits)
```

These three layers never overlap. Plexa is not a brain. It is a sequencer.

---

## Transport truth

| Connection | Transport | Latency |
|---|---|---|
| JS Body -> Plexa | function call | 0 ms |
| Python Body -> Plexa | HTTP | 1-5 ms |
| Plexa -> LLM | HTTP | 500 ms+ |

**Zero HTTP between JS bodies and Plexa.** HTTP only where physically necessary.

A body is a class. Tools are its async methods. By default `transport = "inprocess"`, no port, no network. Plexa calls `body.invokeTool(name, params)` directly. To run a body in another process, mark it explicitly:

```javascript
class MuJoCoCartpole extends BodyAdapter {
  static transport = "http"
  static port = 8002
}
```

---

## Hello world

```bash
git clone https://github.com/srk0102/plexa.git
cd plexa
npm install
node examples/hello-world/index.js
```

No AWS. No API key. Just Node.js.

Ollama optional: install from [ollama.ai](https://ollama.ai) and run `ollama pull llama3.2` for a real local brain. Otherwise the example uses a stub brain.

---

## API

```javascript
const { Space, BodyAdapter, OllamaBrain } = require("@srk0102/plexa")

class CartpoleBody extends BodyAdapter {
  static bodyName = "cartpole"
  static tools = {
    apply_force: {
      description: "push the cart",
      parameters: {
        direction: { type: "string", enum: ["left","right"], required: true },
        magnitude: { type: "number", min: 0, max: 1, required: true },
      },
    },
  }
  async apply_force({ direction, magnitude }) {
    // physics here
  }
  async tick() {
    // sensor loop called by Plexa at tickHz
  }
}

const space = new Space("my_robot")
space.addBody(new CartpoleBody())
space.setBrain(new OllamaBrain({ model: "llama3.2" }))
space.run()
```

Tools are methods. No ports. No transport configuration. Plexa calls `body.invokeTool(...)` as a direct async call.

---

## Managed mode

Connected bodies flip to `managed` mode automatically. Managed does NOT mean dumb.

| Mode | LLM layer | Pattern store | Reflexes | Reports |
|------|-----------|--------------|----------|---------|
| **standalone** | Body calls its own LLM | Local decisions | Local | — |
| **managed** | Plexa owns the LLM | **Local decisions (still intelligent)** | Local | Body pings Space on every decision |

In managed mode:
- The body keeps using its local pattern store to decide at muscle speed.
- Every local decision fires `space.onBodyDecision(name, entity, decision, meta)` so Plexa can build vertical memory and stay aware.
- Only the LLM path is routed through Plexa.

Managed = coordinated, not lobotomized.

---

## Architecture

```
Read sensors in SCP muscle
  |
Reflex check (always local, fastest)
  |
Emit event UP via HTTP to Plexa
  |
Space aggregator compresses state from all bodies
  |
Space calls LLM brain (fire-and-forget, async)
  |
Brain returns intent
  |
Translator validates intent against body capabilities
  |
Space dispatches command DOWN to body
  |
Body forwards command to SCP muscle via HTTP
  |
SCP muscle executes command
```

Single-threaded reactor at 120Hz. No locks. No polling. Deterministic tick budget.

---

## Package structure

```
plexa/
  packages/
    core/
      space.js          Space orchestrator
      body-adapter.js   BodyAdapter base class
      brain.js          Brain base class
      translator.js     Intent -> command validation
      aggregator.js     State compression with token budget
    bridges/
      ollama.js         OllamaBrain (local, free)
  adapters/
    template/           Minimal SCP adapter for testing
  examples/
    hello-world/        End-to-end demo
  tests/
    plexa.test.js       43 tests, 0 failures
```

---

## Relationship to SCP

```
SCP (scp-protocol)
  Protocol + SDK
  npm install scp-protocol
  Controls one body
  Done. Shipped. v0.1.1.

Plexa
  Orchestration framework
  npm install @srk0102/plexa
  Coordinates multiple SCP bodies
  One brain for the whole body
  Built on scp-protocol.
```

Same pattern as Express and Node HTTP. Plexa depends on scp-protocol. scp-protocol does not know about Plexa.

---

## Tests

```bash
npm test
```

43 tests. Zero external deps beyond `scp-protocol`. `node:test` built-in.

| Suite | Tests |
|-------|-------|
| Space lifecycle | 7 |
| BodyAdapter modes | 7 |
| BodyAdapter execute | 4 |
| Brain | 7 |
| OllamaBrain | 3 |
| Translator | 8 |
| Aggregator | 6 |

---

## Roadmap

| Version | What |
|---------|------|
| v0.1.0 (current) | Space, BodyAdapter, Brain, Translator, Aggregator, OllamaBrain, template muscle |
| v0.2.0 | Multi-body demos (MuJoCo cartpole + template + arm), real Ollama integration |
| v0.3.0 | Safety layer with CRDT shared state, SPSC ring buffers |
| v0.4.0 | Process isolation per body, OpenAI and Anthropic bridges |
| v1.0.0 | Stable API, production-ready orchestration |

---

## Links

- **SCP:** https://github.com/srk0102/SCP
- **SCP npm:** https://npmjs.com/package/scp-protocol
- **SCP docs:** https://srk-e37e8aa3.mintlify.app

## License

[MIT](LICENSE) -- [srk0102](https://github.com/srk0102)
