# Multi-Business Automation Brain: Complete Build Specification

> Source of truth for Novan's architecture, conventions, and priorities.
> Any Claude session working on this codebase should read this document
> first. When a request conflicts with this document, the document wins
> unless explicitly overridden in the message.

**Current revision:** R4 (architecture overview + eval seeds + first-install flow). See §19 for revision log.
**Coverage map:** see `docs/SPEC_COVERAGE.md` for section-by-section
implementation status. Sections marked `[implemented]` reference live
code; sections marked `[aspirational]` are targets not yet built.

## 0. How To Use This Document

This is a specification, not a script. When working with Claude on this system:

- Provide this document as context for any significant build session
- Reference specific sections by number (e.g., "implement per Section 4.2")
- Update this document as decisions evolve — it should reflect current state, not initial state
- Use it to onboard new Claude instances to ongoing work
- Treat it as the canonical answer when Claude asks "how should I do X here"

When a request to Claude conflicts with this document, the document wins unless explicitly overridden in the message.

---

## 1. System Purpose and Scope

### 1.1 What This System Is

A multi-business automation platform that operates several distinct businesses simultaneously, with AI agents handling operational work and humans providing strategic direction, creative judgment, and oversight of high-stakes decisions.

### 1.2 What This System Is Not

- Not a fully autonomous system. Humans remain in the loop for governance, strategy, creative direction, high-stakes decisions, and relationships.
- Not a single AI doing everything. It is a coordinated system of specialized agents with clear contracts between them.
- Not flawless. It is designed assuming agents will sometimes be wrong, and the architecture protects against the consequences.
- Not a product to sell as-is. It is operational infrastructure for the businesses being run.

### 1.3 Design Principles

1. **Foundations before features.** Platform, observability, and governance precede capability.
2. **Closed loops everywhere.** Every output gets measured, every measurement feeds learning.
3. **Bounded autonomy.** Agents have explicit scope, budget, and escalation paths.
4. **Reversibility by default.** Prefer actions that can be undone over actions that cannot.
5. **Evidence over assertion.** Decisions reference data, code, or documented patterns.
6. **One way to do each thing.** Convention over configuration. Patterns repeat.
7. **The boring stuff first.** Logging, monitoring, backups, security baseline before clever capabilities.
8. **Honest failure modes.** When a capability isn't actually wired, the system says so rather than pretending. No fake intelligence, no fake execution, no hidden automation.

### 1.4 Architectural Constraints (operator-defined, non-negotiable)

These constraints apply across the system regardless of business type:

- **$10k/month per-business floor.** Every business onboarded targets ≥ $10k/month net revenue. Enforced at 8+ entry points: `business.create`, `business.feasibility`, `portfolio.improve`, `niche.score`, chat playbook auto-injection, capital allocator scoring, business-reality classifier, and the financial model warnings. Operator can run businesses below this target; the brain will not propose or prioritise them.
- **Money-guard hard-block.** Any operation matching financial patterns (charge, refund, transfer, withdraw, etc.) is hard-blocked unless `caller='operator' AND approval_token='OPERATOR_APPROVED'`. Agents and cron cannot self-approve money flow regardless of authority tier. Implemented in `services/brain-task-money-guard.ts` + `services/policy-engine.ts → money_pattern_hard_block` rule.
- **OPERATOR_APPROVED token gate.** Any irreversible or high/critical-risk operation requires the explicit string token `OPERATOR_APPROVED` in the `approval_token` parameter. This token is operator-issued, not derivable by the brain. Listed as a runtime convention in §18.6.
- **Locked-core registry.** A specific list of files cannot be self-modified by the brain regardless of authority. See §10.5 for the registry.

---

## 2. Architecture Overview

### 2.1 Layered Architecture

The system has nine layers, built bottom-up:

| Layer | Purpose |
|-------|---------|
| 0 | Infrastructure (cloud, network, IaC) |
| 1 | Security and identity |
| 2 | Data and memory |
| 3 | Tool and integration (MCP servers) |
| 4 | AI reasoning core (models, orchestration, memory, observability) |
| 5 | Per-business agent mesh |
| 6 | Cross-business orchestration |
| 7 | Governance and control plane |
| 8 | Human interface |

Cross-cutting: observability and reliability span all layers.

### 2.2 Control Flow

Human input or scheduled trigger → governance validation → cross-business routing → per-business manager → specialist agents → tools → data → infrastructure.

### 2.3 Data Flow

Events from operational systems → event backbone → operational stores → knowledge layer → retrieval → agent context.

### 2.4 Key Architectural Bets

- **MCP as universal tool interface.** Every external system integration is exposed through an MCP server with typed tools.
- **Manager agents per business.** Each business has its own coordinating agent with scoped memory and KPIs.
- **Governance as mandatory pass-through.** Every agent action validated against policy before execution.

---

## 3. Technology Stack (Default Choices + Active Deviations)

These are starting choices. Substitute equivalents only with documented justification. **Active deviations are documented inline below with rationale.** Re-deviating requires a new entry here, not silent substitution.

### 3.1 Infrastructure

- **Cloud primary:** AWS or GCP
- **Cloud secondary:** The other (for redundancy)
- **Edge:** Cloudflare
- **IaC:** Terraform or Pulumi (pick one, use exclusively)
- **Containers:** Docker, with Kubernetes only where serverless cannot fit
- **Serverless:** AWS Lambda / Cloud Run / Cloudflare Workers (preferred for event-driven workloads)

### 3.2 Data

- **Relational:** PostgreSQL (Supabase or Neon for managed)
- **Cache:** Redis
- **Object storage:** S3 or R2
- **Analytics:** ClickHouse or DuckDB for embedded
- **Warehouse:** Snowflake or BigQuery (only when volume justifies)
- **Vector:** pgvector (default) or Pinecone (at scale) — **currently pgvector**, embeddings on `memories` table
- **Graph:** Neo4j or Apache AGE on Postgres — **currently custom world-model** in `services/world-model.ts` (Postgres JSONB nodes + edges; not yet AGE). Re-evaluate at > 100k nodes.
- **Search:** Postgres full-text (default) or Typesense / Elasticsearch (at scale) — **currently Postgres FTS**

### 3.3 Event and Workflow

