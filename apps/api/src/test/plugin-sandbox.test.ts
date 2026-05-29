/**
 * Tests for plugin-sandbox (#3 Tier 1) — manifest + permission gate.
 * The worker_threads loader is integration-tested separately (it
 * spawns a real Node Worker); here we cover the pure validators.
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
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

import { validateManifest, checkPermission, listSupportedPermissions, type PluginManifest } from '../services/plugin-sandbox.js'

const good = {
  id: 'novan-summary',
  name: 'Novan summary plugin',
  version: '1.0.0',
  entry: 'dist/index.js',
  permissions: ['events.read', 'events.emit'],
}

// ─── Manifest validation ──────────────────────────────────────────────

describe('plugin-sandbox: validateManifest', () => {
  it('accepts a clean manifest', () => {
    const r = validateManifest(good)
    expect(r.ok).toBe(true)
    expect(r.manifest?.id).toBe('novan-summary')
  })

  it('rejects non-object input', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('hi').ok).toBe(false)
  })

  it('rejects malformed ids', () => {
    expect(validateManifest({ ...good, id: 'X' }).ok).toBe(false)
    expect(validateManifest({ ...good, id: 'has spaces' }).ok).toBe(false)
    expect(validateManifest({ ...good, id: '1starts-with-number' }).ok).toBe(false)
  })

  it('rejects non-semver versions', () => {
    expect(validateManifest({ ...good, version: 'v1' }).ok).toBe(false)
    expect(validateManifest({ ...good, version: '1.0' }).ok).toBe(false)
  })

  it('rejects path traversal in entry', () => {
    expect(validateManifest({ ...good, entry: '../etc/passwd' }).ok).toBe(false)
    expect(validateManifest({ ...good, entry: '/abs/path' }).ok).toBe(false)
  })

  it('rejects unknown permissions', () => {
    expect(validateManifest({ ...good, permissions: ['events.read', 'shell.exec'] }).ok).toBe(false)
  })

  it('rejects http.fetch without an allowedHosts list', () => {
    expect(validateManifest({ ...good, permissions: ['http.fetch'] }).ok).toBe(false)
  })

  it('accepts http.fetch when allowedHosts is non-empty', () => {
    const r = validateManifest({ ...good, permissions: ['http.fetch'], allowedHosts: ['api.example.com'] })
    expect(r.ok).toBe(true)
    expect(r.manifest?.allowedHosts).toContain('api.example.com')
  })

  it('rejects invalid hosts in allowedHosts', () => {
    expect(validateManifest({ ...good, permissions: ['http.fetch'], allowedHosts: ['http://x.com'] }).ok).toBe(false)
    expect(validateManifest({ ...good, permissions: ['http.fetch'], allowedHosts: ['*'] }).ok).toBe(false)
  })

  it('caps maxRuntimeMs at the hard ceiling', () => {
    const r = validateManifest({ ...good, maxRuntimeMs: 9_999_999 })
    expect(r.ok).toBe(true)
    expect(r.manifest?.maxRuntimeMs).toBeLessThanOrEqual(30_000)
  })

  it('caps maxHeapMb at the hard ceiling', () => {
    const r = validateManifest({ ...good, maxHeapMb: 9_999 })
    expect(r.ok).toBe(true)
    expect(r.manifest?.maxHeapMb).toBeLessThanOrEqual(128)
  })

  it('defaults limits when not specified', () => {
    const r = validateManifest(good)
    expect(r.manifest?.maxRuntimeMs).toBe(5_000)
    expect(r.manifest?.maxHeapMb).toBe(32)
  })

  it('empty permissions array is allowed', () => {
    const r = validateManifest({ ...good, permissions: [] })
    expect(r.ok).toBe(true)
  })

  it('name length is enforced', () => {
    expect(validateManifest({ ...good, name: '' }).ok).toBe(false)
    expect(validateManifest({ ...good, name: 'x'.repeat(200) }).ok).toBe(false)
  })
})

// ─── Permission gate ───────────────────────────────────────────────────

describe('plugin-sandbox: checkPermission', () => {
  const m: PluginManifest = {
    id: 'p1', name: 'p1', version: '1.0.0', entry: 'x.js',
    permissions: ['events.read', 'http.fetch'],
    allowedHosts: ['api.openai.com', 'api.anthropic.com'],
    maxRuntimeMs: 5_000, maxHeapMb: 32,
  }

  it('allows declared actions', () => {
    expect(checkPermission(m, { action: 'events.read' }).allow).toBe(true)
  })

  it('rejects undeclared actions', () => {
    expect(checkPermission(m, { action: 'memory.write' }).allow).toBe(false)
  })

  it('http.fetch requires the host on the allowlist', () => {
    expect(checkPermission(m, { action: 'http.fetch', host: 'api.openai.com' }).allow).toBe(true)
    expect(checkPermission(m, { action: 'http.fetch', host: 'evil.example.com' }).allow).toBe(false)
  })

  it('http.fetch without a host is rejected', () => {
    expect(checkPermission(m, { action: 'http.fetch' }).allow).toBe(false)
  })

  it('reason is always non-empty', () => {
    expect(checkPermission(m, { action: 'memory.write' }).reason.length).toBeGreaterThan(0)
    expect(checkPermission(m, { action: 'events.read' }).reason.length).toBeGreaterThan(0)
  })
})

describe('plugin-sandbox: listSupportedPermissions', () => {
  it('returns the canonical permission set', () => {
    const list = listSupportedPermissions()
    expect(list).toContain('events.read')
    expect(list).toContain('http.fetch')
    expect(list.length).toBe(6)
  })
})
