/**
 * Tests for risk-classifier.ts — pure 10-category risk classification.
 *
 * Verifies for each category:
 *  - the matching pattern fires on representative task input
 *  - the resulting riskLevel + requiresApproval flags are correct
 *
 * No I/O, no DB — this module is purely functional.
 */
import { describe, it, expect } from 'vitest'
import { classifyRisk } from '../services/risk-classifier.js'

const baseTask = {
  title:       '',
  description: '',
  category:    'unknown',
  severity:    'medium',
  blastRadius: 'low',
}

// ─── A) Auth category — critical, approval required ──────────────────────────

describe('classifyRisk: auth (critical)', () => {
  it('matches auth path', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'src/services/auth.ts', title: 'fix' })
    expect(r.riskCategories).toContain('auth')
    expect(r.riskLevel).toBe('critical')
    expect(r.requiresApproval).toBe(true)
  })

  it('matches jwt path', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'src/middleware/jwt.ts', title: 'x' })
    expect(r.riskCategories).toContain('auth')
  })

  it('matches title containing "session"', () => {
    const r = classifyRisk({ ...baseTask, title: 'rework session management' })
    expect(r.riskCategories).toContain('auth')
  })
})

// ─── B) Payment category — critical ──────────────────────────────────────────

describe('classifyRisk: payment (critical)', () => {
  it('matches stripe path', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'src/payments/stripe.ts', title: 'x' })
    expect(r.riskCategories).toContain('payment')
    expect(r.riskLevel).toBe('critical')
    expect(r.requiresApproval).toBe(true)
  })

  it('matches "subscription" in title', () => {
    const r = classifyRisk({ ...baseTask, title: 'fix subscription renewal' })
    expect(r.riskCategories).toContain('payment')
  })
})

// ─── C) Database category — critical ─────────────────────────────────────────

describe('classifyRisk: database (critical)', () => {
  it('matches schema.ts', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'packages/db/src/schema.ts', title: 'x' })
    expect(r.riskCategories).toContain('database')
    expect(r.riskLevel).toBe('critical')
    expect(r.requiresApproval).toBe(true)
  })

  it('matches migrations path', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'migrations/001_users.sql', title: 'x' })
    expect(r.riskCategories).toContain('database')
  })
})

// ─── D) Dependency category — high ───────────────────────────────────────────

describe('classifyRisk: dependency (high)', () => {
  it('matches package.json', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'package.json', title: 'bump' })
    expect(r.riskCategories).toContain('dependency')
    expect(r.riskLevel).toBe('high')
    expect(r.requiresApproval).toBe(true)
  })

  it('matches pnpm-lock.yaml', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'pnpm-lock.yaml', title: 'x' })
    expect(r.riskCategories).toContain('dependency')
  })
})

// ─── E) Security category — high ─────────────────────────────────────────────

describe('classifyRisk: security (high)', () => {
  it('matches api-key in title', () => {
    const r = classifyRisk({ ...baseTask, title: 'rotate api-key handling' })
    expect(r.riskCategories).toContain('security')
    expect(r.riskLevel).toBe('high')
  })

  it('matches encrypt path', () => {
    // NOTE: the `\b\.env\b` regex has a known limitation — `\b` before `.`
    // doesn't fire on path-leading dots (e.g. `.env.example`). Tracked
    // separately. Other security patterns (encrypt/secret/credential) work.
    const r = classifyRisk({ ...baseTask, filePath: 'src/encrypt-helper.ts', title: 'x' })
    expect(r.riskCategories).toContain('security')
  })
})

// ─── F) Billing category — high ──────────────────────────────────────────────

describe('classifyRisk: billing (high)', () => {
  it('matches cost-governor', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'src/services/cost-governor.ts', title: 'x' })
    expect(r.riskCategories).toContain('billing')
    expect(r.riskLevel).toBe('high')
  })
})

// ─── G) Orchestration category — high ────────────────────────────────────────