- **Event backbone:** EventBridge / Pub/Sub (start), Kafka / Redpanda (at scale)
- **Workflow engine:** Temporal or Inngest
- **Job queue:** BullMQ on Redis (simpler cases)

**[active deviation: workflow engine]** Currently using BullMQ + custom `services/learning-cron.ts` scheduler instead of Temporal or Inngest. Rationale: single-process API at current scale; Temporal's durability model is overkill for the workflows in production. Re-evaluate when (a) workflows cross > 1 hour wall-clock, or (b) the operator deploys multi-instance.

**[active deviation: event backbone]** Using Postgres `events` table + BullMQ pub/sub instead of EventBridge/Pub-Sub. Rationale: single deployment target; eliminates external dependency; events table also serves as the audit log (§5.8). Re-evaluate when event volume > 1k/sec sustained.

### 3.4 AI Layer

- **Primary reasoning:** Claude API (Anthropic) with prompt caching + extended thinking enabled (`services/chat-providers.ts`)
- **Secondary models:** OpenAI, Google, open-weights via Together / Fireworks / Groq — all with prompt caching where the provider supports it
- **Model routing:** Custom router with fallback chains (`pickProvider` + circuit breaker in `services/chat-providers.ts`)
- **Orchestration:** Custom code (no Temporal yet — see §3.3 deviation); MCP for tools (`routes/mcp.ts`)
- **Agent framework:** Custom orchestration via `services/agent-team.ts` (12 personas) + `services/coding-topology.ts` (full PM→specialists→release topology). LangGraph not adopted; see deviation.
- **Observability:** pino + OpenTelemetry hooks; AI-specific telemetry via `services/ai-cost-tracker.ts` (`ai_usage` table)
- **Prompt management:** `services/playbook-knowledge.ts` (operator playbooks as markdown in `apps/api/knowledge/*.md`) + `services/prompt-evolution.ts` (versioned mutation registry with ε-greedy + Wilson scoring)

**[active deviation: agent framework]** Custom orchestration instead of LangGraph. Rationale: type-safe contracts between agents (SpecContract → PlanContract → WaveResult → PRContract) matter more than the framework abstractions; LangGraph's state model added complexity for a workflow already cleanly served by direct typed function calls. Re-evaluate if cross-agent state graphs become genuinely dynamic.

**[active deviation: AI observability]** pino + OpenTelemetry + ai_usage rows instead of Langfuse/LangSmith. Rationale: telemetry already flows through the standard observability stack; adding a separate AI-trace product creates two sources of truth. Re-evaluate when team grows past 5 engineers + dedicated AI ops role.

**[active deviation: prompt management]** Markdown playbook files + custom prompt-evolution registry instead of Langfuse/PromptLayer. Rationale: prompts are versioned in git alongside the code that consumes them; A/B testing happens through the routing layer (`services/prompt-evolution.ts`). Re-evaluate when prompt count > 100 or non-engineer roles need to edit prompts.

### 3.5 Integration

- **Tool exposure:** MCP servers (one per integration domain)
- **Long-tail SaaS:** n8n (self-hosted) or Composio
- **Browser automation:** Browserbase or Playwright

### 3.6 Security

- **Secrets:** Vault, Doppler, or Infisical
- **SSO:** Okta, WorkOS, or Auth0
- **SIEM:** Panther or Datadog Cloud SIEM
- **Compliance automation:** Vanta or Drata

### 3.7 Observability

- **Metrics/logs/traces:** Datadog or Grafana Cloud
- **Error tracking:** Sentry
- **Incident management:** PagerDuty or Incident.io
- **Cost monitoring:** Vantage or CloudZero

### 3.8 Business Stack (Per Function)

- **Finance:** Stripe, Mercury or Brex, Ramp, QuickBooks or Xero
- **CRM:** HubSpot, Salesforce, or Attio
- **Support:** Intercom, Zendesk, or Pylon
- **HR:** Rippling, Deel, Ashby or Greenhouse
- **Engineering:** GitHub, Linear, Vercel, Sentry
- **Marketing:** Customer.io, Resend, platform-specific ad tools

---

## 4. Build Sequence

Build in this order. Do not skip ahead.

### 4.1 Stage 0: Foundations (Months 1-3)

**Goal:** Environment in which automation can be built safely. No agents yet.

Deliverables: Cloud accounts with billing alerts, IaC for all infrastructure, Postgres + Redis + S3 via IaC, event backbone, secrets management, SSO, observability stack, CI/CD, security baseline, backup-and-restore tested via actual drill, incident response runbook.

Gate to next stage: end-to-end provisioning works, observability captures activity, security baseline holds.

### 4.2 Stage 1: First Closed-Loop Workflow (Months 4-6)

**Goal:** One specific business workflow automated end-to-end with all architectural patterns.

Pick one workflow that is high-frequency, measurable, reversible, and bounded. Good candidates: inbound lead qualification, support ticket triage, expense categorization, content publishing, order processing. Bad candidates: anything strategic, money in real-time, customer-facing at scale, irreversible.

Deliverables: workflow orchestrator with the chosen workflow, 2-4 MCP servers, first agent layer, AI observability, eval set (50-200 cases), governance layer v1 (policy engine + approval queue + audit log), cost monitoring for AI, human approval UI.

Gate: workflow autonomous for 2 weeks with measurable value, governance catches violations, cost bounded, evals pass consistently.

### 4.3 Stage 2: Horizontal Expansion in One Business (Months 7-12)

**Goal:** Multiple workflows in the same business sharing platform.

Deliverables: 5-10 additional MCP servers, specialist agent topology, Knowledge Curator v1, eval sets per workflow as CI merge gates, model routing (frontier/mid/small), cost optimization, customer-facing capability if applicable.

Gate: business primarily operates through automation, humans in oversight roles, unit economics positive on automated workflows.

### 4.4 Stage 3: Second Business and Multi-Tenancy (Months 12-18)

**Goal:** Architecture proven across distinct businesses.

Deliverables: multi-tenancy in data model, per-business memory scoping, shared services router, cross-business orchestration agent, template for spinning up business N+1, operational maturity (drills, IR, on-call).

Gate: two businesses on shared platform, marginal cost of new business measurably lower than first.

### 4.5 Stage 4: Operational Maturity (Months 18-24)

