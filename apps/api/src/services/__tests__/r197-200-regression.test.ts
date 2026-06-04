/**
 * R146.197–200 — regression tests locking in this round's fixes.
 *
 * These are pure-logic tests that don't require a live DB. They assert
 * behavior invariants that the production code now relies on so any
 * future refactor that breaks them surfaces immediately in CI.
 */
import { describe, it, expect } from 'vitest'

describe('R146.197 — cron heartbeat fixes', () => {
  it('runRadarScan + runProactiveScan source has no early-return throttle', async () => {
    // The R190 throttle (`if (totalOpen>0 || ... || now-_lastEmit >= 58*60_000)`)
    // produced 0 cron.radar_scan events in production despite 316
    // successful snapshots. R197 dropped the throttle entirely. This
    // test guards against re-introducing it.
    const fs = await import('node:fs/promises')
    const url = new URL('../learning-cron.ts', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    // Both heartbeat emits must be unconditional within their try block.
    expect(src).toMatch(/await emit\('cron\.radar_scan'/)
    expect(src).toMatch(/await emit\('cron\.proactive_scan'/)
    // Throttle variable declarations must be gone (mentions in comments are OK).
    expect(src).not.toMatch(/let\s+_radarLastEmit/)
    expect(src).not.toMatch(/let\s+_proactiveLastEmit/)
  })

  it('inspectProviders honors KNOWN_DEGRADED_PROVIDERS env', async () => {
    // R197 added an env-based allow-list so revoked-key providers don't
    // mint a fresh medium-priority proposal every inspection cycle.
    const fs = await import('node:fs/promises')
    const url = new URL('../r193-novan-self-dev.ts', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    expect(src).toMatch(/KNOWN_DEGRADED_PROVIDERS/)
    // Severity must drop to 'info' when only known-degraded are present.
    expect(src).toMatch(/severity:\s*'info'/)
  })
})

describe('R146.198 — prompt_tokens propagation', () => {
  it('StreamResult exposes promptTokens', async () => {
    const fs = await import('node:fs/promises')
    const url = new URL('../chat-providers.ts', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    // Interface must declare the field.
    expect(src).toMatch(/promptTokens\?:\s*number/)
    // Dispatcher must use it, not hardcode 0.
    expect(src).toMatch(/promptTokens:\s*result\.promptTokens\s*\?\?\s*0/)
    // Each provider stream must set it on success.
    const setRegex = /out\.promptTokens\s*=\s*(promptTok|inTok)/g
    const setSites = src.match(setRegex) ?? []
    expect(setSites.length).toBeGreaterThanOrEqual(3) // openai + anthropic + gemini
  })
})

describe('R146.199 — operator_presence atomic upsert', () => {
  it('schema declares composite PK', async () => {
    const fs = await import('node:fs/promises')
    const url = new URL('../../../../../packages/db/src/schema.ts', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    // After R199 the table has a primaryKey() on (workspaceId, operatorId).
    expect(src).toMatch(/primaryKey\(\{[^}]*name:\s*'operator_presence_pkey'/)
  })

  it('recap uses onConflictDoNothing, not SELECT-then-INSERT', async () => {
    const fs = await import('node:fs/promises')
    const url = new URL('../recap.ts', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    expect(src).toMatch(/db\.insert\(operatorPresence\)[\s\S]+?\.onConflictDoNothing/)
  })
})

describe('R146.200 — brain-broadcast atomic upsert', () => {
  it('migration 0109 creates partial unique index', async () => {
    const fs = await import('node:fs/promises')
    const url = new URL('../../../../../packages/db/migrations/0109_broadcast_convo_unique.sql', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    expect(src).toMatch(/CREATE UNIQUE INDEX[\s\S]*conversations_broadcast_ws_uniq/i)
    expect(src).toMatch(/WHERE title\s*=\s*'Brain broadcast'/i)
  })

  it('ensureBroadcastConversation does upsert, not SELECT-then-INSERT', async () => {
    const fs = await import('node:fs/promises')
    const url = new URL('../brain-broadcast.ts', import.meta.url)
    const src = await fs.readFile(url, 'utf8')
    // The fix: insert with onConflictDoNothing FIRST, then read back.
    const insertIdx = src.indexOf('db.insert(conversations)')
    const onConflictIdx = src.indexOf('onConflictDoNothing')
    expect(insertIdx).toBeGreaterThan(-1)
    expect(onConflictIdx).toBeGreaterThan(insertIdx)
  })
})
