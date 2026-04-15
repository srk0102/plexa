<p align="center">
  <img src="https://raw.githubusercontent.com/srk0102/plexa/master/assets/logo/logo-full.svg" width="360" alt="Plexa"/>
</p>

<p align="center">
  One brain. Many bodies. Orchestration for any continuously running system.
</p>

<p align="center">
  <a href="https://npmjs.com/package/@srk0102/plexa"><img src="https://img.shields.io/npm/v/@srk0102/plexa?color=4F46E5&label=npm" alt="npm"/></a>
  <a href="https://srk-e37e8aa3.mintlify.app"><img src="https://img.shields.io/badge/docs-mintlify-818CF8" alt="docs"/></a>
  <a href="https://github.com/srk0102/plexa"><img src="https://img.shields.io/badge/tests-181%20passing-10B981" alt="tests"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/badge/built%20on-scp--protocol-818CF8" alt="scp-protocol"/></a>
</p>

---

## The problem

Every LLM-controlled body today is welded to one environment. Change the body and you rebuild everything. There was no open protocol for it.

## The insight

Let the body run at 60Hz. Push events up only when it cannot answer locally. The brain teaches. The muscle remembers.

| Session | Brain calls | Cost (Nova Micro) |
|--------:|------------:|------------------:|
| 1       | 27          | $0.0270           |
| 2       | 4           | $0.0040           |
| 3       | 0           | $0.0000           |

Familiar situations are handled locally. Novel situations wake the brain. Cost is proportional to novelty.

## Install

```bash
npm install @srk0102/plexa
```

## Quick start (5 minutes)

```javascript
const { Space, BodyAdapter } = require("@srk0102/plexa")
const { OllamaBrain } = require("@srk0102/plexa/bridges/ollama")

class Cart extends BodyAdapter {
  static bodyName = "cart"
  static tools = {
    apply_force: {
      description: "push",
      parameters: {
        direction: { type: "string", enum: ["left", "right"], required: true },
        magnitude: { type: "number", min: 0, max: 1, required: true },
      },
    },
  }
  async apply_force({ direction, magnitude }) {
    console.log(`push ${direction} @${magnitude}`)
  }
}

const space = new Space("balancer")
space.addBody(new Cart())
space.setBrain(new OllamaBrain({ model: "llama3.2" }))
space.setGoal("balance the pole upright")
await space.run()
```

Expected output (Ollama not required; stub brain takes over automatically):

```
push left @0.4
push right @0.5
push left @0.3
```

## When to use what

| You have | Install |
|---|---|
| One body | `npm install scp-protocol` |
| Several bodies, one brain | `npm install @srk0102/plexa` |

## Not just robotics

Plexa orchestrates any system that runs continuously and pushes events:

```
Game NPCs   Robot arms   Web servers   Log monitors   API gateways   Any loop
```

Three ready-to-run software backend examples are in `examples/`:

```bash
node examples/web-server/index.js
node examples/log-monitor/index.js
node examples/api-gateway/index.js
```

See [`examples/web-backend`](https://srk-e37e8aa3.mintlify.app/examples/web-backend) in the docs.

## Adapters tested

| Adapter | Physics | Cache rate |
|---|---|---|
| Missile Defense | Canvas 2D | ~100% |
| Self-Driving Car | Canvas 2D | ~90% |
| 10-Lane Highway | Canvas 2D | ~90% |
| MuJoCo Cart-Pole | Real 3D physics | 89% |
| MuJoCo Ant | Real 3D physics | 85% |

Five adapters, one orchestrator, one brain, same protocol.

## Docs

Full documentation: **https://srk-e37e8aa3.mintlify.app**

Pages cover the Space reactor, memory layers (pattern store, adaptive memory, cross-session vertical memory), safety gate and approval hook, lateral body-to-body events, cost tracking and retry policy, and the full API.

## License

[MIT](LICENSE)
