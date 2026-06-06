/**
 * R146.329 (#16, #17, #18) — test fixtures for OAuth state, entity
 * extractor, cost-by-business attribution, browser approval signing.
 */
import { describe, it, expect, vi } from 'vitest'
import { startFlow, verifyState } from '../services/r328-connectors.js'
import { browserApprovalKey, signBrowserApproval, verifyBrowserApproval } from '../services/r329-extras.js'

describe('R329 fixtures', () => {
  it('OAuth state round-trip: signs + verifies same workspace', () => {
    process.env['SLACK_CLIENT_ID'] = 'test-slack-id'
    process.env['AUTH_SECRET'] = 'a'.repeat(64)
    const r = startFlow({ connectorId: 'slack', workspaceId: 'ws-a', redirectBase: 'http://localhost:3001' })
    expect(r.ok).toBe(true)
    expect(r.state).toBeTruthy()
    const v = verifyState(r.state!)
    expect(v.ok).toBe(true)
    expect(v.workspaceId).toBe('ws-a')
    // Wrong workspace fails
    const tampered = r.state!.replace('ws-a', 'ws-b')
    expect(verifyState(tampered).ok).toBe(false)
  })

  it('OAuth start without client_id env returns honest gap', () => {
    delete process.env['SLACK_CLIENT_ID']
    const r = startFlow({ connectorId: 'slack', workspaceId: 'ws-x', redirectBase: 'http://x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/SLACK_CLIENT_ID/)
  })

  it('browser approval: scoped to path-prefix', () => {
    process.env['AUTH_SECRET'] = 'b'.repeat(64)
    const key = browserApprovalKey('https://example.com/search?q=x', 1)
    expect(key).toBe('APPROVE:example.com/search')
    const token = signBrowserApproval(key)
    expect(verifyBrowserApproval(token, 'https://example.com/search/results')).toBe('example.com/search')
    expect(verifyBrowserApproval(token, 'https://example.com/admin')).toBe(null)
    expect(verifyBrowserApproval(token, 'https://other.com/search')).toBe(null)
  })

  it('browser approval rejects forged signature', () => {
    process.env['AUTH_SECRET'] = 'c'.repeat(64)
    expect(verifyBrowserApproval('APPROVE:example.com/x:forgedsig', 'https://example.com/x')).toBe(null)
  })

  // The entity extractor is LLM-backed; the live API key isn't required for
  // this assertion — it just confirms the "no key" path returns []
  it('entity extractor returns [] when ANTHROPIC_API_KEY unset', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const { extractEntities } = await import('../services/r328-llm-extract.js')
    expect(await extractEntities('Sarah said hi today')).toEqual([])
  })
})
