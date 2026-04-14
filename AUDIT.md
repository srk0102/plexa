# Full Honest Audit

Date: 2026-04-14 (updated 2026-04-14 after v0.4.0 cut)
Scope: `scp-protocol` (D:/scp-mvp) and `@srk0102/plexa` (D:/Project-G)
Method: read every source file, run every test suite, compare claims to code.

No padding. No encouragement. Facts.

---

## Update log

**2026-04-14 late -- v0.5.1 positioning + docs**

Positioning changes:
- Both READMEs reframed from "embodied AI / one body" to "any continuously running system". New tagline: *Any LLM. Any continuously running system. Brain teaches once. System remembers forever.* Plexa: *One brain. Many systems.*
- Added three explicit example domains (game AI, robotics, simulation) plus a fourth (web backends) linked to the new docs example.
- Added an honest "when does the brain wake?" paragraph to the README and a full section in `scp/how-it-works.mdx`. Documents the confidence-threshold gate, the risks of tuning it too high or too low, and the role of `explorationRate` as a drift safety valve.
- Reframed cost language across READMEs and docs: "brain decisions cached locally" instead of "system learned"; "drops as novelty decreases" instead of "drops to zero"; explicit caveat that *novel situations always wake the brain* and *cost is proportional to novelty*.

Docs status (15 pages live on Mintlify):

| Page | Words |
|---|---:|
| introduction.mdx | 183 |
| getting-started.mdx | 227 |
| scp/introduction.mdx | 374 |
| scp/how-it-works.mdx | 535 + novelty section (~280) |
| scp/adapter-guide.mdx | 741 |
| scp/pattern-store.mdx | 664 |
| scp/bridges.mdx | 447 |
| scp/api.mdx | 695 |
| plexa/introduction.mdx | 419 |
| plexa/how-it-works.mdx | 592 |
| plexa/body-guide.mdx | 713 |
| plexa/memory.mdx | 516 |
| plexa/safety.mdx | 572 |
| plexa/api.mdx | 930 |
| examples/cart-pole.mdx | 846 |
| examples/two-bodies.mdx | 636 |
| examples/web-backend.mdx | 690 |

Production readiness (revised):
- JS single-body SCP and JS multi-body Plexa: usable today. Confidence threshold defaults are conservative; tune per use case.
- Web-backend pattern: documented as one example; no Prometheus / Datadog wiring shipped, no human-approval UI shipped, no traffic simulator.
- Python bodies: the network body contract is documented and the cart-pole adapter exists; there is still no `pip install`-shaped Python SDK.
- Game NPC pattern: documented as a use case; no Godot / Unity plugin.

Still not started (unchanged):
- CRDT cross-body shared state.
- Process isolation per body.
- Python SDK published to PyPI.
- Godot / Unity plugins.
- Multi-region Plexa coordination.
- Authenticated introspection server.

---

**2026-04-14 evening -- v0.5.0 community-ready cut**

scp-protocol 0.3.3 -> 0.5.0:
- **AdaptiveMemory** layer 3 between pattern store and LLM. Similarity-scored store with weighted euclidean distance, k-nearest blending, confidence decay on failure, auto-purge at `failureThreshold`. SQLite persistence via `scp_adaptive` table. 28 tests. Exported from `scp-protocol`.
- **SCPBody four-layer decision stack**: `decideLocally` consults `patternStore` first, then `adaptiveMemory`, returning `{decision, confidence, source}` where source is `exact | similar | adaptive`. `learnFromBrain(entity, decision)` writes to both cache layers.
- **Graceful shutdown** helper `installShutdownHandlers()` on SCPBody saves patternStore + adaptiveMemory on SIGINT / SIGTERM.
- Pattern store save clears stale rows before insert (fixes cross-test pollution).

