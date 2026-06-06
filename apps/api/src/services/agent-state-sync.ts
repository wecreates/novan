/**
 * agent-state-sync.ts — Unified heartbeat bridge for all AI agents.
 *
 * Until now there were three disconnected agent registries:
 *   1. `agents` DB table        (16 research/intelligence types, mostly idle forever)
 *   2. `agent-registry.ts`      (in-memory, 7 patch-pipeline types)
 *   3. `agent_registrations`    (heartbeat table, empty)
 *
 * This file is the single bridge. Any service that does AI work calls
 * `recordAgentActivity(ws, capability)` and the matching agents-table
 * row's `last_active_at` + `heartbeat_at` are updated. The brain UI +
 * activity dashboards see real telemetry instead of dead rows.
 *
 * No new schema. No new tables. Just unifies what's already there.
 */
import { db } from '../db/client.js'
import { agents, agentRegistrations, events } from '../db/schema.js'
import { and, eq, sql, inArray, lt } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Operation → agent type/capability map ─────────────────────────────
//
// Every brain-task op + every key autonomous service maps to one of
// the agent types in the `agents` table. When the op runs, the matching
// row's heartbeat ticks.

const OP_TO_AGENT: Record<string, { type: string; capability: string }> = {
  // brain-task ops
  'db.query':            { type: 'memory_curator',      capability: 'memory.cluster' },
  'platform.smoke':      { type: 'reliability_trend',   capability: 'reliability.trend' },
  'providers.validate':  { type: 'reliability_trend',   capability: 'rollback.signal' },
  'mind.cycle':          { type: 'research_planner',    capability: 'plan.queue' },
  'issue.ingest':        { type: 'workflow_friction',   capability: 'workflow.failure.rank' },
  'issue.auto_loop':     { type: 'workflow',            capability: 'workflow-execution' },
  'issue.create':        { type: 'workflow_friction',   capability: 'workflow.failure.rank' },
  'proposal.approve':    { type: 'workflow',            capability: 'approval-routing' },
  'proposal.reject':     { type: 'workflow',            capability: 'approval-routing' },
  'proposal.build':      { type: 'workflow',            capability: 'workflow-execution' },
  'code.search':         { type: 'web_research',        capability: 'extract.facts' },
  'web.fetch':           { type: 'web_research',        capability: 'web.fetch' },
  'video.analyze':       { type: 'web_research',        capability: 'extract.facts' },
  'safety.flags':        { type: 'security_research',   capability: 'advisory.parse' },

  // browser ops
  'browser.open':        { type: 'web_research',        capability: 'web.fetch' },
  'browser.navigate':    { type: 'web_research',        capability: 'web.fetch' },
  'browser.click':       { type: 'web_research',        capability: 'extract.facts' },
  'browser.fill':        { type: 'web_research',        capability: 'extract.facts' },
  'browser.text':        { type: 'web_research',        capability: 'extract.facts' },
  'browser.screenshot':  { type: 'web_research',        capability: 'extract.facts' },
  'browser.evaluate':    { type: 'web_research',        capability: 'extract.facts' },
  'browser.wait_for':    { type: 'web_research',        capability: 'web.fetch' },
  'browser.list':        { type: 'web_research',        capability: 'web.fetch' },
  'browser.close':       { type: 'web_research',        capability: 'web.fetch' },

  // desktop ops
  'desktop.exec':        { type: 'workflow',            capability: 'workflow-execution' },
  'desktop.read_file':   { type: 'memory_curator',      capability: 'memory.cluster' },
  'desktop.write_file':  { type: 'workflow',            capability: 'workflow-execution' },
  'desktop.list_dir':    { type: 'memory_curator',      capability: 'memory.cluster' },
  'desktop.open_app':    { type: 'workflow',            capability: 'workflow-execution' },
  'desktop.screenshot':  { type: 'ux_insight',          capability: 'ux.friction.detect' },
  'desktop.processes':   { type: 'reliability_trend',   capability: 'reliability.trend' },
  'desktop.kill':        { type: 'workflow',            capability: 'workflow-execution' },
}

// In-memory patch-pipeline types → agents table mapping. These don't
// have direct equivalents so we synthesize.
const PATCH_AGENT_TO_TYPE: Record<string, string> = {
  planner:     'research_planner',
  coder:       'workflow',
  reviewer:    'fact_checker',
  tester:      'reliability_trend',
  security:    'security_research',
  reliability: 'reliability_trend',
  cto:         'research_planner',
}

// ─── Heartbeat ──────────────────────────────────────────────────────────

/**
 * Update the matching agent row's heartbeat + last_active_at. Idempotent
 * and non-throwing — failure here must never block real work.
 *
 * `agentType` may also be a brain-task op name; we resolve via OP_TO_AGENT.
 */
export async function recordAgentActivity(
  workspaceId: string,
  agentTypeOrOp: string,
  opts: { status?: 'idle' | 'running' | 'paused' | 'error' | 'offline'; jobId?: string } = {},
): Promise<void> {
  const mapped = OP_TO_AGENT[agentTypeOrOp]
  const type   = mapped?.type ?? PATCH_AGENT_TO_TYPE[agentTypeOrOp] ?? agentTypeOrOp
  const now    = Date.now()
  const status = opts.status ?? 'running'

  try {
    // First row with this type in this workspace gets the update. We
    // don't care which one if there are duplicates — they're equivalent.
    const row = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.type, type)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (row) {
      await db.update(agents).set({
        status, lastActiveAt: now, heartbeatAt: now, updatedAt: now,
      }).where(eq(agents.id, row.id)).catch((e: Error) => { console.error('[agent-state-sync]', e.message); return null })
    }
  } catch { /* tolerated */ }
}

