/**
 * Engineering Agent Registry
 *
 * 7 agent types with in-memory state tracking.
 * Safety lock triggers after SAFETY_LOCK_THRESHOLD consecutive failures.
 */

import { v7 as uuidv7 } from 'uuid'
import { db }           from '../db/client.js'
import { events }       from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentType =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'security'
  | 'reliability'
  | 'cto'

export type AgentState = 'idle' | 'running' | 'paused' | 'locked' | 'error'

export interface AgentRecord {
  id:                   string
  type:                 AgentType
  workspaceId:          string
  state:                AgentState
  consecutiveFailures:  number
  safetyLocked:         boolean
  pausedReason:         string | null
  lastJobId:            string | null
  lastJobAt:            number | null
  totalJobsRun:         number
  totalPatchesApplied:  number
  createdAt:            number
  updatedAt:            number
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const SAFETY_LOCK_THRESHOLD = 3

const ALL_TYPES: AgentType[] = [
  'planner', 'coder', 'reviewer', 'tester', 'security', 'reliability', 'cto',
]

// ─── In-memory store ──────────────────────────────────────────────────────────

const store = new Map<string, AgentRecord>()

function key(workspaceId: string, type: AgentType): string {
  return `${workspaceId}:${type}`
}

function makeDefault(workspaceId: string, type: AgentType): AgentRecord {
  const now = Date.now()
  return {
    id: uuidv7(), type, workspaceId,
    state: 'idle',
    consecutiveFailures: 0,
    safetyLocked: false,
    pausedReason: null,
    lastJobId: null, lastJobAt: null,
    totalJobsRun: 0, totalPatchesApplied: 0,
    createdAt: now, updatedAt: now,
  }
}

// ─── Event helper ─────────────────────────────────────────────────────────────

async function emit(
  workspaceId: string, type: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/eng-agents', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getAgent(workspaceId: string, type: AgentType): AgentRecord {
  const k = key(workspaceId, type)
  if (!store.has(k)) store.set(k, makeDefault(workspaceId, type))
  return store.get(k)!
}

export function listAgents(workspaceId: string): AgentRecord[] {
  return ALL_TYPES.map(t => getAgent(workspaceId, t))
}

export async function pauseAgent(
  workspaceId: string, type: AgentType, reason: string,
): Promise<AgentRecord> {
  const agent = getAgent(workspaceId, type)
  if (agent.safetyLocked) throw new Error('Agent is safety-locked — unlock first')
  agent.state = 'paused'
  agent.pausedReason = reason
  agent.updatedAt = Date.now()
  await emit(workspaceId, 'eng_agent.paused', { agentType: type, reason })
  return agent
}

export async function resumeAgent(
  workspaceId: string, type: AgentType,
): Promise<AgentRecord> {
  const agent = getAgent(workspaceId, type)
  if (agent.safetyLocked) throw new Error('Agent is safety-locked — unlock first')
  agent.state = 'idle'
  agent.pausedReason = null
  agent.updatedAt = Date.now()
  await emit(workspaceId, 'eng_agent.resumed', { agentType: type })
  return agent
}

export async function unlockAgent(
  workspaceId: string, type: AgentType,
): Promise<AgentRecord> {
  const agent = getAgent(workspaceId, type)
  agent.safetyLocked = false
  agent.consecutiveFailures = 0
  agent.state = 'idle'
  agent.pausedReason = null
  agent.updatedAt = Date.now()
  await emit(workspaceId, 'eng_agent.unlocked', { agentType: type })
  return agent
}

export function recordAgentFailure(workspaceId: string, type: AgentType): AgentRecord {
  const agent = getAgent(workspaceId, type)
  agent.consecutiveFailures++
  if (agent.consecutiveFailures >= SAFETY_LOCK_THRESHOLD) {
    agent.safetyLocked = true
    agent.state = 'locked'
  } else {
    agent.state = 'error'
  }
  agent.updatedAt = Date.now()
  return agent
}

export function recordAgentSuccess(
  workspaceId: string, type: AgentType,
  jobId: string, patchApplied: boolean,
): AgentRecord {
  const agent = getAgent(workspaceId, type)
  agent.consecutiveFailures = 0
  agent.state = 'idle'
  agent.lastJobId = jobId
  agent.lastJobAt = Date.now()
  agent.totalJobsRun++
  if (patchApplied) agent.totalPatchesApplied++
  agent.updatedAt = Date.now()
  return agent
}