plexa 0.4.0 -> 0.5.0:
- **NetworkBodyAdapter rewired**: polls `/state` + `/events` on tick, POSTs `/tool`, discovers tools via `/discover`. `Space.addBody` auto-wraps a plain `BodyAdapter` with `static transport="http"` into a NetworkBodyAdapter proxy. Static tools path is sync; missing tools trigger `/discover` async; `space.ready()` awaits all discoveries.
- **VerticalMemory** at the Space level. SQLite persistence per space name. Jaccard similarity across bodies + tools + events + goal. `Space` consults memory before brain calls; confident match skips the LLM and writes hit stats. `memoryHits / memoryMisses / memoryHitRate` in `space.getStats()`.
- **Confidence gating** thresholds `{ autoApprove, monitor, escalate }`. Decisions via `onBodyDecision` emit `confidence_warning` or `confidence_escalation`. Per-body average tracked in `stats.avgConfidenceByBody`.
- **Lateral body-to-body events**: `space.link(from, to, [types])`, `space.unlink`, `body.sendToPeer`, `body.onPeerEvent`. Zero-latency in-process, no brain involvement, self-links ignored.
- **Cost tracking** in Brain base class. Per-1k-token USD table covers Nova Micro, Claude Haiku, GPT-4o-mini, local models ($0). `Space.getStats().estimatedCostUSD` and `costSavedByCacheUSD`.
- **Retry policy** in Brain base class: 2 retries with exponential backoff on 429, retries on network + 5xx, no retry on 4xx.
- **Space.stop() + installShutdownHandlers()** save vertical memory and each body's pattern store + adaptive memory on stop / SIGINT / SIGTERM.
- New test files: adaptive-memory (28), network-body (9), confidence-lateral (13), vertical-memory (11), cost-retry (13), integration (10 end-to-end).

Test counts:
- scp-protocol: 112 -> **145** (145 pass, 0 fail, 0 skip, 41 suites).
- plexa:       92 -> **181** (181 pass, 0 fail, 0 skip, 40 suites).
- integration: **10/10** (first tests spanning both packages).

README updates:
- Both packages' READMEs reflect v0.5 reality. Four-layer diagram on scp-protocol side, full stack diagram + 10-minute quickstart on plexa side. Honest "what is not implemented" sections updated.

Items still not started (unchanged from earlier audit):
- CRDT cross-body shared state.
- Process isolation per body.
- Python SDK.
- Godot / Unity plugins.
- Mintlify docs content pages (left as follow-up).

---

**2026-04-14 afternoon -- v0.4.0 cut**

Foundations:
- Fixed broken `hello-world` and `two-bodies` examples (rewritten as pure in-process demos against the v0.3 API).
- Bumped plexa's `scp-protocol` pin from `^0.1.1` to `^0.3.0`.
- Declared `ws` and `@aws-sdk/client-bedrock-runtime` as optional peer dependencies of scp-protocol.

New in Plexa:
- `BedrockBrain` (packages/bridges/bedrock.js) -- wraps scp-protocol's BedrockBridge. Uses the AWS SDK lazily via optional peer dep.
- `AnthropicBrain` (packages/bridges/anthropic.js) -- raw `node:https`, no SDK dep. `claude-haiku-4-5-20251001` default.
- `Space.addSafetyRule(rule)` -- synchronous hard gate, cannot be bypassed. Runs BEFORE approval. First blocker wins. Rules that throw are treated as block. Emits `safety_blocked`.
- `Space.addApprovalHook(hook)` -- async, optional. Can return `true` / `false` / modified command. Retargeting to an invalid body is auto-rejected. Runs AFTER safety, BEFORE `body.invokeTool`.
- `Aggregator` prompt-injection sanitizer -- strips role prefixes (`system:/user:/assistant:/human:`), chat template tokens (`<|im_start|>` etc), Anthropic `\n\nHuman:` markers, and known jailbreak directive phrases from body-supplied strings before they reach the brain. Tool definitions are preserved. Configurable via `new Space(name, { sanitizeInjection: false })`. Hits counted on `stats.injectionHits`, emitted as `security_event { type: "prompt_injection_detected" }`.