**Goal:** Trustworthy at scale.

Deliverables: comprehensive eval coverage, SOC 2 Type II (if applicable), formal change management, DR drills, security audit + pen test, accessibility compliance, documentation for onboarding, autonomy bands expanded based on track record.

### 4.6 Stage 5: Scale and New Business Spawning (Months 24+)

**Goal:** Marginal cost of additional businesses approaches zero.

Deliverables: business template instantiation in days, portfolio-level optimization, cross-business learning transfer, compounding capability through Knowledge Curator.

---

## 5. Layer Specifications

### 5.1 Layer 0: Infrastructure

- All infrastructure defined in IaC; manual changes prohibited
- Multi-region setup with documented failover
- Cost monitoring with alerts at 80% of budget per service
- Network segmentation: VPC per environment, security groups locked down
- All data encrypted at rest (cloud-provider KMS) and in transit (TLS 1.3 minimum)
- No public-facing databases under any circumstances

### 5.2 Layer 1: Security and Identity

- Zero secrets in code or environment files; all from secret manager
- All human access through SSO; no shared accounts
- All service-to-service through scoped credentials with rotation
- Audit log of every privileged action, immutable
- Hardware key requirement for production access to highest-stakes systems
- Quarterly access review; remove unused permissions
- Vulnerability scanning continuous in CI

### 5.3 Layer 2: Data and Memory

- Postgres schemas separated by domain (one per business, plus shared)
- Strict no-PII-in-logs policy enforced via linting and runtime checks
- Backup tested monthly via actual restore drill
- Knowledge layer indexed continuously from operational events
- Vector embeddings versioned; re-embed on model change
- Data retention policies documented and enforced

### 5.4 Layer 3: Tools and Integrations (MCP)

- One MCP server per integration domain (Finance, CRM, Support, etc.)
- Each MCP server exposes typed tools with clear schemas
- Each tool documents its idempotency and side effects
- Authentication handled at MCP server level, not in agent code
- Rate limiting and quota enforcement at MCP server
- Tool versioning: breaking changes go through deprecation cycle

### 5.5 Layer 4: AI Reasoning Core

- Model router selects model tier based on task category, not per-call decision
- Frontier models for: planning, complex reasoning, code review, governance decisions
- Mid-tier models for: routine code generation, classification, summarization
- Small models for: routing, lightweight classification, embeddings
- Every model call logged with: prompt, response, latency, cost, trace ID
- Prompt versioning in git; A/B testing through routing layer
- Fallback chain documented for every primary model
- Memory scoping: agent memory does not leak across businesses without explicit cross-business orchestration

### 5.6 Layer 5: Per-Business Agent Mesh

Each business has: 1 Manager Agent, functional specialists scoped to needs, scoped memory, scoped budget, scoped authority. Specialist agents communicate through artifacts, not direct conversation. Manager owns integration.

### 5.7 Layer 6: Cross-Business Orchestration

- Capital allocator: rebalances investment across businesses based on returns and strategy
- Shared services router: directs work to centralized functions (accounting, HR, IT)
- Synergy detector: identifies cross-business opportunities (talent, customers, data)
- Portfolio strategy: high-level decisions about which businesses to grow, sunset, acquire

Cross-business agents have higher authority thresholds and more human oversight.

### 5.8 Layer 7: Governance and Control Plane

**Mandatory pass-through for every agent action.**

Components: policy engine, approval router, audit log (append-only + cryptographically verified), budget enforcer, simulation sandbox, kill switches (per-agent, per-business, global, mobile-accessible).

**Locked from agent self-modification:**
- The governance layer itself
- Kill switches and their thresholds
- The audit log (immutable)
- Core values and constraints
- The improvement loop's own meta-rules

### 5.9 Layer 8: Human Interface

- Daily briefing summarizing what happened, what's coming, what needs attention
- Natural language command interface
- Approval queue with full context
- Executive dashboards (KPIs per business + portfolio rollup)
- Voice interface for hands-free interaction
- Weekly executive summary with surfaced patterns

---

## 6. Agent Topology (Coding Subsystem Example)

```
PRODUCT MANAGER AGENT (what and why)
        ↓
TECH LEAD AGENT (how, decomposition, routing)
        ↓
SPECIALISTS (parallel execution):
  Domain: Frontend, Backend, DB, Mobile (iOS/Android), Embedded
  Platform: Web, Desktop, AI/ML
  Quality: Test Author, Security Audit, Performance Audit
  Cross-cutting: API Design, Auth, Integrations, A11y, Refactor, Code Review
        ↓
INTEGRATION AGENT (merges work, resolves conflicts)
        ↓
RELEASE AGENT (CI, deployment, rollout)
        ↓
SRE / ON-CALL AGENT (production monitoring, incident response)
```

Horizontal support: Codebase Cartographer, Dependency Update, Documentation Generator, Cost Optimizer, Knowledge Curator.

---

## 7. Coordination Patterns (Required)

7.1 **Hierarchical Decomposition.** Manager decomposes work into specified subtasks. Specialists execute. Specialists do not talk to each other directly during execution; they communicate through artifacts.

7.2 **Shared Blackboard.** Append-only structured store. Agents add information; existing information not overwritten. Conflicts marked explicitly for manager resolution.

7.3 **Contract-Based Handoffs.** Every cross-agent handoff has a contract. Written before execution, validated at handoff.

7.4 **Idempotent and Reversible Operations.** Side-effect operations are idempotent or reversible. Two-phase commit/cancel where appropriate.

7.5 **Bounded Replanning.** Each agent has escalation budget. When exceeded, escalate upward with structured context.

7.6 **Loop Detection.** Per-task budgets on tool calls, runtime, cost. Identical action detection. Progress checking. Escalate when no progress.

7.7 **Explicit Concurrency.** Work partitioning by manager to prevent races. File-level or row-level locks where needed.

7.8 **Tiered Authority.** Action authority based on track record, stakes, and reversibility. Tracked in calibration data, reviewed periodically.

---

## 8. Knowledge System

8.1 **Knowledge Types:** Playbooks, anti-patterns, decision records, pattern libraries, fact databases, calibration data.

8.2 **Extraction Triggers:** Successful task completion (selective), failure (every meaningful one), pattern repetition, surprise (outcome differs from prediction), periodic review.

