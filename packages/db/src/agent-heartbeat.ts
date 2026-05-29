/**
 * agent-heartbeat.ts — Self-heartbeat helper for worker processes.
 *
 * Each worker calls `startWorkerHeartbeat({ name, capabilities, db })` once
 * at boot. From then on the worker writes a heartbeat row every 30s into
 * agent_registrations. The orchestrator's stuck-detector picks up workers
 * that stop heartbeating (no activity > 5 min).
 *
 * Lives in packages/db because every worker already imports from here.
 */
import { agentRegistrations } from './schema.js'
import { v7 as uuidv7 } from 'uuid'

export interface WorkerHeartbeatOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           any   // drizzle instance (postgres-js or neon)
  workspaceId?: string
  name:         string
  capabilities: string[]
  intervalMs?:  number
}

const timers = new Map<string, NodeJS.Timeout>()

export function startWorkerHeartbeat(opts: WorkerHeartbeatOpts): () => void {
  const intervalMs = opts.intervalMs ?? 30_000
  const workspaceId = opts.workspaceId ?? 'default'
  const beat = async (): Promise<void> => {
    const now = Date.now()
    try {
      // Atomic upsert via the (workspace_id, agent_name) unique constraint
      // (migration 0044). Replaces the prior SELECT-then-INSERT/UPDATE that
      // could race under concurrent heartbeats and create duplicate rows.
      await opts.db.insert(agentRegistrations).values({
        id: uuidv7(),
        workspaceId,
        agentName: opts.name,
        capabilities: opts.capabilities,
        status: 'idle',
        lastHeartbeat: now,
        registeredAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [agentRegistrations.workspaceId, agentRegistrations.agentName],
        set: {
          status: 'idle',
          lastHeartbeat: now,
          updatedAt: now,
          capabilities: opts.capabilities,
        },
      }).catch(() => null)
    } catch { /* tolerated — worker keeps running */ }
  }
  void beat()
  const t = setInterval(() => void beat(), intervalMs)
  timers.set(opts.name, t)
  return () => {
    clearInterval(t)
    timers.delete(opts.name)
  }
}

// Silence unused-import lint when only the function is consumed
void agentRegistrations
