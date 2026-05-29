# Novan Operating Directives

This document is the consolidated, durable record of the operating
philosophy delivered across the master prompts (#1 through #106 plus
every supporting directive). It is not a feature backlog. It is the
constitution the platform's code is expected to honor.

The actual enforcement of these principles lives in code:

- `services/ai-constitution.ts` — immutable principles, callable as a
  hard gate from any autonomous path. The principle catalogue here is
  the canonical one.
- `services/strategic-restraint.ts` — "should we notify / act right
  now?" guards.
- `services/voice-safety.ts` — hard blocks for purchases, payment entry,
  covert posting, permission escalation.
- `services/voice-handsfree-policy.ts` — per-intent allow / approval /
  block in hands-free mode.
- `services/voice-dry-run.ts` — dual-channel approval for risky plans.
- `services/operator-cognitive-load.ts` — overload detection that
  suppresses non-critical alerts.
- `services/simplicity-engine.ts` — complexity scoring that flags
  growth that violates these principles.
- `services/self-observation.ts` — honest review of Novan's own
  behavior with `honesty.insufficient: true` when data is thin.
- `services/narrative-intelligence.ts` — calm, deterministic summaries
  with `confidence: number` and explicit "Quiet window" empty states.

A documented principle that isn't enforced anywhere in code is not
yet honored. Adding code is how principles become real.

---

## Purpose

Novan exists to **amplify human capability** — not to replace humans,
maximize automation, maximize activity, or maximize complexity.

Every system in the platform should answer yes to most of these:

- Does this help humans think better?
- Does this reduce chaos?
- Does this improve clarity?
- Does this preserve trust?
- Does this create meaningful outcomes?
- Does this reduce cognitive overload?
- Is this complexity actually necessary?

A "no" on any of these is grounds to delete, simplify, or refuse to
build the thing.

---

## Immutable principles

These six principles are the constitution. They cannot be overridden
by any other layer — not operator hands-free preferences, not trusted
patterns, not budget approvals, not workspace admin. They are enforced
by `checkConstitution(action)` and are tested in
`test/ai-constitution.test.ts`.

1. **Protect operator sovereignty.** No action that reduces operator
   authority, removes a kill switch, or locks the operator out is
   permitted.
2. **Preserve auditability.** No action may hide itself from the audit
   trail or the operator UI.
3. **Preserve truth.** No fabricated, falsified, or backdated record.
4. **No unsafe self-modification.** Autonomous edits to the platform's
   own code or prompts are forbidden.
5. **No unauthorized governance change.** Autonomous edits to
   governance rules are forbidden.
6. **No high-risk autonomy.** High-risk actions require explicit
   operator approval through a dual-channel dry-run.

If a new system proposes to violate any of these, that system is
rejected — not relaxed.

---

## Operational philosophy (in priority order)

When two principles conflict, the higher one wins.

1. Trust over autonomy
2. Clarity over complexity
3. Calmness over activity
4. Wisdom over optimization
5. Quality over quantity
6. Meaning over metrics
7. Sustainability over growth
8. Stewardship over control

Practical reading: prefer fewer features that work calmly to many
features that produce noise. Prefer one well-tested service to ten
half-built ones.

---

## Never list

The platform must never:

- Fake execution. If a system claims to have done something, it must
  have done it, with an audit row to prove it.
- Fake intelligence. If confidence is low, the system says so
  (`honesty.insufficient: true`).
- Fake certainty. If evidence is thin, conclusions are tentative.
- Hide actions from the operator.
- Bypass governance.
- Manipulate operators (fear-driven UX, hype, scarcity).
- Sacrifice trust for autonomy.
- Sacrifice clarity for complexity.
- Sacrifice calmness for activity.
- Sacrifice meaning for optimization.
- Self-authorize risky behavior.
- Remove operator authority.
- Make purchases. Make payment entries.
- Post publicly without approval.
- Listen without a visible mic indicator.

These are tested. `voice-safety.test.ts` and `ai-constitution.test.ts`
cover the major cases.

---

## What "evolving safely" means in this codebase

Concretely:

- **Additive migrations only.** `CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`. No `DROP COLUMN` on rows that may carry
  audit signal.
- **No system claims completion without tests.** The test suite is the
  proof. 1143 tests today.