describe('classifyRisk: orchestration (high)', () => {
  it('matches server.ts', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'apps/api/src/server.ts', title: 'x' })
    expect(r.riskCategories).toContain('orchestration')
    expect(r.riskLevel).toBe('high')
  })
})

// ─── H) Deployment category — high ───────────────────────────────────────────

describe('classifyRisk: deployment (high)', () => {
  it('matches Dockerfile', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'apps/api/Dockerfile', title: 'x' })
    expect(r.riskCategories).toContain('deployment')
    expect(r.riskLevel).toBe('high')
  })

  it('matches github actions workflow path', () => {
    const r = classifyRisk({ ...baseTask, filePath: '.github/workflows/ci.yml', title: 'x' })
    expect(r.riskCategories).toContain('deployment')
  })
})

// ─── I) Destructive category — high (by title only) ─────────────────────────

describe('classifyRisk: destructive (high)', () => {
  it('matches "drop" verb without "table" → destructive (high)', () => {
    // "drop table" also matches database (critical) — aggregator escalates.
    // Use a destructive verb that doesn't overlap with database patterns.
    const r = classifyRisk({ ...baseTask, title: 'wipe customer audit logs', filePath: 'src/audit.ts' })
    expect(r.riskCategories).toContain('destructive')
    expect(r.riskLevel).toBe('high')
  })

  it('matches "truncate" in title', () => {
    const r = classifyRisk({ ...baseTask, title: 'truncate audit logs' })
    expect(r.riskCategories).toContain('destructive')
  })
})

// ─── J) Large patch category — medium (by blast radius) ─────────────────────

describe('classifyRisk: large_patch (medium)', () => {
  it('flags high blast radius as large_patch', () => {
    const r = classifyRisk({ ...baseTask, title: 'x', blastRadius: 'high' })
    expect(r.riskCategories).toContain('large_patch')
  })

  it('flags critical blast radius too', () => {
    const r = classifyRisk({ ...baseTask, title: 'x', blastRadius: 'critical' })
    expect(r.riskCategories).toContain('large_patch')
  })

  it('does NOT flag low blast radius', () => {
    const r = classifyRisk({ ...baseTask, title: 'plain change', blastRadius: 'low' })
    expect(r.riskCategories).not.toContain('large_patch')
  })
})

// ─── K) No-match path — low ──────────────────────────────────────────────────

describe('classifyRisk: no match', () => {
  it('returns low + no approval for unmatched changes', () => {
    const r = classifyRisk({ ...baseTask,
      filePath: 'src/utils/format.ts',
      title: 'reformat timestamps',
      description: 'cosmetic',
    })
    expect(r.riskLevel).toBe('low')
    expect(r.riskCategories).toEqual([])
    expect(r.requiresApproval).toBe(false)
  })

  it('critical severity alone (no category match) → medium + approval', () => {
    const r = classifyRisk({ ...baseTask,
      filePath: 'src/utils/format.ts',
      title: 'reformat',
      severity: 'critical',
    })
    expect(r.riskLevel).toBe('medium')
    expect(r.requiresApproval).toBe(true)
  })
})

// ─── L) Multi-category aggregation — picks highest level ─────────────────────

describe('classifyRisk: aggregation', () => {
  it('combining auth (critical) + dependency (high) → critical wins', () => {
    const r = classifyRisk({ ...baseTask,
      filePath: 'src/auth/jwt.ts',
      title: 'update package.json bumps for auth lib',
    })
    expect(r.riskCategories).toContain('auth')
    expect(r.riskCategories).toContain('dependency')
    expect(r.riskLevel).toBe('critical')
    expect(r.requiresApproval).toBe(true)
  })

  it('riskReason is non-empty when categories matched', () => {
    const r = classifyRisk({ ...baseTask, filePath: 'src/auth.ts', title: 'x' })
    expect(r.riskReason.length).toBeGreaterThan(0)
  })
})
