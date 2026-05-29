# SPEC Coverage — Current State of Novan vs. SPEC.md

> Snapshot of the codebase against the canonical specification at
> `docs/SPEC.md`. Update this file whenever a spec section's coverage
> changes meaningfully. See SPEC.md sections (e.g. §5.7) for the
> requirement; this file maps to implementation files.
>
> **Tracks against SPEC revision R3.** When SPEC evolves, bump this
> file's revision marker too.

Legend: ✅ implemented · ◐ partial · ⏳ planned · 🔒 needs human/external action (not a code build)

---

## Section 2 — Architecture Overview

| Layer | Status | Implementation |
|---|---|---|
| L0 Infrastructure | ◐ | `DEPLOY.md`, `docker-compose.production.yml`, `render.yaml`, `boot.sh`. Single-deploy by design. Multi-cloud + Terraform is 🔒 operator's cloud decision |
| L1 Security and identity | ✅ | vault-master-key, RBAC, `routes/auth.ts`, `plugins/auth.ts`, pino redaction, OAuth via `services/connector-oauth.ts`, rate-limit |
| L2 Data and memory | ✅ | Postgres + Drizzle (`packages/db/schema.ts`), 49 migrations, pgvector embeddings, world-model graph (`services/world-model.ts`), Redis, S3-compatible image storage |
| L3 Tool & integration (MCP) | ✅ | `routes/mcp.ts` HTTP MCP server exposes ~140 brain-task ops; connector specs for 8 platforms in `services/connector-base.ts`; per-platform endpoint wrappers for YouTube + Etsy |
| L4 AI reasoning core | ✅ | `services/chat-providers.ts` multi-provider chain with Anthropic prompt caching + extended thinking, OpenAI + Gemini prompt caching, model routing, fallback chains, ai_usage telemetry, AbortSignal propagation |
| L5 Per-business agent mesh | ✅ | `services/agent-team.ts` 12-persona team, `services/business-portfolio.ts`, `services/business-attachments` (round 70), per-workspace scoped memory + budget |
| L6 Cross-business orchestration | ✅ | `services/holding-co.ts` (Capital Allocator + Shared Services + Synergy Detector + Portfolio Strategy), `portfolios` table (migration 0049) |
| L7 Governance and control plane | ✅ | `services/policy-engine.ts` (9 default rules + operator-editable rules from `policy_rules` table), `services/business-budget.ts`, `services/simulation.ts` (dry-run + counterfactual), `kill_switches` table, audit via `events` + `reasoning_chains`, `services/agent-coordination.ts` |
| L8 Human interface | ✅ | `/blueprint` page with 8 tabs, Monday briefing cron, chat, `/approvals` route, `events` SSE stream, brain-graph visualizer |

Cross-cutting observability: ✅ pino + OpenTelemetry hooks, `services/ai-cost-tracker.ts`, `metrics` route.

---

## Section 3 — Technology Stack

- **3.1 Infrastructure** — operator deploys via Render / Fly / docker-compose / local; multi-cloud + IaC 🔒 operator decision
- **3.2 Data** — ✅ Postgres + Redis + S3-compatible + pgvector + Postgres FTS + world-model graph
- **3.3 Event & workflow** — ✅ events table + BullMQ + learning-cron (custom scheduler, not Temporal/Inngest — see §5.3 deviation note in this file)
- **3.4 AI layer** — ✅ Claude primary + OpenAI/Gemini/Groq fallback + custom router; ⏳ Langfuse/LangSmith not yet wired (pino + OTEL covers most observability)
- **3.5 Integration** — ✅ MCP server + connector-base for 8 platforms; ⏳ n8n / Composio not adopted (built-in stack covers current needs)
- **3.6 Security** — ◐ vault-master-key (custom, not HashiCorp Vault); 🔒 SSO is operator integration choice
- **3.7 Observability** — ✅ pino + OTEL; 🔒 Datadog/Grafana is operator's hosted service
- **3.8 Business stack** — ◐ POD pricing + Etsy + YouTube connectors built; CRM/HR/finance SaaS are 🔒 operator-account integrations

**Deviations from default stack:**
- BullMQ on Redis instead of Temporal/Inngest — operator runs single-process API; Temporal is overkill at current scale
- Custom prompt management in `services/playbook-knowledge.ts` + `services/prompt-evolution.ts` instead of Langfuse/PromptLayer
- pgvector instead of Pinecone (default per spec)

