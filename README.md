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

| Hop | Mechanism | Latency |
|------|-----------|---------|
| Body -> Plexa | direct function call (in-process) | 0-1 ms |
| Plexa -> LLM | HTTP (always remote) | ~500 ms |
| Plexa -> Hardware body | HTTP (only when physically separate) | network round-trip |

**Zero HTTP between body and Plexa.** That is the architectural guarantee.

A body is a class. Tools are its async methods. Plexa calls `body.invokeTool(name, params)` directly. No serialization, no transport, no parsing. HTTP exists only at the LLM boundary and (optionally) when a body lives on a different machine.

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
const { HTTPTransport } = require("scp-protocol")

class MyBody extends BodyAdapter {
  constructor(transport) {
    super({ name: "arm", capabilities: ["move_to", "halt"], transport })
  }
}

const transport = new HTTPTransport({ port: 3000 })
await transport.start()

const space = new Space("my_robot")
space.addBody(new MyBody(transport))
space.setBrain(new OllamaBrain({ model: "llama3.2" }))
space.setGoal("pick up the red box")
space.run()
```

Three imports. One class. Done.

---

## Managed mode

SCP adapters run in two modes:

| Mode | Brain | Pattern store | Reflexes |
|------|-------|--------------|----------|
| **standalone** | Local LLM bridge | Local decisions | Local |
| **managed** | Plexa | Logs only, no decisions | Local |

Plexa automatically flips connected adapters to managed mode. The adapter keeps reflexes and physics local. The brain lives in Plexa.

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
