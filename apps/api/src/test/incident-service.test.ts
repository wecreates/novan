/**
 * Tests for incident-service.ts — lifecycle of incidents.
 *
 * Covers public surface that doesn't require complex DB result threading:
 * - scanAndOpenIncidents returns shape + 0-counts on empty DB
 * - listIncidents accepts optional status filter
 * - getIncident returns null for missing id
 * - createRepairTaskForIncident refuses unknown incident
 * - createRepairTaskForIncident refuses if requiresApproval=true & no approval
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockRows: unknown[] = []

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[] = mockRows): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(returnValue)
          if (prop === 'catch') return () => makeChain(returnValue)
          if (typeof prop === 'symbol') return undefined
          return () => makeChain(returnValue)
        },
      },
    )
  }
  const db = {
    select: () => makeChain(mockRows),
    insert: () => ({
      values: () => ({ then: (r: (v: unknown) => unknown) => r([]), catch: () => ({ then: (r: (v: unknown) => unknown) => r([]) }) }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ then: (r: (v: unknown) => unknown) => r([]) }) }),
    }),
  }
  return { db }
})

import {
  scanAndOpenIncidents, listIncidents, getIncident,
  createRepairTaskForIncident,
}                          from '../services/incident-service.js'

beforeEach(() => {
  mockRows = []
})

// ─── A) scanAndOpenIncidents ─────────────────────────────────────────────────

describe('incident-service: scanAndOpenIncidents', () => {
  it('returns 0s on empty DB', async () => {
    const r = await scanAndOpenIncidents('ws')
    expect(r.scanned).toBe(0)
    expect(r.opened).toBe(0)
    expect(r.updated).toBe(0)
    expect(r.incidentIds).toEqual([])
  })

  it('returns the documented shape', async () => {
    const r = await scanAndOpenIncidents('ws')
    expect(r).toHaveProperty('scanned')
    expect(r).toHaveProperty('opened')
    expect(r).toHaveProperty('updated')
    expect(Array.isArray(r.incidentIds)).toBe(true)
  })
})

// ─── B) listIncidents ────────────────────────────────────────────────────────

describe('incident-service: listIncidents', () => {
  it('returns empty array on empty DB', async () => {
    const r = await listIncidents('ws')
    expect(r).toEqual([])
  })

  it('accepts a status filter without throwing', async () => {
    const r = await listIncidents('ws', 'open')
    expect(Array.isArray(r)).toBe(true)
  })

  it('accepts a custom limit', async () => {
    const r = await listIncidents('ws', undefined, 10)
    expect(Array.isArray(r)).toBe(true)
  })
})

// ─── C) getIncident ──────────────────────────────────────────────────────────

describe('incident-service: getIncident', () => {
  it('returns null when no row exists', async () => {
    mockRows = []
    const r = await getIncident('nonexistent')
    expect(r).toBeNull()
  })

  it('returns the row when present', async () => {
    mockRows = [{ id: 'i-1', workspaceId: 'ws', type: 'provider_outage', status: 'open' }]
    const r = await getIncident('i-1')
    expect(r).not.toBeNull()
    expect(r?.id).toBe('i-1')
  })
})

// ─── D) createRepairTaskForIncident — approval gate ──────────────────────────

describe('incident-service: createRepairTaskForIncident', () => {
  it('refuses for unknown incident', async () => {
    mockRows = []
    const r = await createRepairTaskForIncident('nonexistent', 'ops', 'task-1', false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not found/i)
  })

  it('refuses when incident requires approval and none granted', async () => {
    mockRows = [{
      id: 'i-1', workspaceId: 'ws',
      type: 'rollback_failure', severity: 'critical', status: 'open',
      requiresApproval: true,
    }]
    const r = await createRepairTaskForIncident('i-1', 'ops', 'task-1', false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/approval/i)
  })

  it('proceeds when incident requires approval AND approval granted', async () => {
    mockRows = [{
      id: 'i-1', workspaceId: 'ws',
      type: 'rollback_failure', severity: 'critical', status: 'open',
      requiresApproval: true,
    }]
    const r = await createRepairTaskForIncident('i-1', 'ops', 'task-1', true)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.incidentId).toBe('i-1')
  })

  it('proceeds when incident does not require approval', async () => {
    mockRows = [{
      id: 'i-2', workspaceId: 'ws',
      type: 'provider_outage', severity: 'warning', status: 'open',
      requiresApproval: false,
    }]
    const r = await createRepairTaskForIncident('i-2', 'ops', 'task-2', false)
    expect(r.ok).toBe(true)
  })
})