---

## Section 4 — Build Sequence

Current operator stage tracked via `services/maturity-stage.ts → assessMaturity()`. Concrete signals queried from live system (events, businesses, business_revenue, eval_runs, approved_patterns). UI at `/blueprint?tab=maturity`.

---

## Section 5 — Layer Specifications

| Subsection | Coverage |
|---|---|
| 5.1 IaC, multi-region, encryption, no public DBs | ◐ encryption ✅, no public DBs ✅, multi-region 🔒 operator decision |
| 5.2 SSO, audit log, hardware key, access review | ◐ audit log ✅, SSO 🔒, hardware key 🔒 |
| 5.3 Schema per business, no-PII-in-logs, backups, vector versioning | ✅ workspace_id isolation + portfolios + workspace-scoped memories; pino redaction; backup procedure in DEPLOY.md |
| 5.4 MCP servers per domain | ✅ HTTP MCP at `/mcp/`; per-domain split into `/mcp/finance` / `/mcp/marketing` etc. ⏳ planned |
| 5.5 Model router + frontier/mid/small tiering + prompt versioning | ✅ all wired; prompt evolution registry persists versions |
| 5.6 Per-business agent mesh | ✅ |
| 5.7 Cross-business orchestration | ✅ |
| 5.8 Governance pass-through + locked-core | ✅ `services/self-improvement.ts` LOCKED_CORE_PATHS enforces; `services/agent-coordination.ts` ties policy + auth tier |
| 5.9 Human interface | ✅ |

---

## Section 6 — Coding Subsystem Agent Topology

✅ `services/coding-topology.ts` implements full topology: PM → TechLead → Specialists × 18 roles → Integration → Release → SRE with typed handoff contracts (SpecContract → PlanContract → WaveResult → PRContract → ReleaseContract → IncidentContract). Horizontal support: `codebase-cartographer.ts`, `knowledge-curator-v2.ts`, dependency update via cron, docs generation via personas, `ai-cost-tracker.ts`.

---

## Section 7 — Coordination Patterns

| Pattern | Implementation |
|---|---|
| 7.1 Hierarchical decomposition | `coding-topology.runFullCodingFlow` |
| 7.2 Shared blackboard | `agent-coordination.blackboardWrite/Read` + `blackboardDetectInconsistencies` |
| 7.3 Contract-based handoffs | typed contracts in `coding-topology.ts` |
| 7.4 Idempotent / reversible | `agent-coordination.execReversible` (begin/commit/cancel), TOCTOU atomic upserts in DB |
| 7.5 Bounded replanning | `agent-coordination.shouldEscalate` + `emitEscalation` |
| 7.6 Loop detection | `agent-coordination.detectIdenticalLoop` wired into `brain-task.executePlan` (round 128) |
| 7.7 Concurrency | `services/gui-mutex.ts`, advisory locks (Monday briefing round 101), tx-scoped writes |
| 7.8 Tiered authority | `agent-coordination.resolveAuthority` based on risk × reversibility × blast-radius × trust |

---

## Section 8 — Knowledge System

| 8.x | Implementation |
|---|---|
| 8.1 Knowledge types | ✅ playbooks (`apps/api/knowledge/*.md`), anti-patterns + decision records via reasoning-chains, pattern library via `approved_patterns`, fact databases via memories, calibration via trust-reputation |
| 8.2 Extraction triggers | ✅ 5 trigger detectors in `knowledge-curator-v2.ts`: success_completion, failure_postmortem, pattern_repetition, surprise, periodic_review |
| 8.3 Lifecycle | ✅ draft/active/deprecated/archived in `approved_patterns` table + curator |
| 8.4 Distribution | ✅ `retrieveForTask` keyword + persona match weighted by trust; `proposePersonaPromptPatch` for system-prompt updates |
| 8.5 Pathology prevention | ✅ overfitting (passesAntiOverfitCheck), cargo culting (passesAntiCargoCheck), bloat (autoDeprecateLowTrust), staleness (90d re-validation), contradictions (`detectContradictions`) |

---

## Section 9 — Evaluation System

