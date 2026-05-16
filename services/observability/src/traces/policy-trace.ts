import { db } from '../db.js'
import { policyTraces } from '@ops/db'
import { v7 as uuidv7 } from 'uuid'

export interface RecordPolicyTraceInput {
  traceId:     string
  workspaceId: string
  policyId:    string
  policyName:  string
  action:      string
  verdict:     string
  riskLevel:   string
  agentId?:    string
  checkedAt?:  number
}

export async function recordPolicyTrace(input: RecordPolicyTraceInput): Promise<string> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(policyTraces).values({
    id,
    workspaceId: input.workspaceId,
    traceId:     input.traceId,
    policyId:    input.policyId,
    policyName:  input.policyName,
    action:      input.action,
    verdict:     input.verdict,
    riskLevel:   input.riskLevel,
    checkedAt:   input.checkedAt ?? now,
    createdAt:   now,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
  })
  return id
}
