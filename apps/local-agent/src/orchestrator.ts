/**
 * R358 — Job orchestrator (v2).
 *
 * Per-platform per-tick:
 *   1. Check daily cap via stats
 *   2. Apply account-birthday ramp clamp (R350 rule 9)
 *   3. Fetch next job
 *   4. Fetch design file → maybe generate mockups (Etsy)
 *   5. Dispatch driver
 *   6. On success → mark uploaded + post telemetry event
 *   7. On failure → screenshot + post failure report
 *   8. Pace between platforms
 *
 * Also posts a heartbeat per tick so the dashboard sees liveness.
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import path from 'node:path'
import { fetchNextJobs, fetchQueueStats, markUploaded, markFailed } from './api.js'
import { sleep, pickInterUploadDelayMs } from './anti-flag.js'
import { getDriver, DRIVERS } from './platforms/index.js'
import { getDesignFilePath } from './design-cache.js'
import { postHeartbeat, postUploadEvent, postFailureReport, type SessionCounters } from './telemetry.js'
import { fetchAllBirthdays, clampCapForAge, ageDescriptor } from './birthday-ramp.js'
import { generateMockups } from './mockup-gen.js'
import type { AgentConfig } from './config.js'

const counters: SessionCounters = { uploads: 0, failures: 0 }
const AGENT_ID = process.env['NOVAN_AGENT_ID'] ?? `agent-${Math.random().toString(36).slice(2, 10)}`

export async function runOnce(cfg: AgentConfig, ctx: BrowserContext): Promise<{ uploads: number; failures: number }> {
  const tickUploads = { v: 0 }, tickFailures = { v: 0 }
  const enabled = cfg.platforms.length > 0 ? cfg.platforms : Object.keys(DRIVERS)

  const [stats, birthdays] = await Promise.all([
    fetchQueueStats(cfg).catch(e => { console.error('[orchestrator] stats:', (e as Error).message); return [] as Awaited<ReturnType<typeof fetchQueueStats>> }),
    fetchAllBirthdays(cfg),
  ])

  // Heartbeat at the START of the tick (so we see liveness even if all platforms are gated)
  await postHeartbeat(cfg, AGENT_ID, enabled, counters)

  for (const platform of enabled) {
    const driver = getDriver(platform)
    if (!driver) { console.warn(`[${platform}] no driver, skipping`); continue }

    const stat = stats.find(s => s.platform === platform)
    if (stat && stat.queued === 0) { console.log(`[${platform}] queue empty`); continue }

    // Birthday-ramp clamp on top of platform's dailyCap
    const birthdayMs = birthdays[platform] ?? null
    const fullCap = stat?.dailyCap ?? 999
    const clampedCap = clampCapForAge(fullCap, birthdayMs)
    const usedToday = (stat?.dailyCap ?? 0) - (stat?.remainingToday ?? 0)
    if (usedToday >= clampedCap) {
      console.log(`[${platform}] ramp cap hit ${usedToday}/${clampedCap} (${ageDescriptor(birthdayMs)})`)
      continue
    }

    // R378 — server-side inter-upload pacing gate. Refuses if last upload was too recent.
    try {
      const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op: 'pacing.check_or_acquire', params: { platform, acquire: false } }] }),
      })
      if (res.ok) {
        const j = await res.json() as { data?: { results?: Array<{ ok: boolean; data: { allowed: boolean; retryAfterMs: number; minIntervalMs: number } }> } }
        const d = j.data?.results?.[0]?.data
        if (d && !d.allowed) {
          console.log(`[${platform}] pacing: skip (retry in ${Math.round(d.retryAfterMs/60_000)}min, min interval ${Math.round(d.minIntervalMs/60_000)}min)`)
          continue
        }
      }
    } catch { /* pacing optional */ }

    const jobs = await fetchNextJobs(cfg, platform, 1).catch(e => { console.error(`[${platform}] fetch:`, (e as Error).message); return [] })
    if (jobs.length === 0) { console.log(`[${platform}] no jobs`); continue }
    const job = jobs[0]!

    let designFilePath: string
    try {
      designFilePath = await getDesignFilePath(cfg, job.designId)
    } catch (e) {
      console.error(`[${platform}] design fetch:`, (e as Error).message)
      tickFailures.v++; counters.failures++; continue
    }

    // Per-platform side effects: Etsy needs mockup variants for the listing carousel
    if (platform === 'etsy') {
      const { paths, warnings } = await generateMockups(designFilePath)
      if (paths.length > 0) console.log(`[etsy] generated ${paths.length} mockups`)
      for (const w of warnings) console.warn(`[etsy] mockup: ${w}`)
      // Mockups are emitted alongside the design; Etsy driver picks them up
      // by convention (same basename + _mockup_*.jpg).
    }

    const page = await ctx.newPage()
    const startedAt = Date.now()
    try {
      console.log(`[${platform}] → upload "${job.title}" (queue ${job.id})`)
      const loggedIn = await driver.loginCheck(page)
      if (!loggedIn) {
        console.warn(`[${platform}] NOT LOGGED IN. Go log in at ${driver.loginUrl} in this browser, then re-run.`)
        await postUploadEvent(cfg, AGENT_ID, { platform, queueItemId: job.id, status: 'skipped', reason: 'not logged in' })
        tickFailures.v++; counters.failures++; continue
      }
      const result = await driver.upload({ page, item: job, designFilePath, dryRun: cfg.dryRun })
      const durationMs = Date.now() - startedAt
      if (!result.ok) {
        console.error(`[${platform}] driver failed: ${result.reason}`)
        await reportDriverFailure(cfg, page, platform, job.id, new Error(result.reason ?? 'driver returned ok:false'))
        tickFailures.v++; counters.failures++; continue
      }
      console.log(`[${platform}] ✓ live at ${result.externalUrl} (${(durationMs/1000).toFixed(1)}s)`)
      if (!cfg.dryRun && result.externalUrl) {
        await markUploaded(cfg, job.id, result.externalUrl, platform).catch(e =>
          console.error(`[${platform}] markUploaded:`, (e as Error).message))
      }
      // R378 — record the successful upload so pacing.check_or_acquire honors it next time
      try {
        await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op: 'pacing.check_or_acquire', params: { platform, acquire: true } }] }),
        })
      } catch { /* best-effort */ }
      await postUploadEvent(cfg, AGENT_ID, {
        platform, queueItemId: job.id, status: 'success',
        ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}),
        durationMs,
      })
      tickUploads.v++; counters.uploads++
    } catch (e) {
      console.error(`[${platform}] uncaught:`, (e as Error).message)
      await reportDriverFailure(cfg, page, platform, job.id, e as Error)
      tickFailures.v++; counters.failures++
    } finally {
      await page.close().catch(() => {})
    }

    // Inter-upload pacing (capped at 60s in single-tick mode; full delay between ticks)
    const wait = pickInterUploadDelayMs()
    console.log(`[${platform}] pacing ${(wait/1000/60).toFixed(1)} min before next`)
    await sleep(Math.min(wait, 60_000))
  }
  return { uploads: tickUploads.v, failures: tickFailures.v }
}