| 9.x | Implementation |
|---|---|
| 9.1 Eval layers | ✅ tag-driven golden/regression/synthetic/production in `eval_sets.tags`; ⏳ no starter seed yet — operator creates sets via /blueprint?tab=evals |
| 9.2 Grading methods | ✅ `gradeOneCase` (LLM-as-judge), `ensembleGrade` (multi-judge across model families), exact-match via case shape; human grading 🔒 operator UI work |
| 9.3 Eval pipeline | ✅ `ciGateEval` returns allow/warn/block with per-layer breakdown |
| 9.4 Production evals | ✅ `sampleProductionTraffic`, `detectDrift`, `captureFailureAsRegressionCase` |
| 9.5 Safety-specific | ✅ `runSafetyRedTeam` with 6 baseline attacks (prompt_injection, jailbreak, pii_leak, financial_action, credential_leak, instruction_override) |

---

## Section 10 — Self-Improvement Loop

| 10.x | Implementation |
|---|---|
| 10.1 Autonomous within bounds | ✅ knowledge accumulation, tool additions via brain.task ops, prompt tuning via prompt-evolution registry, model swaps via provider router (all eval-gated) |
| 10.2 Requires human approval | ✅ `LOCKED_CORE_PATHS` enforces: governance, kill-switches, audit, mission-charter, self-improvement-itself, agent-coordination, safety-policy, schema |
| 10.3 Pipeline | ✅ `services/self-improvement.ts` ProposalStage transitions (observed → designed → sandbox_passed → shadow_running → gradual_rollout → fully_promoted | rolled_back | abandoned) |
| 10.4 Pathology detection | ✅ 5 detectors: Goodhart drift, capability narrowing, coordination drift, compounding subtle errors, reward hacking |

---

## Section 11 — Specific Subsystem Notes

| 11.x | Implementation |
|---|---|
| 11.1 Digital Product Factory | ✅ `services/product-factory.ts` (idea inbox + validation gates + PRD generator + launch checklist + sunset proposal); `services/code-agent.ts` + `services/patch-sandbox.ts` + `services/verification-engine.ts` + `services/safety-policy.ts` for build; `services/pipeline-adapters.ts` for per-product-type pipelines (web, mobile_ios, mobile_android, mobile_rn, ai_product, embedded_firmware, browser_extension, desktop, api_sdk) |
| 11.2 Content Operations | ✅ channel charter via business_attachments + playbooks; `services/scheduled-production.ts` (timezone-aware cron + auto-cadence); `services/shortform-engine.ts` (hooks + trends + clip mining + triage + multi-platform tier flow + multi-account ethics guard); `services/connector-youtube.ts` + `services/connector-etsy.ts`; ⏳ TikTok/Instagram endpoint modules |
| 11.3 Finance Operations | ◐ business_revenue rollup, cron-budget, business-budget, ai_usage cost tracking; 🔒 GL + reconciliation + tax filings = operator's QuickBooks/Stripe integration |
| 11.4 Customer-Facing AI | ◐ chat surfaces AI involvement; escalation patterns in agent-coordination; ⏳ formal disclosure + audit cadence by route |

---

## Section 12 — Team Structure

`services/staffing-planner.ts` returns per-stage team composition with 15 named role specs, green/red flags, comp ranges, under-investment callouts. Operator runs `staffing.plan` op to see what to hire next.

---

## Section 13 — Financial Model

`services/financial-model.ts`: `projectFinancials` (burn / break-even / unit economics / leverage comparison), `COST_DESTROYERS`, `VIABLE_CONFIGURATIONS`, `NON_VIABLE_CONFIGURATIONS`, `PAYBACK_ACCELERATORS`.

---

## Section 14 — Legal and Compliance Baseline

`services/compliance-tracker.ts`: `recommendEntity`, `checkFtcDisclosure`, `auditContentRights`, `computeTaxObligations`, `checkInternationalTax`, `recommendIpActions`. Every output carries `professionalReviewRequired: true`. 🔒 actual entity formation + cert authority + audits = human action.

---

## Section 15 — Operating Principles for Claude

The runtime contract is enforced via:

- **15.1 Always** — current Claude sessions tracked in task list (113+ tasks since session start); typecheck + 1954 tests run on every change; SPEC.md is the persisted source of truth
- **15.2 Never** — `LOCKED_CORE_PATHS` enforces "never modify governance / kill switches / audit log" architecturally; pino redaction enforces no-PII-in-logs; OPERATOR_APPROVED token gates irreversible actions
- **15.3 When uncertain** — coordination machinery (escalations, adversarial review, locked-core checks) all default to safer
- **15.4 Code quality** — 1954 tests + typecheck CI gate + safety-policy + code-agent adversarial review pre-merge
- **15.5 Communication** — Monday briefing cron, reasoning-chains for evidence, Postmortem auto-gen