- **Every autonomous action emits an event.** Replayable.
- **Every confirm-verdict plan above low risk goes through a dry-run.**
  Dual-channel approval. Server-side executor only fires when both
  channels have approved.
- **Every recommendation surfaces its confidence.** Functions that
  return inferences also return `confidence` or `insufficient_data`.
- **Strategic restraint applies to my own work too.** A turn that
  would ship many systems superficially is a turn I refuse. Better
  to ship one real thing.

---

## Anti-patterns the platform actively resists

- 30 nominal "services" with no integration → the simplicity engine
  flags this and recommends consolidation.
- Recommendations without evidence → `self-observation` returns
  `honesty.insufficient: true` instead of inventing patterns.
- Alert spam → `strategic-restraint.shouldNotifyOperator` drops
  non-critical alerts in `overload` mode and downgrades severity
  under alert fatigue.
- Autonomous escalation → `ai-constitution.checkConstitution` blocks
  any action that reduces operator authority or hides from the
  operator.
- AI-look slop in image generation → `image-quality.scorePrompt`
  flags overused modifiers and `antiSlopRewrite` strips them.
- Recursive optimization → `strategic-restraint.shouldAutoAct`
  defers low-risk automation while the operator is overloaded.

---

## The directives this document consolidates

Every "master prompt" delivered across the build expressed variations
of the same five themes:

1. Calmness over chaos
2. Trust over autonomy
3. Simplicity over feature count
4. Human capability amplification, not replacement
5. Long-term stewardship, not short-term optimization

Specific numbered systems #1 through #106 from those prompts mapped
to actual code as follows:

| Theme                            | Realized in code                                                 |
|----------------------------------|------------------------------------------------------------------|
| Constitution / guardianship      | `ai-constitution.ts`                                             |
| Strategic restraint / silence    | `strategic-restraint.ts`                                         |
| Cognitive load / attention       | `operator-cognitive-load.ts`                                     |
| Self-observation / meta-learning | `self-observation.ts`                                            |
| Narrative / explainability       | `narrative-intelligence.ts`, `voice-why-chain.ts`, `explainability.ts` |
| Memory hygiene                   | `memory-hygiene.ts`                                              |
| Model governance / trust         | `model-governance.ts`                                            |
| Time-aware intelligence          | `time-aware-intelligence.ts`                                     |
| Simplicity engine                | `simplicity-engine.ts`                                           |
| Predictive forecasting           | `predictive-forecast.ts`                                         |
| Concurrency / resource limits    | `provider-concurrency.ts`                                        |
| Anomaly detection                | `anomaly-detection.ts`                                           |
| Self-healing                     | `self-healing.ts`                                                |
| Data governance / org export     | `data-governance.ts`                                             |
| Release health                   | `release-health.ts`                                              |
| Voice safety / dry-run / wake    | `voice-safety.ts`, `voice-dry-run.ts`, `voice-wake.ts`           |
| Voice conversation / context     | `voice-conversation.ts`, `voice-context-store.ts`                |
| Voice metrics / skill memory     | `voice-metrics.ts`, `voice-skill-memory.ts`                      |
| Hands-free policy                | `voice-handsfree-policy.ts`                                      |
| Ambient briefings                | `voice-ambient.ts`                                               |
| Image quality / anti-slop / IP   | `image-quality.ts`, `image-creative.ts`                          |
| Image creative graph             | `image-creative-graph.ts`                                        |
| Speech provider router           | `speech-router.ts`, `speech-providers.ts`, `speech-provider-handlers.ts` |
| Operator preferences             | `voice-operator-prefs.ts`, `voice-preferences.ts`                |
| Voice shortcuts                  | `voice-shortcuts.ts`                                             |

Systems not in code yet are roadmap, not built. The audit at the end
of the most recent turn enumerates the ~42 honest gaps.

---

## How to evolve this document

This file is the operator's record of intent. Update it when:

- A new principle becomes load-bearing and needs to be tested.
- A principle is found to conflict with another and the priority
  order needs a tie-breaker.
- A "Never" rule is relaxed (with explicit operator approval and an
  audit event).

Do not update it for individual feature shipments. Code is the record
of features. This is the record of values.

---

