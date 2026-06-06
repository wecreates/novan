/**
 * R146.267 — r262 history reader contract test (compile-time +
 * source-shape only — no DB).
 */
import { describe, it, expect } from 'vitest'
import * as r262 from '../r262-brain-health-history.js'

describe('R146.267 — r262 module exports the documented API', () => {
  it('exports persistSnapshot + readHistory + readSummary', () => {
    expect(typeof r262.persistSnapshot).toBe('function')
    expect(typeof r262.readHistory).toBe('function')
    expect(typeof r262.readSummary).toBe('function')
  })
  it('readHistory accepts (workspaceId, sinceMs?, limit?) — 3 params, last 2 optional', () => {
    expect(r262.readHistory.length).toBeLessThanOrEqual(3)
  })
  it('readSummary accepts (workspaceId, sinceMs?) — 2 params, last optional', () => {
    expect(r262.readSummary.length).toBeLessThanOrEqual(2)
  })
})