New tests:
- `tests/bridges.test.js` -- 8 tests for BedrockBrain + AnthropicBrain.
- `tests/safety-approval.test.js` -- 15 tests for safety rules + approval hook ordering.
- `tests/injection.test.js` -- 10 tests for aggregator sanitizer + Space security event.

Test counts:
- scp-protocol: 112 -> 112 (no change, peer-dep only).
- plexa: 92 -> 125.

Sections below reflect the repo BEFORE these changes for historical accuracy.

---

## Section 1: What is done

**scp-protocol v0.3.0**

- `PatternStore` with feature extraction, exact-hash lookup, similarity fallback, confidence scoring, exploration rate, smart eviction, in-memory hot cache
- `PatternStore.report(entity, success)` with per-pattern success/failure counters and consecutive-failure tracking
- Auto-invalidation at configurable `failureThreshold` (default 3)
- `pattern_invalidated` event (PatternStore extends EventEmitter)
- `PatternStore.getSuccessRate(entity)` inspection API
- `stats()` fields: hits, misses, explorations, corrections, invalidations, totalReports, totalSuccesses, totalFailures, averageSuccessRate, lowConfidencePatterns, hitRate
- localStorage persistence path (browser)
- SQLite persistence path with ALTER TABLE migrations (Node, lazy-required)
- `SCPBody` class (v0.2 API): static tools registry, `invokeTool(name, params)`, `decideLocally(entity)`, `notifyDecision(entity, decision, meta)`, `rememberCachedEntity`, `evaluateOutcome` override, `snapshot`, `setState`, `emit(type, payload, priority)`, queue cap with CRITICAL preservation, modes (`standalone`/`managed`), explicit transport (`inprocess`/`http`) with port validation
- `SCPAdapter` class (v0.1 legacy, still exported, different API)
- `SCPBridge` base class with `call`/`invoke`/stats
- `BedrockBridge` (wraps `@aws-sdk/client-bedrock-runtime` via lazy require)
- `OllamaBridge` (raw `node:http`, no ollama package)
- `OpenAIBridge` (raw `node:https`, no openai package)
- `SCPTransport` base class
- `HTTPTransport` (raw `node:http` server with `/emit`, `/poll`, `/health`)
- `WebSocketTransport` (lazy requires `ws` package, not declared as dependency)
- Dual CJS/ESM exports for core files (index, pattern-store, adapter, bridge)
- npm package published (scp-protocol@0.3.0)
- 112 tests across 9 suites, all passing (1 suite skipped if better-sqlite3 not compiled)

**@srk0102/plexa v0.3.1**

- `Space` class (extends EventEmitter), 60Hz default reactor loop using `setTimeout`
- `addBody(adapter)`: attaches body, reads `adapter.transport`, builds tool registry `"body.tool" -> { body, tool, def }`, emits `body_registered`
- `setBrain`, `setGoal`, `run`, `stop` lifecycle
- Reactor ticks every body via `body.tick()`, drains brain-response queue, fires brain call at `brainIntervalMs` interval (default 2000ms)
- `_dispatchIntent`: translator validates, direct call to `body.invokeTool`, emits `tool_dispatched`/`tool_error`
- `onBodyEvent(body, type, payload, priority)` emits `body_event`
- `onBodyDecision(body, entity, decision, meta)` emits `body_decision`, increments `stats.bodyDecisions`
- `BodyAdapter` / `SCPBody` (same class, two exports): matches scp-protocol's SCPBody API
- `NetworkBodyAdapter` class exists with `invokeTool` over `node:http` POST
- `Brain` base class with `invoke`, `buildPrompt` (includes tool param types, enum, min/max, required), `parseResponse` (JSON direct + regex fallback), `_validateIntent` with `tool`/`action` alias
- `Translator` with 7 reject reasons, parameter validation (type, enum, min/max, required, boolean), global allowlist
- `Aggregator` with priority-aware trimming, 2000-token default budget, CRITICAL preservation, tool-definitions embedded per body, staleness flag, float compaction, string truncation
- `OllamaBrain` bridge (raw `node:http` to `/api/chat`), `isAvailable` health check
- `attachIntrospection(space)` HTTP server on port 4747 with `/plexa/status`, `/plexa/bodies`, `/plexa/logs`, `/plexa/health`
- CLI at `bin/plexa`: version, help, status, bodies, logs, start
- CLI colors: ANSI escapes, priority palette (CRITICAL/HIGH/NORMAL/LOW), NO_COLOR respected, TTY-aware
- CLI spinner: 8-frame starfish morph using `setInterval`
- CLI panel: Unicode box drawing with `visibleLength`-aware padding
- `examples/inprocess-demo/index.js`: pure-JS CartpolePhysics + CartpoleBody + StubBrain fallback, opt-in Ollama, `attachIntrospection` wired. RUNS end-to-end.
- 92 tests across 14 suites, all passing
- npm package published (@srk0102/plexa@0.3.1)