8.3 **Knowledge Lifecycle:** Draft → Active → Deprecated → Archived. Versioning preserves history. Provenance captured. Quality gates: concrete, evidence-supported, generalizable.

8.4 **Distribution:** Retrieval-augmented context injection at task start. Periodic digests. Update of agent prompts when patterns generalize sufficiently. Calibration tracking.

8.5 **Pathology Prevention:** Overfitting, cargo culting, bloat, staleness, contradictions — each with explicit mitigation.

---

## 9. Evaluation System

9.1 **Eval Layers:** Golden set (hand-curated, 100-500 cases), regression set (every fixed bug), synthetic set (LLM-generated for breadth), production sample (refreshed real traffic, graded).

9.2 **Grading Methods:** Exact-match where applicable, LLM-as-judge with calibration + different model family than producer, human grading for golden + calibration + high-stakes.

9.3 **Eval Pipeline:** Every change runs golden set (regression blocks merge), regression set, synthetic set, safety evals (injection, jailbreak, refusal calibration, content safety), cost + latency measurement.

9.4 **Production Evals:** Traffic sampling with background grading, explicit user feedback, drift detection, production failures → regression set additions.

9.5 **Safety-Specific:** Prompt injection defense, jailbreak resistance, refusal calibration, PII leakage testing, bias evaluation, tool misuse evals for agents.

---

## 10. Self-Improvement Loop

10.1 **Autonomous within bounds:** Knowledge base accumulation, new tools/MCP servers (with architectural review), prompt tuning within established ranges (eval-gated), model swaps (eval-gated, gradual rollout).

10.2 **Requires human approval:** Governance changes, authority threshold modifications, architectural evolution, kill switch modifications, core values + constraints, improvement loop's own meta-rules.

10.3 **Pipeline:** Observation → hypothesis → experiment design → sandbox testing → shadow deployment → gradual rollout → permanent regression eval addition.

10.4 **Pathology Detection:** Goodhart drift, capability narrowing, coordination drift, compounding subtle errors, reward hacking.

All 5 implemented as named functions in `services/self-improvement.ts`: `detectGoodhartDrift`, `detectCapabilityNarrowing`, `detectCoordinationDrift`, `detectCompoundingSubtleErrors`, `detectRewardHacking`. `runAllImprovementHealthChecks` returns unified verdict `healthy | investigate | pause_self_improvement`.

### 10.5 Locked-Core Registry (canonical list)

The brain CANNOT self-modify these paths regardless of authority tier, approval token, or operator instruction routed through the brain. Operator changes them via explicit code change + human review only.

Implemented in `services/self-improvement.ts → LOCKED_CORE_PATHS`:

| Path pattern | Reason locked |
|---|---|
| `services/policy-engine.ts` | Governance — brain cannot relax its own rules |
| `services/kill-switch*` | Emergency stop — brain cannot make itself harder to stop |
| `services/audit*` | Audit log — brain cannot edit its own history |
| `services/mission-charter.ts` | Constitution — core values + constraints |
| `services/self-improvement.ts` | Meta-loop — brain cannot modify how it modifies itself |
| `services/agent-coordination.ts` | Coordination primitives — blackboard / escalation / auth rules |
| `services/safety-policy.ts` | Intent denylist + path policy + content scanner |
| `db/schema.ts` / `packages/db/src/schema.ts` | Structural integrity — schema changes need migrations + review |

Additional op-pattern locks: any op matching `^(policy|kill_switch|audit|mission|self)\..*\.(set|update|delete|modify)` is locked.

A proposed change to any locked path returns `{ ok: false, error: 'proposal touches locked-core paths — refused', lockedReasons: [...] }` from `proposeImprovement`. Operator must change the file via git directly.

### 10.6 Improvement Proposal Lifecycle

`services/self-improvement.ts → transitionProposal` enforces:

```
observed → designed → sandbox_passed → shadow_running → gradual_rollout → fully_promoted
                                                       ↘                  ↘
                                                         rolled_back        abandoned
```

Each transition requires operator-approval-log entry except `observed → designed` (automatic) and the terminal states. Invalid transitions return `{ ok: false, error: 'invalid transition X → Y' }`.

---

## 11. Specific Subsystem Notes

11.1 **Digital Product Factory:** Spec generation precedes coding. Tests alongside code. Code review automated + human for sensitive areas. Progressive delivery with feature flags. Rollback automation. Per-product-type specializations (mobile, AI, embedded each distinct pipelines).

11.2 **Content Operations:** Channel charter codifies identity. Production pipeline: idea → research → script → record → edit → thumbnail → publish → engage. Multi-platform repurposing (one flagship → many derivatives). Cross-platform analytics. Owned audience as strategic asset. Rights management for music/footage/images. FTC disclosure compliance.

11.3 **Finance Operations:** Multi-entity general ledger. Real-time reconciliation. Cash flow forecasting per business + consolidated. Tax estimation + quarterly filings. Audit trail per transaction. Human approval for transfers above thresholds. No automated investment decisions or trades without explicit per-action authorization.

11.4 **Customer-Facing AI:** Always disclose AI involvement. Escalation to human always visible. Tone calibrated to brand voice. Sensitive topics (legal/medical/financial advice) deflected appropriately. Logs of all interactions. Regular audits.

### 11.5 Short-Form Content Operations + Multi-Account Ethics

`services/shortform-engine.ts` is the per-platform short-form (TikTok / YouTube Shorts / Instagram Reels / Facebook Reels / Snapchat Spotlight / Pinterest Idea Pins) operation surface. Key disciplines:

- **Hook-first structure** with 10-pattern catalog scored by `scoreHook()`; the "today we're going to talk about" anti-pattern is auto-flagged
- **Trend evaluation** with sweet-spot detection (age < 7d AND momentum > 0.5 AND production lead < 48h); the engine refuses to ride trends past their window
- **Clip mining** from long-form transcripts via energy + hook + anti-filler scoring
- **First-24h triage** returning `pull_and_repost | amplify | sunset | let_ride`; `pull_and_repost` is platform-gated to TikTok/Reels only (YouTube Shorts loses signal on delete)
- **Content tier flow** Tier 1 flagship → Tier 2 × ~5 mid-form → Tier 3 × ~15-30 short clips × N platforms → Tier 4 engagement; target 25-50 distinct pieces per Tier 1 source
- **Multi-account ethics guard** (`checkMultiAccountPlan`) REFUSES to surface engagement-manipulation tactics: engagement between own accounts, identical content posted to multiple, follow-trains, view-bot / like-bot services, fake comment networks. Distinct content + distinct purpose + cross-promotion via genuine recommendation = allowed.

