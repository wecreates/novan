/**
 * R146.264 — Regression tests for R260-R263.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

async function src(rel: string): Promise<string> {
  const url = new URL(`../${rel}`, import.meta.url)
  return readFile(url, 'utf8')
}

describe('R146.260 — brain.health in novan-chat system prompt', () => {
  it('emits a one-liner with status glyph + tagged warnings', async () => {
    const s = await src('novan-chat.ts')
    expect(s).toMatch(/import\('\.\/r253-brain-health\.js'\)/)
    expect(s).toMatch(/Platform health: \$\{status\}/)
    expect(s).toMatch(/cost over/)
    expect(s).toMatch(/backup \$/)
    expect(s).toMatch(/applier \$/)
    expect(s).toMatch(/cron\(s\) missing/)
  })
  it('failure is .catch-tolerated (no broken system prompt)', async () => {
    const s = await src('novan-chat.ts')
    // Locate the R260 block and verify its try/catch
    const idx = s.indexOf('R146.260')
    expect(idx).toBeGreaterThan(0)
    const block = s.slice(idx, idx + 1500)
    expect(block).toMatch(/try \{/)
    expect(block).toMatch(/catch \{ \/\* tolerated \*\/ \}/)
  })
})

describe('R146.261 — brain.health card on /brain.html metrics tab', () => {
  it('loadMetrics fetches health + metrics in one Promise.all', async () => {
    const s = await src('../routes/novan-brain-chat.ts')
    expect(s).toMatch(/Promise\.all\(\[[\s\S]{0,200}call\('brain\.metrics'\)[\s\S]{0,200}call\('brain\.health'\)/)
  })
  it('renderHealth has 3 color tiers + 6 cells', async () => {
    const s = await src('../routes/novan-brain-chat.ts')
    expect(s).toMatch(/function renderHealth/)
    expect(s).toMatch(/'#0c8'/)  // healthy
    expect(s).toMatch(/'#fa0'/)  // degraded
    expect(s).toMatch(/'#f44'/)  // critical
    expect(s).toMatch(/Backup/)
    expect(s).toMatch(/Applier/)
    expect(s).toMatch(/Errors 1h/)
  })
})

describe('R146.262 — persisted brain.health snapshots', () => {
  it('R255 tick fire-and-forgets persistSnapshot', async () => {
    const s = await src('r255-brain-alert-tick.ts')
    expect(s).toMatch(/void import\('\.\/r262-brain-health-history\.js'\)/)
    expect(s).toMatch(/persistSnapshot/)
  })
  it('history op accepts sinceMs + limit', async () => {
    const s = await src('r262-brain-health-history.ts')
    expect(s).toMatch(/export async function readHistory\(workspaceId: string, sinceMs = 24/)
    expect(s).toMatch(/limit = 200/)
  })
  it('summary returns expected aggregate shape', async () => {
    const s = await src('r262-brain-health-history.ts')
    expect(s).toMatch(/ticks: number/)
    expect(s).toMatch(/healthy: number/)
    expect(s).toMatch(/maxCostSpent: number/)
    expect(s).toMatch(/maxCronMissing: number/)
  })
  it('migration 0117 exists and creates the table', async () => {
    const m = await readFile(new URL('../../../../../packages/db/migrations/0117_brain_health_snapshots.sql', import.meta.url), 'utf8')
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS brain_health_snapshots/)
    expect(m).toMatch(/CREATE INDEX IF NOT EXISTS bhs_ws_created_idx/)
  })
})

describe('R146.263 — /healthz public', () => {
  it('isPublic allowlists /healthz + /healthz/*', async () => {
    const s = await src('../server.ts')
    expect(s).toMatch(/url === '\/healthz'\s+\|\| url\.startsWith\('\/healthz\/'\)/)
  })
})