**Brand**

- 8 SVGs in `Project-G/assets/logo/`: starfish.svg, icon-16/32/64, logo-full, logo-light, logo-dark, og-image
- Mintlify docs repo has starfish favicon + logo + "SCP vs Plexa" intro table

**Cross-repo published state**

- scp-protocol@0.3.0 live on npm with body.js + success-rate code
- @srk0102/plexa@0.3.1 live on npm with CLI + introspection + brand assets

---

## Section 2: What is partial

- `NetworkBodyAdapter` exists but Space.addBody does NOT auto-wrap HTTP-transport bodies in it. A user declaring `static transport = "http"` gets their own class dispatched directly and `invokeTool` works only if they implement it themselves. The proxy class is dead code unless manually instantiated.
- `NetworkBodyAdapter.tick()` is a no-op. Remote body state never makes it into the aggregator. Aggregator snapshots `body.snapshot()` which returns stale defaults for network bodies.
- Tool `stats.toolsRejected` in Space is incremented only when Translator rejects, not when a tool throws. Tool errors increment `toolErrors` separately, not `toolsRejected`.
- Aggregator: `truncated` body fields clear `last_action` but a dropped `last_action` can confuse downstream heuristics. Minor.
- SCP's `SCPAdapter` (v0.1) and `SCPBody` (v0.2) coexist with different APIs. No migration guide in code. Tests cover both but users may mix them.
- SCP's `WebSocketTransport` requires `ws` package at runtime but `ws` is NOT in scp-protocol's dependencies. A user installing `scp-protocol` alone and calling `new WebSocketTransport().start()` gets `Cannot find module 'ws'`. Undocumented peer dep.
- SCP's `BedrockBridge` requires `@aws-sdk/client-bedrock-runtime` lazily. Same undocumented peer-dep issue. Tests handle it by expecting the `MODULE_NOT_FOUND` error.
- Plexa's `examples/hello-world/index.js` and `examples/two-bodies/index.js` both reference deleted file `adapters/template/muscle.js`. They are broken. `inprocess-demo` is the only working example.
- Plexa's two-bodies example also uses `capabilities` constructor arg which was removed in v0.2, and the `_scpCall` private method from v0.1. Would throw if anyone tried to run it.
- Plexa's `package.json` declares `"scp-protocol": "^0.1.1"` as its dependency -- pin is two minors behind our latest scp-protocol@0.3.0. In-repo plexa does not actually use scp-protocol at runtime for inprocess bodies, but the manifest is wrong.
- Introspection server has hardcoded `version: "0.3.0"` in `/plexa/health` payload; actual package version is 0.3.1. Cosmetic bug.
- `body.tick()` throws propagate to Space where `tickErrors` counter increments, but the loop continues -- no per-body suspension. A consistently failing body ticks forever and floods the error channel.
- Python `mujoco-cartpole/muscle.py` has a `/discover` endpoint declaring tool schema but Plexa has no HTTP client that calls it. The class-level `CartpoleBody.TOOLS` in Python is informational, never consumed.
- `SCPBody.tick()` on scp-protocol side is a no-op stub. SCP repo has no Space to drive it. Only Plexa's Space actually calls tick.
- `SCPBody.clearPendingEvents()` exists on Plexa side but Plexa's Space never calls it. Events accumulate on bodies until `snapshot()` + aggregator reads them (aggregator calls clear).
- `PatternStore.save()/load()` are wired for localStorage and SQLite but there is no auto-save on shutdown. A running body losing power loses patterns.
- CLI `plexa start <config>` loader is implemented but never exercised in tests.
- CLI `plexa logs` polls every 600ms; high-frequency event streams miss lines between polls because server keeps only the last 500 events.

