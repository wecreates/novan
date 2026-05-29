/**
 * Tests for the AI Constitution Layer (#52).
 * The whole platform's "is this allowed at all?" check.
 */
import { describe, it, expect } from 'vitest'
import { checkConstitution, listPrinciples, type ProposedAction } from '../services/ai-constitution.js'

function action(over: Partial<ProposedAction> = {}): ProposedAction {
  return {
    kind: 'test.action',
    autonomous: false,
    hidesFromOperator: false,
    reducesOperatorAuthority: false,
    modifiesGovernance: false,
    fabricatesRecord: false,
    selfModifies: false,
    ...over,
  }
}

describe('ai-constitution: clean baseline', () => {
  it('allows a benign action', () => {
    expect(checkConstitution(action()).verdict).toBe('allow')
  })
  it('exposes the principle list for the UI', () => {
    expect(listPrinciples().length).toBe(6)
    expect(listPrinciples()[0]!.id).toBe('protect_operator_sovereignty')
  })
})

describe('ai-constitution: each principle blocks correctly', () => {
  it('blocks anything that reduces operator authority', () => {
    const r = checkConstitution(action({ reducesOperatorAuthority: true }))
    expect(r.verdict).toBe('block')
    expect(r.violated).toContain('protect_operator_sovereignty')
  })

  it('blocks hidden-from-operator actions', () => {
    expect(checkConstitution(action({ hidesFromOperator: true })).verdict).toBe('block')
  })

  it('blocks fabricated records', () => {
    expect(checkConstitution(action({ fabricatesRecord: true })).verdict).toBe('block')
  })

  it('blocks autonomous self-modification', () => {
    expect(checkConstitution(action({ selfModifies: true, autonomous: true })).verdict).toBe('block')
  })

  it('allows operator-approved self-modification (not autonomous)', () => {
    expect(checkConstitution(action({ selfModifies: true, autonomous: false })).verdict).toBe('allow')
  })

  it('blocks autonomous governance changes', () => {
    expect(checkConstitution(action({ modifiesGovernance: true, autonomous: true })).verdict).toBe('block')
  })

  it('blocks autonomous high-risk actions', () => {
    expect(checkConstitution(action({ autonomous: true, risk: 'high' })).verdict).toBe('block')
  })

  it('allows operator-approved high-risk actions', () => {
    expect(checkConstitution(action({ autonomous: false, risk: 'high' })).verdict).toBe('allow')
  })
})

describe('ai-constitution: multi-violation cases', () => {
  it('lists every violated principle', () => {
    const r = checkConstitution(action({
      hidesFromOperator: true, fabricatesRecord: true, reducesOperatorAuthority: true,
    }))
    expect(r.verdict).toBe('block')
    expect(r.violated.length).toBeGreaterThanOrEqual(3)
  })

  it('block reason is human-readable and not empty', () => {
    const r = checkConstitution(action({ hidesFromOperator: true }))
    expect(r.reason.length).toBeGreaterThan(0)
    expect(r.reason).toMatch(/audit|hide/i)
  })
})

describe('ai-constitution: immutability of the principle order', () => {
  it('operator sovereignty is principle #0', () => {
    expect(listPrinciples()[0]!.id).toBe('protect_operator_sovereignty')
  })
  it('truth preservation appears before self-modification', () => {
    const ids = listPrinciples().map(p => p.id)
    expect(ids.indexOf('preserve_truth')).toBeLessThan(ids.indexOf('no_unsafe_self_modification'))
  })
})
