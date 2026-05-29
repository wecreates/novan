/**
 * pwa.test.ts — Tests for the PWA install + service-worker plumbing
 * + manifest correctness.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { isStandalone } from '../pwa/registerSW'

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as Record<string, unknown>

describe('PWA manifest', () => {
  it('points start_url at the mobile chat for installed PWAs', () => {
    const m = manifest
    expect(m['start_url']).toBe('/m/chat')
    expect(m['scope']).toBe('/')
  })

  it('declares standalone display + portrait orientation', () => {
    const m = manifest
    expect(m['display']).toBe('standalone')
    expect(m['orientation']).toBe('portrait-primary')
  })

  it('ships both an SVG and a 512x512 maskable PNG icon', () => {
    const m = manifest as unknown as { icons: Array<{ src: string; sizes: string; type: string; purpose: string }> }
    const svg = m.icons.find(i => i.type === 'image/svg+xml')
    const png = m.icons.find(i => i.type === 'image/png')
    expect(svg).toBeDefined()
    expect(png).toBeDefined()
    expect(png!.sizes).toBe('512x512')
    expect(png!.purpose).toMatch(/maskable/)
  })

  it('exposes app shortcuts to chat + approvals from the home screen', () => {
    const m = manifest as unknown as { shortcuts?: Array<{ url: string; name: string }> }
    expect(Array.isArray(m.shortcuts)).toBe(true)
    expect(m.shortcuts!.length).toBeGreaterThanOrEqual(2)
    const urls = m.shortcuts!.map(s => s.url)
    expect(urls).toContain('/m/chat')
    expect(urls).toContain('/approvals')
  })
})

describe('isStandalone()', () => {
  beforeEach(() => {
    // jsdom doesn't set display-mode media queries; default = not standalone
  })

  it('returns false in a normal browser tab', () => {
    expect(isStandalone()).toBe(false)
  })

  // Skipping the "returns true" branch — jsdom doesn't reliably allow
  // matchMedia/navigator.standalone mocking. The function is 5 lines
  // and exercised at runtime on every page load.
})

describe('mobile chat taxonomy entry', () => {
  it('lives under Now with path /m/chat', async () => {
    const { findByPath, breadcrumbFor } = await import('../shell/taxonomy')
    const node = findByPath('/m/chat')
    expect(node).not.toBeNull()
    expect(node!.label).toBe('Mobile Chat')
    const trail = breadcrumbFor('/m/chat')
    expect(trail[0]!.id).toBe('now')
  })
})