---

## Section 3: What is not started

- CRDT shared state between bodies (no `yjs`, no `automerge`, no shared state structure at all)
- Lateral body-to-body events (bodies cannot emit events to another body; everything goes through Space broadcast)
- Vertical memory (no store, no retrieval, no embedding, no long-term memory; only a 10-entry in-memory `history` array in Space)
- L2 verified pattern tier (only one tier exists)
- Micro-policy / small classifier layer (no neural network, no ONNX, no training loop; planned in PLAN.md only)
- Live distillation (mentioned in roadmap, zero code)
- Safety gate tier that validates LLM decisions before caching (reflexes exist in muscle code but no orchestrator-level safety check)
- Process isolation per body (bodies run in-process or subprocess; no Freedom-from-Interference guarantees)
- SPSC ring buffers (arrays with slice)
- LMAX Disruptor pattern (aspirational)
- Python SDK (`pip install plexa` does not exist)
- Godot plugin
- Unity plugin
- MQTT transport
- gRPC transport
- Serial transport
- Outcome evaluation triggered by Space (currently only triggered inside `body.invokeTool` via `evaluateOutcome` override)
- Configurable brain backpressure / rate limiting beyond `brainIntervalMs`
- Retry policy on Brain errors
- Cost tracking per brain call
- Multi-space isolation (one process = one Space assumed)
- Authentication on introspection server (port 4747 is open)
- Authentication on HTTPTransport (port 3000 is open)
- Authentication on NetworkBodyAdapter (body HTTP endpoints are open)
- Any kind of auth or TLS anywhere
- Task completion / success criteria feedback to brain
- Goal decomposition (activeGoal is a string, never acted on)
- Remaining 5 Mintlify docs pages (concepts, adapter, pattern-store, bridges, roadmap, faq)

---

## Section 4: Origins audit

| Component | Classification | Notes |
|-----------|---------------|-------|
| PatternStore exact-hash lookup | **INVENTED** | Plain Map keyed by sorted feature string |
| PatternStore similarity matching | **BORROWED** (k-NN concept, own scoring) | Own ratio-based numeric distance + string/bool equality |
| PatternStore confidence scoring | **INVENTED** | `count / 20` linear float, not Bayesian |
| PatternStore exploration rate | **BORROWED** (epsilon-greedy from RL) | Own `Math.random() < rate` |
| PatternStore smart eviction | **INVENTED** | Linear scan for lowest count |
| PatternStore success rate monitoring | **INVENTED** | Own counters, own invalidation threshold |
| SQLite persistence | **DEPENDENCY** (`better-sqlite3`) | Our schema + queries, lazy-required |
| localStorage persistence | **DEPENDENCY** (browser platform) | Direct getItem/setItem |
| Event prioritization (CRITICAL/HIGH/NORMAL/LOW) | **BORROWED** (syslog severity levels) | Own enum, own trim order |
| Event queue cap with CRITICAL preservation | **INVENTED** | Slice-based, no ring buffer |
| Reactor loop (60Hz tick via setTimeout) | **INVENTED** | Relies on Node's libuv event loop as platform |
| Tool calling system (static tools + invokeTool) | **BORROWED** (MCP tool shape) | Own class wiring, own parameter schema |
| InProcess transport | **INVENTED** | Literally a direct async method call. No transport object. |
| HTTP transport | **INVENTED wrapper** (on `node:http`) | No Express, no Fastify, raw server |
| WebSocket transport | **DEPENDENCY** (`ws` package, lazy-required) | Undeclared peer dep |
| BedrockBridge | **DEPENDENCY wrapper** (`@aws-sdk/client-bedrock-runtime`) | ~60 lines wrapping ConverseCommand |
| OllamaBridge | **INVENTED wrapper** (raw `node:http`) | No ollama package |
| OpenAIBridge | **INVENTED wrapper** (raw `node:https`) | No openai package |
| Brain base class | **INVENTED** | Timing wrapper + prompt builder + JSON parse-or-regex-extract |
| Aggregator token budget | **INVENTED** | `JSON.stringify(obj).length / 4` heuristic, no tokenizer library |
| Aggregator priority-aware trimming | **INVENTED** | Seven-step reduction cascade |
| Translator validation | **INVENTED** | Subset of JSON Schema, no ajv/zod |
| CRDT shared state | **NOT STARTED** | Zero code |
| Lateral events | **NOT STARTED** | Zero code |
| Vertical memory | **NOT STARTED** | 10-entry history array is not memory |
| Micro-policy layer | **NOT STARTED** | Zero code |
| CLI spinner | **INVENTED** | `setInterval` + frame array, no ora |
| CLI panels | **INVENTED** | Unicode box-drawing characters, no boxen |
| CLI colors | **INVENTED** | Raw ANSI escapes, no chalk |
| Introspection HTTP server | **INVENTED** | Raw `node:http`, our routes |

