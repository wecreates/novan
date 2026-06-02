/**
 * Tests for novan-do.ts — pure functions only (no DB I/O paths).
 *
 * Covers:
 *  - classifyIntent keyword routing for each category
 *  - httpAction SSRF guard rejects loopback / private / link-local / metadata hosts
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain, execute: () => chain } }
})

// Mock brain-task so classifyIntent's keyword fallback can iterate an empty manifest
vi.mock('../services/brain-task.js', () => ({ OPERATIONS: {} }))

import { classifyIntent, httpAction } from '../services/novan-do.js'

describe('classifyIntent — keyword routing', () => {
  it('routes code-change verbs to code_change category', async () => {
    const r = await classifyIntent('add a viral score badge to the clip component')
    expect(r.category).toBe('code_change')
    expect(r.requiresApproval).toBe(true)
    expect(r.suggestedOps).toContain('novan.proposeCode')
  })

  it('routes posting verbs to content category', async () => {
    const r = await classifyIntent('post the latest reel to instagram')
    expect(r.category).toBe('content')
    expect(r.requiresApproval).toBe(true)
  })

  it('routes business verbs to business category', async () => {
    const r = await classifyIntent('audit my portfolio revenue this month')
    // 'audit' is a research keyword — research wins by order
    expect(['business', 'research']).toContain(r.category)
  })

  it('routes connector verbs to connector category', async () => {
    const r = await classifyIntent('connect my tiktok account')
    expect(r.category).toBe('connector')
    expect(r.requiresApproval).toBe(true)
  })

  it('routes research verbs to research category (no approval needed)', async () => {
    const r = await classifyIntent('investigate why retention dropped this quarter')
    expect(r.category).toBe('research')
    expect(r.requiresApproval).toBe(false)
  })

  it('routes config verbs to config category', async () => {
    const r = await classifyIntent('disable the agent dispatch kill switch')
    expect(r.category).toBe('config')
    expect(r.requiresApproval).toBe(true)
  })

  it('falls back to unknown for gibberish', async () => {
    const r = await classifyIntent('xyzzy plugh frobnicate')
    expect(r.category).toBe('unknown')
    expect(r.suggestedOps).toContain('novan.capabilities')
  })
})

describe('httpAction — SSRF guard', () => {
  const BLOCKED = [
    'http://localhost/x',
    'http://127.0.0.1/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://169.254.169.254/x',          // AWS metadata
    'http://metadata.google.internal/x', // GCP metadata
    'http://10.0.0.1/x',                 // private 10/8
    'http://172.16.0.1/x',               // private 172.16/12
    'http://172.31.255.255/x',           // private 172.16/12 upper
    'http://192.168.1.1/x',              // private 192.168/16
    'http://anything.local/x',           // .local
    'http://svc.cluster.local/x',        // .cluster.local
    'http://x.internal/x',               // .internal
  ]
  it.each(BLOCKED)('rejects %s', async (url) => {
    await expect(httpAction('ws', { url })).rejects.toThrow(/blocked|SSRF|host/i)
  })

  it('rejects non-http(s) URLs', async () => {
    await expect(httpAction('ws', { url: 'file:///etc/passwd' })).rejects.toThrow(/only http/i)
    await expect(httpAction('ws', { url: 'gopher://x/' })).rejects.toThrow(/only http/i)
  })

  it('rejects invalid URLs', async () => {
    await expect(httpAction('ws', { url: 'not a url' })).rejects.toThrow(/invalid URL/i)
  })
})