### 11.6 OPERATOR_APPROVED Convention (token gating irreversible action)

Any operation matching ANY of these patterns requires `approval_token="OPERATOR_APPROVED"` in its params:

- Risk tier `high` or `critical` on the op spec
- Money-pattern matched by `brain-task-money-guard`
- MCP-invoked call at risk ≥ medium
- Destructive ops named `*.delete`, `*.sunset`, `*.destroy`, `*.wipe`, `*.drop`
- Connector ops that mutate live storefronts / channels / accounts (YouTube upload, Etsy listing create/update, etc.)
- Reversible action `commit` phase (`agent-coordination.execReversible`)
- Knowledge curator `approve_pattern` + `propose_prompt_patch`

The token is operator-issued — not derivable, not stored, not retrievable by the brain. Per policy-engine rule `critical_requires_approval` and `money_pattern_hard_block`, agents and cron cannot self-approve regardless of stated authority.

### 11.7 $10k/Business Floor (operator-defined economic constraint)

Every business onboarded targets ≥ $10,000/month net revenue. The brain does not propose or prioritise sub-$10k ventures. Enforced at:

1. `business.create` op + `business.feasibility` analyzer
2. `portfolio.improve` LLM system prompt
3. `niche.score` seed prompt math
4. `business.realityCheck` pace classifier
5. `business.sunset` proposal trigger (when 60d trajectory remains < $10k)
6. Chat playbook auto-injection (operator-runbook reminder)
7. Capital allocator weighting in `services/holding-co.ts`
8. Financial model warnings (`projectFinancials` flags business count < 3 in `many_small_businesses` config)