---

## Section 5: All dependencies

**scp-protocol (D:/scp-mvp/packages/scp-core/package.json)**

```
better-sqlite3 ^11.0.0       (the only declared prod dep)
```

Undeclared peer dependencies used via lazy require:

```
@aws-sdk/client-bedrock-runtime   (for BedrockBridge)
ws                                (for WebSocketTransport)
```

**@srk0102/plexa (D:/Project-G/package.json)**

```
scp-protocol ^0.1.1           (the only declared prod dep; stale pin -- should be ^0.3.0)
```

Plexa's own core (Space, BodyAdapter, Translator, Aggregator, Brain, OllamaBrain, Introspection, CLI) uses ZERO external packages at runtime. Only `node:*` built-ins.

**Python adapters**

mujoco-cartpole (D:/Project-G/adapters/mujoco-cartpole): no requirements.txt. Relies on whatever the caller installed globally.

mujoco-ant (D:/scp-mvp/adapters/mujoco-ant/requirements.txt):
```
mujoco >= 3.0.0
numpy
requests
```

mujoco-cartpole in SCP repo: no requirements.txt.

**Demo/test-only dependencies (NOT in any published package)**

server/package.json (scp-mvp dev infrastructure, not published):
```
@aws-sdk/client-bedrock-runtime ^3.1029.0
@modelcontextprotocol/sdk       ^1.0.4
ws                              ^8.18.0
zod                             ^3.23.8
```

---

## Section 6: Test count

**scp-protocol (run: `npm test` in D:/scp-mvp/packages/scp-core)**

```
Total: 112 tests, 32 suites, 112 passing, 0 failing, 1 suite skipped (SQLite, skipped when better-sqlite3 unavailable)
```

Per file:

| File | Tests |
|------|------:|
| adapter.test.js | 14 |
| bridge.test.js | 10 |
| bridges.test.js | 10 |
| integration.test.js | 7 |
| managed-mode.test.js | 8 |
| pattern-store.test.js | 23 |
| persistence.test.js | 5 |
| success-rate.test.js | 28 |
| transports.test.js | 10 |

**@srk0102/plexa (run: `npm test` in D:/Project-G)**

```
Total: 92 tests, 14 suites, 92 passing, 0 failing
```

Per file:

| File | Tests |
|------|------:|
| plexa.test.js | 82 |
| managed-mode.test.js | 10 |

**Integration tests between scp-protocol and plexa**: ZERO. No tests import both packages together.

**Tests missing that should exist**:

- End-to-end test: LLM returns a tool call, Space dispatches to a real SCPBody, outcome reported, pattern store updated
- NetworkBodyAdapter over real HTTP against a mock server
- HTTPTransport integration test with multiple clients
- WebSocketTransport (only a stub test exists; no actual ws client/server test)
- CLI commands (no tests at all for bin/plexa)
- Introspection server (no tests)
- `plexa start` config loader (never exercised)
- Examples (hello-world, two-bodies, inprocess-demo) -- none are run as tests
- Reactor-loop concurrency (what happens if tick takes longer than tickMs)
- Backpressure: brain returning slower than brainIntervalMs
- Aggregator under extreme load (1000s of events per tick)

---

## Section 7: Honest production readiness

**Can a JS developer use this today without issues?** Partially. Inprocess single-body case works. Multi-body with network transport has NetworkBodyAdapter dead-coded. Two of three examples are broken.

**Can a Python developer use this today?** No. There is no Python SDK. `adapters/mujoco-cartpole/muscle.py` exists but only integrates manually via HTTP. No `pip install plexa`, no Python client library, no documented Python body contract.

**Can a game developer use this today?** No. No Godot plugin, no Unity plugin, no Lottie adapter, no game-engine integration. The browser canvas adapters are one-off demos in the SCP repo, not a library.

**Is managed mode fully fixed?** Yes for the primitive. Body intelligence is preserved in managed mode in both SCP's `SCPBody` and Plexa's `BodyAdapter`. `decideLocally` uses the pattern store; `notifyDecision` pushes to Space. Tests pass. The only gap: there is no concrete adapter that actually calls `decideLocally` in a realistic loop yet.

**Do bodies stay intelligent in managed mode?** Yes on the JS side. The Python muscle.py also kept its pattern-store path active in managed mode. But the Plexa orchestrator does nothing with `body_decision` events beyond logging them to a 10-entry history. The "intelligence" is local only.

**Is lateral communication between bodies working?** No. A body cannot emit a targeted event to another body. All events go through Space's `emit("body_event", ...)` fan-out. No direct body-to-body channel.

**Is vertical memory implemented?** No. The name `onBodyDecision` is aspirational. It appends a string to a 10-entry rolling history. That is not memory. No embedding, no retrieval, no long-term persistence, no cross-session recall.

**Is micro-policy implemented?** No. Zero code. The pattern store is a hash-map cache, not a classifier.

**Is evaluation loop fully wired end to end?** Partially. A body that overrides `evaluateOutcome` gets auto-reports after `invokeTool`. But: (1) the body must also call `rememberCachedEntity` first, (2) the Space does not call `body.tick()`-driven evaluation, (3) LLM-dispatched tools never get outcome-reported because `rememberCachedEntity` was not called for those decisions. It is wired only for the narrow path where the body's own code looks up the cache first.

**Are process isolation and safety layer done?** No. Bodies share the Node process. No sandbox. No resource limits. Safety is at the reflex layer inside each body's subclass -- enforced per body, not by the framework. No orchestrator-level safety gate validates LLM decisions before they reach the body.

---

## Section 8: Build order recommendation

Ranked by leverage (what unblocks the most once landed):