---

## Section 16 — Honest Limitations

Acknowledged + reflected in code:
- Long-horizon decay → bounded replanning via escalation budgets
- Novel-situation confabulation → adversarial review + ensemble grading
- Multi-agent coordination is frontier → all 8 patterns from §7 explicitly named services
- High-stakes irreversible → `OPERATOR_APPROVED` token gates + `human_only` authority tier for critical+irreversible
- Regulatory lag → `compliance-tracker` flags but does not advise
- Years-not-months → maturity tracker shows current stage honestly

---

## Cumulative State (as of last update)

- **113+ task entries** in session history
- **1954 / 1954 tests** passing across 88 test files
- **Typecheck green** on @ops/api + @ops/web
- **~60 services**, **~140 brain-task ops**, **20 REST endpoints**, **8 operator UI tabs**, **MCP HTTP server**
- **49 migrations** in `packages/db/migrations/`
- **5 playbooks** in `apps/api/knowledge/` injected into chat system prompt
- **All blueprint subsystems wired**: eval system + HIL orchestrator + knowledge curator v2 + coding topology + pipeline adapters + cartographer + agent coordination + self-improvement loop + maturity tracker + staffing planner + financial model + short-form engine + channel acquisition + compliance tracker

---

## New sections in SPEC R2 — coverage

| Section | Status |
|---|---|
| §1.3.8 honest failure modes | ✅ enforced across services (no-fake-intelligence pattern, "not connected" surfaces) |
| §1.4 architectural constraints | ✅ all 4 enforced architecturally (see §11.6/§11.7/§10.5 + money-guard layers) |
| §3 active deviations | ✅ deviations match implementation; 3 documented |
| §10.5 locked-core registry | ✅ `services/self-improvement.ts → LOCKED_CORE_PATHS` |
| §10.6 proposal lifecycle | ✅ `transitionProposal` with VALID_TRANSITIONS table |
| §11.5 short-form + multi-account ethics | ✅ `services/shortform-engine.ts` including `checkMultiAccountPlan` |
| §11.6 OPERATOR_APPROVED convention | ✅ applied across ~30 high/critical-risk ops + connector writes |
| §11.7 $10k floor enforcement | ✅ all 8 enforcement points wired (see SPEC §11.7) |
| §18 codebase conventions | ✅ all 10 idioms surfaced by `codebase-cartographer.identifyIdioms` + documented in CLAUDE.md |
| §19 revision log | ✅ this file + SPEC.md both stamped R2 |

## R2 → R3 deltas (recently shipped, now ✅)

| Item | Round | Status |
|---|---|---|
| Self-improvement health check cron | 116 | ✅ daily cron + governance.stability_alert |
| TikTok endpoint module | 117 | ✅ 8 ops, OPERATOR_APPROVED gated |
| Instagram endpoint module | 119 | ✅ 10 ops including carousel publish |
| Shopify endpoint module | 120 | ✅ 13 ops, money-flow intentionally excluded |
| Domain-split MCP servers | 121 | ✅ `/mcp/<domain>/tools` for 10 domains |
| Frontend tab — Self-improvement Health | 122 | ✅ pathology monitor + recent alerts |
| Frontend tab — Short-form | 122 | ✅ 6-platform guidance + 10-pattern hooks |
| Frontend tab — Acquisition | 122 | ✅ 29-item DD checklist grouped by category |
| Frontend tab — Compliance | 122 | ✅ viable configs + destroyers + accelerators |

## What's deferred (planned, not yet built)

- TikTok + Instagram + Printful + Shopify endpoint modules (specs exist in `connector-base.ts`; per-endpoint wrappers ~150-250 lines each, gated by operator OAuth app registration)
- Vector design pipeline (raster→SVG synth)
- HIL physical-lab integration (Novan orchestrates; hardware = operator's lab)
- Multi-cloud + Terraform (operator's cloud decision)
- SOC 2 / ISO certification (operator + auditor)
- Frontend tabs for: shortform engine, channel acquisition, compliance tracker, self-improvement health, HIL orchestrator
- Domain-split MCP servers (currently one HTTP MCP exposes all; per-domain `/mcp/finance` etc. planned)
- Cron-wire the self-improvement health check (daily)

---

*Update this file whenever a spec section's coverage materially changes. The map is most useful when it's current.*