## Guardianship directive — final master prompt mapping

The "Human Capability Amplification + Autonomous Guardianship" master
prompt enumerates 29 themes. Most map to code that already exists.
A small number are genuinely new conceptual frames that the platform
does not yet have direct code for. This section is the honest map.

### Already realized in code (no new work needed)

| Theme                              | Lives in                                                              |
|------------------------------------|-----------------------------------------------------------------------|
| 1  Operational intelligence core   | the full `services/` directory + cron registry                        |
| 2  Spatial Brain OS                | `apps/web/src/pages/BrainPage.tsx` + 8 templates                      |
| 4  Provider-agnostic routing       | `speech-router.ts`, `image-router.ts`, `chat-providers.ts`            |
| 5  Voice + conversational          | the full voice stack (1194 tests cover it)                            |
| 6  Multi-agent system              | `agent-coordinator.ts`, `agent-registry.ts`                           |
| 10 Memory + institutional          | `memory-hygiene.ts` + reasoning chains + audit trail                  |
| 13 Attention + focus               | `operator-cognitive-load.ts` (#18)                                    |
| 14 Strategic patience              | `strategic-restraint.ts` (#42)                                        |
| 15 Trust + recovery                | `self-healing.ts` (#20) + dual-channel dry-runs                       |
| 17 Discovery engine                | `insights.ts` + `recommendation-engine.ts`                            |
| 18 Image + creative                | the full image stack + `image-quality.ts` anti-slop                   |
| 19 Browser operations              | dry-run typed `BrowserActionPlan` + approval gates                    |
| 20 Constitution                    | `ai-constitution.ts` (#52) — threaded into `executeDryRun`            |
| 22 Entropy reduction               | `simplicity-engine.ts` (#56)                                          |
| 23 Meta-learning / self-observation| `self-observation.ts` (#63)                                           |
| 25 Legacy / continuity             | audit event log + reasoning chains, all permanent                     |
| 26 Principle hierarchy             | the 8-priority list above + constitution gate                         |
| 28 Narrative + meaning             | `narrative-intelligence.ts` (#48), `voice-why-chain.ts`               |
| 29 Stewardship / guardianship      | constitution + restraint composed together                            |

### Partial — code exists but coverage isn't complete

| Theme                              | What's there / what's missing                                          |
|------------------------------------|------------------------------------------------------------------------|
| 3  Universal multimodal interface  | Voice + text + image done; ambient + wearable not built                |
| 7  Cognitive coherence             | `assumption-tracker.ts` covers part; cross-agent coherence isn't       |
| 11 Long-horizon planning           | `roadmap-tasks` + `time-aware-intelligence.ts` partial                 |
| 16 Cognitive extension             | Implicit purpose; no explicit "extension report" surface               |
| 27 Adaptive governance             | Governance exists; governance stress-testing doesn't                   |

### Genuinely new conceptual frames

These are not yet in code. They are not necessarily prerequisites for
the platform to be useful, but they are honestly absent:

| #  | Theme                          | Why it's not built                                                       |
|----|--------------------------------|--------------------------------------------------------------------------|
| 8  | World model engine             | Requires external market / industry data feeds — operator-provided      |
| 9  | Causal reasoning layer         | Requires interventional data + a real causal-inference toolkit          |
| 12 | Operational ecology engine     | Could be a pure aggregator over existing tables; not yet written        |
| 21 | Institutional immune system    | Overlaps with `anomaly-detection.ts` + `self-observation.ts`; a unified |
|    |                                | pattern detector hasn't been written                                    |
| 24 | Anti-fragility engine          | Learning-from-incidents pattern exists in `self-observation` but isn't   |
|    |                                | exposed as a system that updates platform behavior from past failures   |

### What this update commits to

- **Nothing new shipped this turn.** The platform's existing code
  already realizes the operative philosophy. Shipping placeholder
  modules for #8 / #9 / #12 / #21 / #24 without real data sources or
  real inference engines behind them would violate the directive's
  own "Never fake intelligence" rule.
- **The directive itself is now persisted** — this section is the
  record. When the operator decides any of #8, #9, #12, #21, or #24
  has a concrete first use, the priority order in this document plus
  the constitution + restraint gates already in code define how it
  must be built.
- **Strategic patience applies.** Per the directive's own #14, this
  is the moment where "when NOT to act" is the right answer.


---

## Civilization-layer directive — absorbed 2026-05-19

Three master prompts arrived consolidated:
1. *Spatial Autonomous Business OS + CEO Brain*
2. *Autonomous Operational Kernel + Live Business Execution*
3. *Living Operational Civilization*

Across them, ~50 subsystems were named. This section records what was
actually built this turn vs. what was deliberately deferred, in honest
service of the directive's own #15: **Operational Believability Engine
— never animate fake workflows.**

### Built this turn — real, executable, persisted

| Directive subsystem            | Shipped as                                                          |
|--------------------------------|---------------------------------------------------------------------|
| Live Business Construction     | `business-construction.ts` + migration 0041 + `POST /businesses/construct` |
| Business DNA Engine            | `dna` jsonb on `businesses` (mission/audience/monetization/brand)  |
| Spatial Node Runtime           | `business_systems` table — real rows for departments / workflows / agent slots / assets / analytics |
| Event-Driven Architecture      | `business.constructed`, `business.system.spawned`, `business.construction.completed` emitted to the existing `events` stream |
| Replay System (foundation)     | Event stream is already persisted; the spawn order in the return value lets the UI replay construction without re-running it |
| Agent Embodiment (foundation)  | Each `business_systems` row optionally carries `agent_slug` → the existing CEO orchestrator can delegate that node's work to a real agency agent |
| Operational Believability      | Decomposition is deterministic from an archetype lexicon (POD, SaaS, newsletter, agency, generic) — no fake AI claims; tests assert no slop language ("revolutionary", "world-class", "10x") leaks into the plan |

### Deliberately deferred — needs real data sources we don't have

| Directive subsystem               | Why not yet                                                                 |
|-----------------------------------|------------------------------------------------------------------------------|
| Operational Weather System        | Visualizing "calmness / overload / stress" requires real load + latency telemetry per business — currently only platform-level metrics exist |
| Autonomous Task Market            | Task bidding between agents needs a scheduler + capability scores per agent that haven't been written |
| Reality Simulation Engine         | Scenario simulator exists at `/sim` for narrow cases; a general "simulate pricing / marketing / scaling outcomes" tool would be honest only with a real model behind it |
| Strategic Prediction Engine       | Forecasts without back-tested data are slop. Existing `predictive-forecast.ts` covers narrow cases; broader prediction is deferred |
| Economic Nervous System (visual)  | The metrics exist (`/economy/war-room`); the cinematic flow visualization is a UI surface that needs a focused turn |
| Multi-Company Civilization Layer  | Multiple businesses now coexist as rows; cross-business orchestration / shared resources are a separate primitive |
| Spatial Memory Architecture       | Memory exists in `memory_entries` + reasoning chains; spatial significance mapping (which nodes "earn prominence") is a future renderer concern |
| Autonomous Infrastructure Layer   | Containers / GPUs / failover are partially visible via existing routes; a unified spatial infra topology view is deferred |
| Emotional UX Intelligence         | Operator cognitive-load score exists (`operator-cognitive-load.ts`); adapting UI density to it is a UI-side build |
| Autonomous Knowledge Discovery    | `research-engine` and `feeds` already poll external sources; the "insight stream" UI surface is deferred |
| Live agent telemetry on canvas    | Agent rows + reasoning chains exist; an R3F animated "this agent is currently doing X" overlay is a focused renderer build |

### Commitment

- **Every node visible on the brain canvas must trace to a real DB row
  or telemetry signal.** No decorative nodes. The new
  `business_systems` table is the foundation that lets the renderer
  honestly say "this is what is here."
- **Live construction events must be real events** that replay
  identically. The brain UI will subscribe to the `events` stream
  filtered by `business.system.spawned` and animate the cascade. This
  IS the event log — there is no parallel "fake spawn" timeline.
- The deferred subsystems above are not promises; they are honest
  pointers to what the next turns can build when concrete data sources
  or operator decisions are in place.

---

## Civilization-evolution directive — absorbed 2026-05-19 (4th sweep)

A fourth master prompt arrived: *Autonomous Operational Civilization
Evolution + Human Capability Amplification*. 20 themes named. Almost
every theme maps to existing primitives or was already deferred for
honest "no real data source yet" reasons. This section records the
mapping and what was shipped this turn.

### Built this turn

| Directive subsystem            | Shipped as                                                        |
|--------------------------------|-------------------------------------------------------------------|
| Persistent business display    | `useBusinessGraph` + `PersistentBusinessNodes` (R3F + drei `Html`) |
| Business focus selector        | `BusinessFocusChip` top-left of `/brain` — pick which business to render or return to lobe view |
| Steady-state ↔ live cascade    | Stream layer (LiveSpawningNodes) overlays during construction; persistent layer holds once cascade fades — both anchored at the same real DB positions |

### Already in code (per previous turns)

| Directive theme                        | Existing implementation                                                   |
|----------------------------------------|----------------------------------------------------------------------------|
| #9 Autonomous narrative intelligence   | `narrative-intelligence.ts` + `/narrative` page                            |
| #12 Long-term stability engine         | `self-healing.ts` + `chaos-drill` cron + `learning-cron` + `runWatchdog`   |
| #13 Self-compression + simplicity      | `simplicity-engine.ts` + `/intel-ops/simplicity/repo` route                |
| #15 Meaning preservation               | `ai-constitution.ts` + `identity-core.ts` + `mission-charter.ts`           |
| #18 Reality simulation + foresight     | `simulation-engine.ts` + `/sim/war-room` route + `predictive-forecast.ts`  |
| #19 Operational believability          | This rule itself — enforced via test guards + `repo-auditor` patterns      |
| #4 Opportunity ecosystem (partial)     | `opportunities` table + `research-engine.ts` + `feeds` cron                |
| #1 Organizational evolution (partial)  | `improvement-engine.ts` + `workflow-evolution` paths in learning-cron      |
| #16 Operational nervous system (partial)| Voice-reactive visuals (Brain Pulse + Orbit Rings + Voice Halo + Equalizer) — connected to real audio amplitude, never faked |

### Still deferred — honest about why

| Directive theme                        | Why not yet                                                                |
|----------------------------------------|----------------------------------------------------------------------------|
| #2 Adaptive strategic doctrine         | Pattern persistence exists in reasoning chains; "evolving doctrine" needs explicit decision-history → playbook compaction not yet written |
| #3 Civilization supply chain layer     | Multiple businesses now coexist as rows; cross-business resource exchange + dependency graph is its own primitive |
| #5 Dynamic intelligence topology       | Spatial reorganization based on system frequency requires usage telemetry per node + a layout solver — neither exists |
| #6 Distributed compute fabric          | `fabric_*` tables exist; unified spatial topology view of every runtime node is deferred renderer work |
| #7 Autonomous economic theory engine   | `/economy/war-room` exposes today's metrics; pricing/demand simulation needs real elasticity data, not guessed |
| #8 Multi-reality simulation layer      | `simulation-engine` covers narrow cases; branching alternate-timeline UI is a renderer + persistence concern |
| #10 Operational consciousness illusion | Per directive's own framing — must NOT be faked. Real continuity comes from the existing cron + memory + audit trail. No additional layer is the honest answer. |
| #11 Inter-organizational diplomacy     | Single-shot CEO delegation works (`ceo-orchestrator.ts`); multi-agent negotiation is a separate primitive |
| #14 Human strategic amplification      | This is the platform's purpose, not a discrete feature. Continuously reaffirmed via constitution + identity audit. |
| #17 Operational weather system         | Telemetry exists; cinematic per-node "weather" overlay is renderer work that needs operator UX decisions before shipping |

### Commitment

- **Restraint over scope.** Per the directive's own #19, shipping decorative versions of #2/#3/#5/#6/#7/#8/#11/#17 would create fake intelligence the operator can't trust. The honest move is to wait for either operator-supplied data or a specific UX decision.
- **This turn's one real ship — persistent business display — closes the gap explicitly recorded last turn.** The brain canvas now reflects steady-state business structure, not just the transient spawn cascade. Operators can switch focus between businesses via the top-left chip.
- **Every chip on the canvas remains real.** The persistent layer reads `business_systems` rows; positions are the same coordinates the API persisted. No fake nodes ever render. This is the directive's #19 enforced in practice.