Operator can run businesses below floor manually; the brain will flag them as below-floor in `portfolioStrategy()` output but will not auto-shut. Floor revision requires explicit operator action in code (it's a constant in the feasibility analyzer + portfolio scoring), not a brain decision.

---

## 12. Team Structure

12.1 **Stage 0-1 (3-5 people):** Platform/Infra (1-2), security-conscious generalist (1), AI/ML with production experience (1), technical product person (1).

12.2 **Stage 2 (5-8 people):** + dedicated SRE, + second AI/ML (specialization), + domain expert.

12.3 **Stage 3-4 (10-15):** + dedicated security, + data engineer, + per-business product owners, + AI platform engineer, + frontend/UX.

12.4 **Non-Obvious Roles:** Evaluation Engineer, Knowledge Manager, Adversarial Tester / Red Team, Operations / Process Manager.

12.5 **Hiring Profile:** Production scars, comfort with uncertainty, systems thinking, pragmatic skepticism about AI, strong writing ability.

---

## 13. Financial Model

13.1 **Capital Requirements (Years 1-2):** Personnel $1.5M-$6M, infra/tooling $200K-$1M, AI inference $50K-$500K+, compliance/legal $100K-$300K, business operating capital separate. Realistic platform burn $5M-$15M over years 1-2.

13.2 **When This Pays Off:** 3-5 businesses break-even by year 3-4; single high-volume business depends on specifics; sale of platform itself = different model; acquisition strategy = faster payback.

13.3 **Cost Discipline:** Model selection (frontier only when needed), aggressive caching, budget enforcement at every layer, quarterly tool audits, hiring discipline.

---

## 14. Legal and Compliance Baseline

14.1 **Entity Structure:** LLC or corp per significant business, holding co for multi-business, separate IP entities for valuable IP, jurisdiction selection considered.

14.2 **Required Compliance Programs:** SOC 2, GDPR/CCPA, HIPAA if health, PCI-DSS if handling cards directly (prefer Stripe to avoid), industry-specific as relevant.

14.3 **Documentation Always Maintained:** Privacy policy + TOS per product, DPAs with vendors, sub-processor list, incident response plan tested, trademark registrations, music/footage licensing records, FTC disclosure evidence.

14.4 **Insurance:** General liability, cyber liability, E&O, D&O when appropriate.

---

## 15. Operating Principles for Claude Working on This System

### 15.1 Always

- Read the relevant section of this document before starting
- Check existing patterns in the codebase before introducing new ones
- Use established tools and libraries; do not add new dependencies without justification
- Write tests alongside code
- Add observability for new functionality
- Update this document when decisions evolve
- Surface uncertainty rather than guess
- Escalate when stakes exceed agent authority

### 15.2 Never

- Bypass governance to ship faster
- Add capability without corresponding observability
- Modify the governance layer, audit log, or kill switches
- Reduce eval coverage to make changes pass
- Make architectural decisions without documenting them
- Pretend a system is more reliable than evals show
- Take irreversible actions without explicit authorization
- Store secrets anywhere except the secret manager
- Log PII or sensitive data

### 15.3 When Uncertain

- Default to safer option
- Ask for clarification rather than assume
- Prefer reversible action over irreversible
- Surface the uncertainty in the response, do not hide it
- Document the decision and reasoning for future reference

### 15.4 Code Quality Standards

- Tests required for new code
- Linting and formatting enforced in CI
- Code review required before merge (human for sensitive areas, agent for routine)
- Documentation in code where intent is non-obvious
- Performance budgets where applicable
- Security review for auth, payments, data deletion, privacy-sensitive flows

### 15.5 Communication Standards

- Daily briefings concise: what happened, what's coming, what needs attention
- Escalations include full context, not just the question
- Decisions reference evidence (code, data, documented patterns)
- Disagreements with this document surfaced explicitly, not silently ignored

---

## 16. Honest Limitations

This document describes an ambitious system that is buildable in pieces over years. It is not a system that exists out of the box. Specific limitations to keep in mind:

- Long-horizon agent reliability is unsolved. Tasks longer than hours need supervisory checkpoints.
- Novel situations produce confabulation. Out-of-distribution detection is imperfect.
- Multi-agent coordination at scale is frontier work, not settled science.
- High-stakes irreversible actions remain in human-in-the-loop tier indefinitely.
- Regulatory frameworks for autonomous business operation lag the technology.
- The full vision pays off in years, not months. Most failed builds underestimate time and capital required.

The system is designed assuming these limitations and built to provide value within them. Anyone working on this system should remain honest about what is reliable today versus what is aspirational.

---

## 18. Codebase Conventions (Idioms That Repeat)

These idioms emerged during build and are now codified. New code follows these patterns; deviation requires justification in the commit message.

### 18.1 service-events

Every service emits structured events on state changes:

```ts
await db.insert(events).values({
  id: uuidv7(), type: 'X.Y_happened', workspaceId,
  payload: { ... },
  traceId: uuidv7(), correlationId, causationId: null,
  source: 'service-name', version: 1, createdAt: Date.now(),
}).catch(() => null)
```

Events serve as telemetry + audit log + downstream-consumer trigger. `.catch(() => null)` is intentional — emit is best-effort, never blocks the caller.

### 18.2 ai-usage-tracking

Every LLM / image / voice call records to `ai_usage` table via `services/ai-cost-tracker.ts → recordAiUsage`:

```ts
recordAiUsage({
  workspaceId, provider, model, promptTokens, outputTokens,
  costUsd, latencyMs, taskType,
})
```

Sync void function — fire-and-forget telemetry, never blocks. Powers the cost dashboard + budget enforcement + drift detection.

### 18.3 reasoning-chains

Significant decisions get a `reasoning_chains` row so the brain timeline shows the why:

```ts
await record({
  workspaceId, kind: 'decision', subjectId, decision,
  confidence, source: 'service-name',
}).catch(() => null)
```

Used by knowledge-curator pattern extraction + counterfactual replay + postmortem generation.

### 18.4 brain-task-op

Operator-callable capabilities expose as `OPERATIONS` map entries in `services/brain-task.ts`:

```ts
'domain.action': {
  description: 'What it does. Params: foo, bar?',
  risk: 'low' | 'medium' | 'high' | 'critical',
  handler: async (workspaceId, params) => { /* */ },
}
```

Auto-routed to: chat (via brain-task dispatch), MCP server (`routes/mcp.ts → /mcp/tools`), and the brain-graph UI. New capabilities surface to all three by adding one entry.

### 18.5 OPERATOR_APPROVED gate

See §11.6 for the full convention. In code:

```ts
if (input.approvalToken !== 'OPERATOR_APPROVED') {
  return { ok: false, error: 'op X requires approval_token=OPERATOR_APPROVED' }
}
```

Apply this check INSIDE the connector / op handler — not only at the policy-engine layer — because the policy engine is bypassable by direct code call from another service. The handler's check is the architectural floor.

### 18.6 money-guard layered defense

Three layers protect money flow:

1. `services/brain-task-money-guard.ts → guardOperation` runs before every brain-task op execution, hard-blocks on regex match against financial patterns
2. `services/policy-engine.ts → money_pattern_hard_block` rule denies even with OPERATOR_APPROVED when caller is not `operator`
3. The handler itself checks `approvalToken === 'OPERATOR_APPROVED'`

Bypassing any single layer is not sufficient. Spec line: *"the brain never auto-spends past per-business thresholds."*

### 18.7 Loop detection on every op

`services/brain-task.ts → executePlan` calls `detectIdenticalLoop` before each step. Identical op+args twice in the 5-minute window → refuses with `brain_task.loop_detected` event. Operator-initiated calls are subject to the check too (acceptable false-positive cost; operator overrides by varying params).

### 18.8 Adversarial review on code-agent output

`services/code-agent.ts → buildPatchFromProposal` runs `coord.adversarial_review` on every validated patch with `reviewerProvider: 'anthropic'` (different family from groq producer). CRITICAL findings demote status to `sandbox_failed` so they cannot auto-apply.

### 18.9 Append-only blackboards for multi-agent coordination

`services/agent-coordination.ts → blackboardWrite` is append-only — no entry is overwritten. New entries either add information or flag a conflict with `conflictsWith` field. Manager agents reconcile. `blackboardDetectInconsistencies` flags unflagged contradictions (same topic, opposite polarity).

### 18.10 Honest "not connected" surfaces

When a capability isn't actually wired (e.g., a connector OAuth token isn't configured), the response says so honestly rather than pretending. Example: `services/chat-providers.ts` yields `_(${provider} key not set: ${envVar})_` and the outer streamChat falls back to the next provider in the chain.

### 18.11 The 5-platform connector pattern

Every platform connector follows identical shape (R3 lock-in across YouTube, Etsy, TikTok, Instagram, Shopify):

1. Import `connectorRequest` + `getConnectorSpec` from `connector-base.ts`
2. Resolve the spec via `getConnectorSpec('<platform>')!`
3. Define a `quotaTick(units=1)` helper that records to `ai_usage` with `workspaceId: '<platform>-quota'`
4. Each write op:
   - Gated by `if (input.approvalToken !== 'OPERATOR_APPROVED') return { ok: false, error: '... requires approval_token=...' }`
   - Calls `connectorRequest({ spec, accessToken, path, method, body, query })`
   - Returns `{ ok: true, ... }` or `{ ok: false, error }`
5. Each read op: no approval gate, still tickets quota
6. Multi-account ethics: NO engagement-manipulation helpers (no auto-like, no follow-trains, no engagement-between-own-accounts). Refused at module level, not configurable.
7. Money-flow ops (refund / capture / void / payment) intentionally NOT exposed in connector modules — those require the three-layer money-guard (SPEC §18.6), not a single connector call.

A 6th platform connector follows the same pattern by copying the file structure of `connector-shopify.ts` and substituting endpoint shapes.

### 18.12 The 10-domain MCP split

`routes/mcp.ts → DOMAIN_PREFIX_MAP` filters the ~165-op surface into 10 focused subsets:

