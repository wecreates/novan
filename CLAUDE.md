# Novan — Claude Operating Instructions

**Read `docs/SPEC.md` first.** That document is the canonical specification.
When a request conflicts with the spec, the spec wins unless explicitly overridden.

## Quick orientation

- **What this is:** multi-business automation platform (see SPEC §1.1)
- **Current coverage:** `docs/SPEC_COVERAGE.md` maps every spec section to code
- **Build sequence:** SPEC §4 — do not skip stages
- **Architecture:** 9-layer model — SPEC §2.1, layer specs in §5

## Before making changes

1. Read the relevant SPEC section
2. Check `docs/SPEC_COVERAGE.md` for existing implementation
3. Search the codebase for existing patterns before introducing new ones
4. Tests + typecheck pass before committing

## Operating principles (SPEC §15 condensed)

**Always:**
- Read relevant SPEC section · check existing patterns · use established tools/libraries
- Write tests alongside code · add observability · update SPEC.md when decisions evolve
- Surface uncertainty · escalate when stakes exceed agent authority

**Never:**
- Bypass governance to ship faster
- Modify the governance layer, audit log, or kill switches (see `LOCKED_CORE_PATHS` in `services/self-improvement.ts`)
- Reduce eval coverage to make changes pass
- Take irreversible actions without explicit `approval_token="OPERATOR_APPROVED"`
- Store secrets anywhere except the secret manager
- Log PII or sensitive data

**When uncertain:**
- Default to safer option
- Prefer reversible over irreversible
- Surface the uncertainty — don't hide it
- Document the decision

## Locked-core paths (cannot self-modify)

Per SPEC §5.8 and `services/self-improvement.ts`:
- `services/policy-engine.ts` — governance
- `services/kill-switch*` — emergency stop
- `services/audit*` — append-only history
- `services/mission-charter.ts` — constitution
- `services/self-improvement.ts` — the meta-loop itself
- `services/agent-coordination.ts` — coordination primitives
- `services/safety-policy.ts` — intent denylist + path policy + content scanner
- `db/schema.ts` / `packages/db/src/schema.ts` — structural integrity

Operator approves changes to these via explicit code change + human review, not through the brain.

## Tooling baseline

- **Typecheck:** `pnpm --filter @ops/api typecheck` and `pnpm --filter @ops/web typecheck` both must be green
- **Tests:** `pnpm --filter @ops/api test -- --run` — 2061/2061 must pass (95 files)
- **Migration:** add to `packages/db/migrations/NNNN_*.sql` with matching Drizzle schema edit in `packages/db/src/schema.ts`
- **New service:** under `apps/api/src/services/`; if operator-callable, wire into `services/brain-task.ts` OPERATIONS map
- **New route:** under `apps/api/src/routes/` and register in `apps/api/src/server.ts`
- **New frontend page:** under `apps/web/src/pages/` and route in `apps/web/src/App.tsx`

## Patterns to follow (codebase idioms)

These are surfaced by `services/codebase-cartographer.ts → identifyIdioms`:

1. **service-events** — services emit structured events on state changes (`db.insert(events).values({...})`)
2. **ai-usage-tracking** — every LLM/image/voice call records `recordAiUsage({...})`
3. **reasoning-chains** — decisions get a chain row so the brain timeline shows the why
4. **brain-task-op** — new capabilities expose via `OPERATIONS` map in `brain-task.ts` with `{ description, risk, handler }`
5. **OPERATOR_APPROVED gate** — any high/critical risk op requires `approval_token="OPERATOR_APPROVED"`
6. **money-guard** — `services/brain-task-money-guard.ts` hard-blocks financial patterns from non-operator callers

## When asked to "build X"

1. Find the SPEC section X belongs to
2. Check SPEC_COVERAGE for existing implementation
3. If already built — extend, don't duplicate
4. If new — follow the patterns in the existing service most similar
5. Test + typecheck before reporting done
6. Update SPEC_COVERAGE if the change shifts a coverage level

## Honest limitations (SPEC §16)

This system is buildable in pieces over years. Anyone working on it should remain honest about what is reliable today versus what is aspirational. Long-horizon agent reliability is unsolved, novel situations produce confabulation, multi-agent coordination at scale is frontier work, high-stakes irreversible actions remain in human-in-the-loop tier indefinitely.

---

*This document is for Claude sessions. When in doubt, follow SPEC.md. When SPEC.md is wrong, update it.*
