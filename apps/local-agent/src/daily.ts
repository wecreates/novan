/**
 * R361 — Daily routine.
 *
 * Operator doctrine (importance 99): every POD store needs new designs every
 * day. This script does the full morning loop:
 *
 *   1. Fire trends.run_pipeline (refill queue with 5-10 fresh designs)
 *   2. Drain queue across all enabled platforms (respects velocity caps +
 *      birthday-ramp from R358)
 *   3. Post a heartbeat + a daily-summary event
 *
 * Run once per morning:
 *   pnpm daily
 *
 * Or hook into a Windows scheduled task that runs at 8am local time:
 *   schtasks /create /tn "Novan Daily" /tr "pnpm --filter @ops/local-agent daily" /sc daily /st 08:00
 */
import fs from 'node:fs'
import path from 'node:path'
// Load .env.local before anything else
{
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      const k = m[1]!
      let v = m[2]!.trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
}

import { loadConfig, requireOpsToken } from './config.js'
import { openContext, runOnce } from './orchestrator.js'
import { postOnePin, loginCheckPinterest } from './platforms/pinterest.js'

async function callPipeline(cfg: ReturnType<typeof loadConfig>): Promise<{ generated: number; queued: number; failed: number }> {
  const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      workspace_id: cfg.workspaceId,
      plan: [{
        op:     'trends.run_pipeline',
        params: { provenCount: 5, breakoutCount: 3, nicheBreakoutCount: 2 },
      }],
    }),
  })
  if (!res.ok) throw new Error(`pipeline ${res.status}`)
  const j = await res.json() as { data: { results: Array<{ ok: boolean; data: { totals: { designsGenerated: number; queueItemsCreated: number; designsFailed: number } } }> } }
  const t = j.data.results[0]?.data?.totals
  if (!t) throw new Error('pipeline returned no totals')
  return { generated: t.designsGenerated, queued: t.queueItemsCreated, failed: t.designsFailed }
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  requireOpsToken(cfg)
  const startedAt = Date.now()

  console.log('[daily] ' + new Date().toISOString())
  console.log('[daily] step 0: sync Gumroad sales + check goal-ladder tier')
  try {
    const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op: 'sales.sync_gumroad', params: {} }] }),
    })
    if (res.ok) {
      const j = await res.json() as { data?: { results?: Array<{ ok: boolean; data: { fetched?: number; persisted?: number; tierBefore?: string; tierAfter?: string; tierUnlocked?: boolean; newTotalUsd?: number } }> } }
      const d = j.data?.results?.[0]?.data ?? {}
      console.log(`[daily] sales: persisted=${d.persisted ?? 0} 30d_mrr=$${(d.newTotalUsd ?? 0).toFixed(2)} tier=${d.tierAfter ?? '?'}${d.tierUnlocked ? ` (🎉 ${d.tierBefore} → ${d.tierAfter})` : ''}`)
    } else {
      console.log(`[daily] sales sync skipped: HTTP ${res.status}`)
    }
  } catch (e) { console.log(`[daily] sales sync skipped: ${(e as Error).message}`) }
  console.log('[daily] step 1: fire trends.run_pipeline')

  let pipe: Awaited<ReturnType<typeof callPipeline>>
  try {
    pipe = await callPipeline(cfg)
    console.log(`[daily] pipeline: generated=${pipe.generated} queued=${pipe.queued} failed=${pipe.failed}`)
  } catch (e) {
    console.error(`[daily] pipeline failed: ${(e as Error).message}`)
    pipe = { generated: 0, queued: 0, failed: 0 }
  }

  console.log('[daily] step 2: drain queue across enabled platforms')
  const ctx = await openContext(cfg)
  let totalUploads = 0
  let totalFailures = 0
  let passes = 0
  // Loop the drain up to N passes — each pass tries each enabled platform once.
  // Stop early when no platform makes progress.
  const MAX_PASSES = 8
  for (let i = 0; i < MAX_PASSES; i++) {
    passes = i + 1
    const result = await runOnce(cfg, ctx)
    totalUploads += result.uploads
    totalFailures += result.failures
    console.log(`[daily] pass ${passes}: uploads=${result.uploads} failures=${result.failures}`)
    if (result.uploads === 0) {
      console.log('[daily] no platform made progress, stopping early')
      break
    }
  }
  // R373 — Pinterest daily auto-post (1 pin per day, respects 5/day cap server-side)
  console.log('[daily] step 3: post next Pinterest pin')
  try {
    const pinPage = await ctx.newPage()
    const liveOnPinterest = await loginCheckPinterest(pinPage)
    if (!liveOnPinterest) {
      console.log('[daily] pinterest: not logged in — log into pinterest.com in the agent profile to enable auto-pin')
    } else {
      const result = await postOnePin(cfg, pinPage)
      if (result.ok) console.log(`[daily] pinterest: ✓ pin live at ${result.externalUrl}`)
      else console.log(`[daily] pinterest: skipped — ${result.reason}`)
    }
    await pinPage.close().catch(() => {})
  } catch (e) {
    console.log(`[daily] pinterest: crashed — ${(e as Error).message}`)
  }

  await ctx.close().catch(() => {})

  const elapsedMs = Date.now() - startedAt
  console.log('[daily] done ' + new Date().toISOString())
  console.log(`[daily] summary: pipeline gen=${pipe.generated} queued=${pipe.queued} | uploads=${totalUploads} failures=${totalFailures} passes=${passes} elapsed=${(elapsedMs/1000/60).toFixed(1)}min`)
}

main().catch((e: unknown) => {
  console.error('[daily] fatal:', e)
  process.exit(1)
})