| Domain | Op prefixes |
|---|---|
| `finance` | `financial.*`, `business.budget.*`, `compliance.compute_tax`, `compliance.check_international_tax` |
| `crm` | `business.feasibility`, `business.realityCheck`, `portfolio.*`, `holding.*` |
| `marketing` | `shortform.*`, `agent.dispatch`, `pod.pricing.*`, `business.create` |
| `support` | `knowledge.*`, `coord.adversarial_review` |
| `ops` | `scheduled.*`, `workflow.*`, `cron.*`, `platform.*`, `desktop.*`, `browser.*` |
| `eng` | `coding.*`, `cartographer.*`, `pipeline.*`, `sim.*`, `improve.*`, `eval.*` |
| `comms` | `etsy.*`, `youtube.*`, `tiktok.*`, `instagram.*`, `shopify.*` |
| `governance` | `policy.*`, `coord.*`, `compliance.recommend_*`, `maturity.*`, `staffing.*` |
| `hil` | `hil.*` |
| `ai_product` | `ai_product.*` |

External agents register the URL of the specific domain they want (e.g. Cursor registers `/mcp/eng`; Claude Desktop registers `/mcp/governance`). Manifest bloat eliminated.

### 18.13 The 13-tab BlueprintPage layout (updated R4)

`/blueprint` UI has 13 operator-facing tabs. Tab order is canonical (don't shuffle). The Overview tab is the default landing.

```
Overview · Maturity · Health · Cartographer · Knowledge · Evals · Policy
Simulation · Coordination · Short-form · Acquisition · Compliance · Holding-Co
```

Adding a new operator surface = new tab + backend route under `/api/v1/blueprint/<surface>`. Convention: tab is a function in `BlueprintPage.tsx`, route is in `routes/blueprint.ts`, no separate frontend or backend file per tab.

### 18.14 Architecture overview tab pattern (R4)

The default landing tab at `/blueprint?tab=architecture` aggregates from 5 services in a single backend call (`/api/v1/blueprint/architecture/overview`) and renders one screen the operator can scan in under 30 seconds:

**3 status cards (top):**
- Maturity Stage (0-5 from `assessMaturity()`)
- Self-Improvement Verdict (`healthy | investigate | pause_self_improvement` from `runAllImprovementHealthChecks()`)
- Recent Alerts count (24h sum of `governance.stability_alert | brain_task.loop_detected | cron.error`)

**Tab grid:** all 12 other tabs shown as clickable tiles with color-coded status badges (`ok | partial | alert | early`).

**Cron tasks table:** GROUP BY type FROM events WHERE type LIKE 'cron.%' AND created_at >= now()-24h. Operator sees what's actually running.

**Connector readiness grid:** `listConnectorSpecs()` → green if env vars set, gray with missing-env list if not.

**Recent alerts (conditional):** only shown when count > 0.

Convention for any future "operator dashboard" surface: aggregate from N services in one route, render in tiles, navigate-on-click. Don't build dashboards that require ≥ 2 round trips before showing actionable data.

### 18.15 Eval seed pattern (R4)

`services/eval-seed-chat.ts` ships starter eval sets for Novan's own chat behavior so a fresh install has eval coverage from day one. Pattern:

1. Module declares a `SEED_SETS: SeedSet[]` constant — golden + regression + safety + honesty sets, each with cases array
2. `seedChatEvals(workspaceId)` is idempotent — skips already-seeded sets by name
3. Returns `{ setsCreated, casesCreated, skipped }` so caller knows what landed
4. `listChatEvalSeeds()` preview-mode for the operator UI

To add seed coverage for a new subsystem: copy `eval-seed-chat.ts`, change SEED_SETS to the subsystem's behaviors, wire into the first-install hook.

### 18.16 First-install hook (R4)

`services/workspace-seed.ts → seedWorkspaceOnFirstInstall(workspaceId)` runs the operator's "day one" baseline so a brand-new workspace inherits:

1. Eval seeds via `seedChatEvals` (SPEC §18.15)
2. Default policy rules from policy-engine
3. Initial mission charter
4. The 5 playbook references injected into chat (already done at the playbook-knowledge layer)

Called from the workspace-creation flow (operator clicks "create workspace" or POSTs `/api/v1/workspaces`). Idempotent — safe to call repeatedly on the same workspace.

---

## 19. Revision Log

### R5 — Prompt-injection stack + deploy hardening (current)

Captures rounds 146.72-146.83 — the long tail after the initial 4-revision
build. Most of these are not new architectural ground; they harden the
runtime against classes of failure the earlier revisions assumed away.

Prompt-injection defense (4 deterministic layers around the brain):
- §18.17 (role-marker sanitizer) — R146.42, strips `Human:` / `Assistant:` prefixes from any LLM-bound string
- §18.18 (`<untrusted_content>` tagging) — R146.72, every boundary input the LLM consumes is wrapped with a system-prompt-declared marker. Sites: novan-chat injections (proposals, chain decisions, design briefs, memories), brain-task-browser page text
- §18.19 (provenance gate) — R146.73, `TaskOperation.provenance: 'operator' | 'planner' | 'page' | 'rollup'`. Non-operator plan steps must hit `PAGE_DERIVED_ALLOWLIST` (read/diagnostic ops only) or auto-require `OPERATOR_APPROVED`. Recursive `<untrusted_content` marker scan forces the same gate even on operator-provenance steps
- §18.20 (independent tool-call classifier) — R146.74, `tool-call-classifier.ts` runs a second LLM (Groq llama-3.1-8b primary, Anthropic/OpenAI/Gemini fallback) over `{op, sanitized params, provenance, declared_risk, untrusted_input}`. Fed structured metadata only, never the operator's text. Fail-closed for risky non-operator paths, fail-open for operator+low/medium. 1h LRU cache; trivial-skip for operator+allowlisted+low+no-untrusted. Cost ~$0.016/1000 brain-task steps measured

Beyond this stack: RLHF + an output classifier are the next layers; both live outside Novan's source tree.

Runtime hardening:
- §18.21 (no in-API drain workers) — R146.75 removed `_workflowDrain` + `_notificationsDrain` from `apps/api/src/queues/index.ts`. BullMQ load-balances jobs across all Workers bound to a queue; the in-API drain was silently winning a share of REAL workflow jobs (the real consumer is `workers/workflow-worker/src/worker.ts:103`) and acknowledging them with `{drained:true}`. Pattern: never add a "passive drain" in the producer process unless you've verified no real consumer exists
- §18.22 (autonomous worker respawn) — R146.80, BullMQ `Worker` emits `'closed'` after Redis connection loss; without re-registering, the queue silently fills. Implementation: 5s backoff doubling to 60s, reset on first successful job

Deploy posture:
- `ENFORCE_GLOBAL_AUTH=true` overrides dev-auto-auth — R146.76, `plugins/auth.ts` `devAutoAuthActive()` returns false when the flag is set, regardless of NODE_ENV. Lets the operator enforce Bearer tokens while keeping NODE_ENV=development for the bind-mounted source-reload flow (no longer needed after R146.83 but kept as defense-in-depth)
- `AUTH_SECRET` is now `${AUTH_SECRET}` in compose — R146.78, previously hardcoded `dev-secret-change-in-production` as the JWT signing key, committed to git. Rotated to fresh openssl-rand on the droplet
- Nightly `pg_dump` cron — R146.79, `scripts/backup-postgres.sh` runs at 03:30 UTC, 14-day retention, healthy-size guard, off-volume storage at `/root/backups/`
- SPA same-origin API — R146.82, `apps/web/src/api.ts` defaults `API_BASE` to `''` so the phone PWA works through Caddy's reverse-proxy at any host (the prior `'http://localhost:3001'` fallback made the phone target its own localhost)
- `NODE_ENV=production` — R146.83 engaged, enforces the §10.5 startup gate (CORS_ORIGINS, VAULT_MASTER_KEY, CHANNEL_ENCRYPTION_KEY, AUTH_SECRET required or FATAL)

Operator-side residue (not code, but tracked here):
- Provider-side rotation needed for credentials that were in git history before sanitization: Neon DB password, Upstash Redis token, old AUTH_SECRET / VAULT_MASTER_KEY from `docker-compose.local.yml`. Removing them from working tree doesn't scrub git history; the only real fix is rotation at the provider
- `OPERATOR_BOOTSTRAP_SECRET` is a permanent passwordless-mint backdoor. Rotate quarterly as policy

No R1–R4 content removed.

### R4 — Architecture overview + eval seeds + first-install flow

Captures patterns lock-in from rounds 123-127. Adds:
- §18.13 updated for 13-tab layout (Overview added as default landing)
- §18.14 (architecture overview tab pattern) — aggregate-from-N-services-in-one-route convention
- §18.15 (eval seed pattern) — idempotent starter-set seeder template
- §18.16 (first-install hook) — workspace-seed flow that wires evals + policy + charter on create
- Section 11.2 Content Operations note: 6 platform connectors now follow §18.11; Printful added as 3rd POD platform alongside Etsy + Shopify

Plus operator-runbook.md §9 added: "Reading the /blueprint Overview tab" — what each card means + how to act on it. Daily 20s scan + weekly 5min review routine codified.

No R1-R3 content removed.

### R3 — 5-platform + 10-domain MCP + 12-tab UI

Captures patterns lock-in from rounds 117-122. Adds:
- §18.11 (5-platform connector pattern) — identical shape across YouTube/Etsy/TikTok/Instagram/Shopify with explicit refused-tactic list
- §18.12 (10-domain MCP split) — DOMAIN_PREFIX_MAP table for finance/crm/marketing/support/ops/eng/comms/governance/hil/ai_product subset routing
- §18.13 (12-tab BlueprintPage layout) — canonical tab order + convention for adding new operator surfaces

No section content was removed. R2 sections retained verbatim.

### R2 — Post-build evolution

Captures lessons from 113 task entries / ~60 services / 1954 tests.

Added:
- §1.3.8 (honest failure modes) — codifies the "no fake intelligence" principle that emerged across the build
- §1.4 (architectural constraints) — $10k floor, money-guard, OPERATOR_APPROVED, locked-core surface here so they're visible from the top
- §3.3-3.4 active-deviation notes — BullMQ vs Temporal, custom orchestration vs LangGraph, pino+OTEL+ai_usage vs Langfuse, markdown playbooks vs PromptLayer
- §10.5 (locked-core registry) — canonical file list with reasons
- §10.6 (improvement proposal lifecycle) — state machine inline
- §11.5 (short-form content + multi-account ethics)
- §11.6 (OPERATOR_APPROVED convention)
- §11.7 ($10k/business floor enforcement points — all 8)
- §18 (codebase conventions) — 10 idioms with code snippets
- §19 (this revision log)

Changed:
- §3 header — added "Active Deviations" sub-title to make the deviation pattern visible
- §3.2 — added current-implementation notes for vector / graph / search choices
- §10.4 — added concrete function names

Not removed (kept verbatim from R1 to preserve operator intent):
- All §1-2 framing
- All build-sequence stages
- All §15 operating principles
- All §16 honest limitations

### R1 — Initial specification

Operator-provided 17-section build specification establishing architecture, conventions, technology defaults, build sequence, agent topology, coordination patterns, knowledge system, evaluation system, self-improvement loop, subsystem notes, team structure, financial model, legal baseline, operating principles, honest limitations, and glossary. See git history for full original text if needed.

---

## 17. Glossary

- **Agent:** A bounded AI system with a specific role, scope, memory, and authority
- **MCP:** Model Context Protocol; standard for exposing tools to AI agents
- **Manager Agent:** Coordinating agent for a specific business or domain
- **Specialist Agent:** Agent with narrow functional scope
- **Governance Layer:** Mandatory policy enforcement on agent actions
- **Knowledge Curator:** System that extracts and distributes learning
- **Eval Set:** Test cases with expected behaviors for AI quality measurement
- **Closed Loop:** A measurement-and-feedback system that drives improvement
- **Authority Threshold:** Stake level at which agent must escalate to human
- **Kill Switch:** Mechanism to halt agent activity, accessible to humans
- **Locked-Core Path:** A file the brain cannot self-modify regardless of authority. See §10.5 for the registry.
- **OPERATOR_APPROVED:** Explicit string token gating irreversible/high-risk operations. See §11.6.
- **$10k Floor:** Per-business monthly revenue target the brain treats as architectural minimum. See §11.7.
- **Money-Guard:** Three-layer defense against autonomous money flow. See §18.6.
- **Blackboard:** Append-only shared structured store for multi-agent coordination. See §18.9.

---

*This document is the source of truth. When in doubt, follow the document. When the document is wrong, update the document. The document evolves with the system.*

*Last evolved: revision R5 (prompt-injection stack + deploy hardening). See §19.*