1. Fix the broken examples (hello-world, two-bodies) so the demos on GitHub actually run. 0.5 days.
2. Declare `ws` and `@aws-sdk/client-bedrock-runtime` as `peerDependencies` (or move to `optionalDependencies`) in scp-protocol. Bump pin of `scp-protocol` in plexa to `^0.3.0`. 0.5 days.
3. Auto-wrap HTTP-transport bodies in `NetworkBodyAdapter` inside `Space.addBody`. Implement `NetworkBodyAdapter.tick()` to poll `/state` + `/events` from the remote body. Wire Python muscle.py's `/discover` endpoint into Plexa so tools are auto-registered. 2 days.
4. End-to-end integration test: real LLM (or mock) -> Space -> SCPBody subclass -> pattern store outcome. First cross-package test. 1 day.
5. Safety gate: a `Safety` hook Space runs on every LLM intent before dispatch. Blocks cache write and body dispatch if validator rejects. 1.5 days.
6. Persistent vertical memory: replace Space's 10-entry string history with a SQLite table per Space that stores body-decision events with timestamps, searchable by body/tool/decision. 2 days.
7. Lateral channel: `space.routeToBody(bodyName, eventType, payload)` for body-to-body messages without broadcasting. 1 day.
8. Python SDK: `pip install @srk0102/plexa-py`. Thin client that registers a body class with Plexa over HTTP (using existing HTTPTransport) and auto-proxies tool calls. 3 days.
9. Retry policy + cost tracking in Brain base class. 1 day.
10. Introspection auth (bearer token or UNIX socket) + CLI support for it. 1 day.

Total: ~13 days of real work to close the obvious gaps.

---

## Section 9: What is genuinely novel

These things exist in this codebase and I cannot find them combined anywhere else in open source:

1. **PatternStore with success-rate self-invalidation + similarity + exploration + SQLite persistence in one data structure.** Each primitive exists elsewhere (k-NN, LRU, epsilon-greedy, failure counters). The combination packaged as a single `require()` with zero ML dependencies is specific to this code. See `packages/scp-core/pattern-store.js` lines 195-243.

2. **`decideLocally` + `notifyDecision` pattern.** A body that uses its own cache at muscle speed while a passive orchestrator observes every decision without interfering. This is neither MCP (brain-initiated), LangGraph (stateless), nor a classic agent loop (brain-per-action). See `packages/scp-core/body.js` lines 127-146 and `packages/core/body-adapter.js` lines 107-150.

3. **Aggregator that trims in priority order down to CRITICAL-only before dropping bodies.** Seven-step cascade that guarantees CRITICAL events reach the brain even under severe token budget pressure. `packages/core/aggregator.js` lines 137-193. Not a general feature of LangChain/LlamaIndex aggregators.

4. **Explicit `transport` as a static class field where `inprocess` is the default and network is opt-in.** Bodies declare `static transport = "http"` to leave the process. Same developer API either way. Nothing else in the embodied-AI ecosystem does this -- MCP is always network, LangGraph is always in-process, ROS is always message-bus. See `packages/core/body-adapter.js` lines 34-44.

5. **Structured tool calling contract with per-parameter schema rendered into the LLM prompt automatically.** The Brain's `buildPrompt` reads `static tools` on every body and expands each parameter's type/enum/min/max/required into natural language. This closed the v0.1 test failure where Ollama returned numbers for enum fields. `packages/core/brain.js` lines 59-79.

6. **Zero-dependency CLI with a Unicode starfish spinner, ANSI priority-colored log stream, and a running-process introspection server on a well-known port.** Every similar framework requires chalk/ora/boxen or a full TUI library. This is ~700 lines of JS across four files. `packages/cli/*.js` and `packages/core/introspection.js`.

7. **Cross-language body protocol where JS is inprocess-first and Python is network-first, with the same schema shape visible to the LLM.** The `SCPBody.TOOLS` class-level dict in Python mirrors the JS `static tools` object, intentionally. There is no ROS/gRPC/ZeroMQ dependency. `adapters/mujoco-cartpole/muscle.py` + `packages/scp-core/body.js`.

None of the seven is a published research result. Each is a small engineering decision. The honest claim is not that any single item is novel -- it is that the combination and the "zero deps + one file per concept" discipline are not present in any existing project I can find.

What is NOT novel, despite framing in earlier docs:

- The three-layer reflex/muscle/brain split. That is Brooks 1986 Subsumption Architecture. We credit it but do not invent it.
- The LLM-as-cache-teacher idea. Variants exist in RAG, agent memory research (MemGPT, Letta), and muscle-mem.
- Priority-tiered event trimming. Standard syslog pattern.
- Setting a system prompt for an LLM. Every framework does this.
- Event-emitter architectures. That is Node core.
