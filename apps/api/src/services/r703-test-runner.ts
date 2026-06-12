/**
 * R703 — Smoke test runner for the R647-R702 surface.
 *
 * Hits each brain op + public surface with the minimum valid input
 * and records pass/fail. Operator runs `test.run_smoke` after a deploy
 * to know the platform is intact. Doesn't replace a real CI suite —
 * just gives a confidence floor.
 */

export interface TestCase { name: string; run: () => Promise<void> }
export interface TestResult { name: string; ok: boolean; ms: number; error?: string }

export async function runSmoke(): Promise<{ ok: boolean; total: number; passed: number; failed: number; results: TestResult[] }> {
  const cases: TestCase[] = [
    {
      name: 'brain.list returns ≥ 1500 ops',
      run: async () => {
        const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, unknown> }
        const n = Object.keys(mod.OPERATIONS ?? {}).length
        if (n < 1500) throw new Error(`only ${n} ops`)
      },
    },
    {
      name: 'R685 embed.text returns 1536-dim vector',
      run: async () => {
        const { embedText } = await import('./r685-embeddings.js')
        const r = await embedText('test')
        if (!r.ok || !r.vector || r.vector.length !== 1536) throw new Error('bad vector')
      },
    },
    {
      name: 'R660 budget.status reachable',
      run: async () => {
        const { getBudgetStatus } = await import('./r660-agent-budget.js')
        const s = await getBudgetStatus('default')
        if (typeof s.cap !== 'number') throw new Error('bad status')
      },
    },
    {
      name: 'R684 ops.health snapshot completes',
      run: async () => {
        const { snapshot } = await import('./r684-ops-health.js')
        const s = await snapshot('default')
        if (!s.ok) throw new Error('snapshot failed')
      },
    },
    {
      name: 'R690 forecast.spend returns projection',
      run: async () => {
        const { forecast } = await import('./r690-cost-forecast.js')
        const f = await forecast('default')
        if (!f.ok || f.projection7d.length !== 7) throw new Error('bad projection')
      },
    },
    {
      name: 'R692 backup.list reachable',
      run: async () => {
        const { listBackups } = await import('./r692-db-backup.js')
        const list = await listBackups()
        if (!Array.isArray(list)) throw new Error('bad list')
      },
    },
    {
      name: 'R697 audit log writes',
      run: async () => {
        const { audit, queryAuditLog } = await import('./r697-audit-log.js')
        audit({ actorType: 'system', event: 'r703.smoke', outcome: 'success' })
        await new Promise(r => setTimeout(r, 200))
        const rows = await queryAuditLog({ event: 'r703.smoke', limit: 1 })
        if (rows.length === 0) throw new Error('no audit row')
      },
    },
    {
      name: 'R701 migration tracker reachable',
      run: async () => {
        const { listMigrations } = await import('./r701-migrations.js')
        const m = await listMigrations()
        if (!Array.isArray(m)) throw new Error('bad migrations')
      },
    },
    {
      name: 'R663 chat cache stats reachable',
      run: async () => {
        const { getChatCacheStats } = await import('./r675-chat-cache.js')
        const s = getChatCacheStats()
        if (typeof s.size !== 'number') throw new Error('bad cache stats')
      },
    },
    {
      name: 'R651 native tools registry build',
      run: async () => {
        const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, { description?: string }> }
        if (!mod.OPERATIONS?.['brain.list']) throw new Error('brain.list missing')
      },
    },
  ]

  const results: TestResult[] = []
  for (const c of cases) {
    const t0 = Date.now()
    try {
      await c.run()
      results.push({ name: c.name, ok: true, ms: Date.now() - t0 })
    } catch (e) {
      results.push({ name: c.name, ok: false, ms: Date.now() - t0, error: (e as Error).message })
    }
  }
  const passed = results.filter(r => r.ok).length
  return { ok: passed === results.length, total: results.length, passed, failed: results.length - passed, results }
}
