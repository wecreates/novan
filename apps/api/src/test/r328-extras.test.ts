/**
 * R146.328 (#13) — happy-path tests for new ops. Single assertion each;
 * regression insurance, not exhaustive.
 */
import { describe, it, expect } from 'vitest'
import { shouldClarify } from '../services/r327-clarify.js'
import { looksLikeRecapRequest } from '../services/r328-extras.js'
import { assessTask } from '../services/task-honest-assess.js'
import { completenessReport } from '../services/brain-completeness.js'

describe('R328 regression', () => {
  it('clarify: ambiguous "fix it" returns proceed=false with a question', () => {
    const v = shouldClarify('fix it')
    expect(v.proceed).toBe(false)
    expect(v.question).toBeTruthy()
  })

  it('clarify: specific message proceeds', () => {
    const v = shouldClarify('Draft an email to vendor Acme about the invoice due Friday')
    expect(v.proceed).toBe(true)
  })

  it('recap detector matches "what did you do yesterday"', () => {
    expect(looksLikeRecapRequest('what did you do yesterday')).toBe(true)
    expect(looksLikeRecapRequest('how is the weather')).toBe(false)
  })

  it('task assess: financial → cannot with workarounds', () => {
    const r = assessTask({ task: 'buy 100 stickers from Printful' })
    expect(r.verdict).toBe('cannot')
    expect(r.gaps[0]?.workarounds.length).toBeGreaterThan(0)
  })

  it('completeness registry: 0 missing after R328 updates', () => {
    const r = completenessReport()
    expect(r.missing).toBe(0)
    expect(r.present + r.partial + r.missing).toBe(r.total)
  })
})