/** Fire-and-forget wrapper — never awaits. Use when you don't want to add latency. */
export function recordAgentActivityAsync(workspaceId: string, agentTypeOrOp: string, opts: Parameters<typeof recordAgentActivity>[2] = {}): void {
  void recordAgentActivity(workspaceId, agentTypeOrOp, opts)
}

// ─── Worker registration heartbeat ──────────────────────────────────────
//
// Workers + the API process itself should appear in agent_registrations
// so the orchestrator's stuck-agent detector + the brain graph have
// something to render. Empty heartbeats = invisible agents.

export interface AgentSelfRegister {
  workspaceId:   string
  agentName:     string
  capabilities:  string[]
}

export async function selfRegister(input: AgentSelfRegister): Promise<void> {
  // R146.222 — single atomic upsert via the new uniq index. setWhere
  // skips no-op writes (same status + same capabilities + heartbeat
  // <60s stale). Reduces ~113 writes/day per row to ~24 (one per heart-
  // beat-stale boundary), about 4-5× cut while preserving liveness.
  const now = Date.now()
  const FRESH_HB_MS = 60_000
  try {
    await db.insert(agentRegistrations).values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      agentName: input.agentName,
      capabilities: input.capabilities,
      status: 'idle',
      lastHeartbeat: now,
      registeredAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [agentRegistrations.workspaceId, agentRegistrations.agentName],
      set: {
        status: 'idle', lastHeartbeat: now,
        capabilities: input.capabilities, updatedAt: now,
      },
      // R146.274 — compare capabilities by joined text instead of array.
      // Drizzle's ${jsArray} inline yields a `record` literal, which the
      // planner refuses to compare against text[] ('text[] <> record').
      // The comma-joined string compare is type-safe and equally selective.
      setWhere: sql`
        ${agentRegistrations.status} <> 'idle'
        OR array_to_string(${agentRegistrations.capabilities}, ',') <> ${input.capabilities.join(',')}
        OR ${agentRegistrations.lastHeartbeat} < ${now - FRESH_HB_MS}
      `,
    }).catch((e: Error) => { console.error('[agent-state-sync]', e.message); return null })
  } catch { /* tolerated */ }
}

let heartbeatTimer: NodeJS.Timeout | null = null
// R146.322 — re-entrancy guard. beat() runs every 60s, but DB UPDATEs can
// stall under load; without this flag overlapping beats burn connections
// and create undefined ordering between the two UPDATEs.
let beatInFlight = false

/**
 * Start periodic self-registration for the API process. Each cycle
 * heartbeats every agent type that has been registered + activates
 * the rows. Call from server.ts boot.
 */
export function startAgentHeartbeatTicker(workspaceId = 'default', intervalMs = 60_000): void {
  if (heartbeatTimer) return
  // Register the API-side agent set immediately, then on every tick.
  const beat = async () => {
    if (beatInFlight) return
    beatInFlight = true
    try {
    const now = Date.now()
    try {
      // Heartbeat all agents in the workspace — any row that has been
      // touched in the last hour stays 'idle' (alive), older rows go
      // 'offline' to surface staleness.
      await db.update(agents).set({ heartbeatAt: now, updatedAt: now })
        .where(and(
          eq(agents.workspaceId, workspaceId),
          inArray(agents.status, ['idle', 'running']),
        )).catch((e: Error) => { console.error('[agent-state-sync]', e.message); return null })

      // Also register the API itself in agent_registrations so the
      // orchestrator's heartbeat scanner sees something.
      await selfRegister({
        workspaceId, agentName: 'api-server',
        capabilities: ['route-serving', 'auto-loop-driver', 'brain-task-executor'],
      })

      // IMPORTANT: don't auto-register workers we haven't seen heartbeat.
      // Each worker writes its own row via @ops/db's startWorkerHeartbeat
      // when actually running. Here we just demote stale rows to 'down'.
      const FIVE_MIN_AGO = now - 5 * 60_000
      await db.update(agentRegistrations)
        .set({ status: 'down', updatedAt: now })
        .where(and(
          eq(agentRegistrations.workspaceId, workspaceId),
          eq(agentRegistrations.status, 'idle'),
          lt(agentRegistrations.lastHeartbeat, FIVE_MIN_AGO),
        ))
        .catch((e: Error) => { console.error('[agent-state-sync]', e.message); return null })
    } catch { /* tolerated */ }
    } finally {
      beatInFlight = false
    }
  }
  // R146.325 (#5) — jitter to avoid lockstep with other 60s tickers
  // (runtime-heartbeat, connector-oauth reap, brain-task-browser reap).
  // Without jitter all four fire in the same second every minute.
  const jitter = Math.floor((process.pid % 15) * 1000)
  setTimeout(() => {
    void beat()
    heartbeatTimer = setInterval(() => void beat(), intervalMs)
  }, jitter)
}

export function stopAgentHeartbeatTicker(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}

// ─── Audit emit (so heartbeats are queryable) ──────────────────────────

export async function emitAgentEvent(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'agent-state-sync', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[agent-state-sync]', e.message); return null })
}

// Silence unused imports — sql kept available for ad-hoc bumps.
void sql