async function reportDriverFailure(cfg: AgentConfig, page: Page, platform: string, queueItemId: string, err: Error): Promise<void> {
  let screenshotBase64: string | undefined
  let pageUrl: string | undefined
  let pageHtml: string | undefined
  try { pageUrl = page.url() } catch { /* ignore */ }
  try {
    const buf = await page.screenshot({ fullPage: false, timeout: 5000 })
    screenshotBase64 = buf.toString('base64')
  } catch (e) {
    console.warn(`[${platform}] screenshot failed: ${(e as Error).message}`)
  }
  // R426 — capture page HTML (stripped of script/style) so the server-side
  // R421 selector improver can suggest revised selectors next attempt.
  try {
    const raw = await page.evaluate(() => document.documentElement?.outerHTML ?? '')
    pageHtml = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').slice(0, 8192)
  } catch { /* tolerated */ }
  await postFailureReport(cfg, AGENT_ID, {
    platform, queueItemId,
    errorMessage: err.message,
    ...(err.stack         ? { errorStack:       err.stack         } : {}),
    ...(screenshotBase64  ? { screenshotBase64                    } : {}),
    ...(pageUrl           ? { pageUrl                              } : {}),
  })
  await postUploadEvent(cfg, AGENT_ID, { platform, queueItemId, status: 'failed', reason: err.message })
  // R426 — flip the queue row to status='failed' so R402/R412/R421 can act.
  // Without this, the self-healing loop sees zero failures even when drivers crash.
  await markFailed(cfg, queueItemId, {
    reason:  err.message,
    ...(pageUrl  ? { pageUrl }  : {}),
    ...(pageHtml ? { pageHtml } : {}),
  }).catch(e => console.error(`[${platform}] markFailed:`, (e as Error).message))
}

export async function openContext(cfg: AgentConfig): Promise<BrowserContext> {
  const profileAbs = path.resolve(cfg.profilePath)
  return await chromium.launchPersistentContext(profileAbs, {
    headless: cfg.headless,
    viewport: { width: 1440, height: 900 },
    locale:   'en-US',
    timezoneId: 'America/Chicago',
    args: ['--disable-blink-features=AutomationControlled'],
  })
}
