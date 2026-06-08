/**
 * R357 — Job orchestrator. Per-platform: check daily cap, fetch next job,
 * dispatch driver, mark uploaded, sleep.
 */
import { chromium, type BrowserContext } from 'playwright'
import path from 'node:path'
import { fetchNextJobs, fetchQueueStats, markUploaded } from './api.js'
import { sleep, pickInterUploadDelayMs } from './anti-flag.js'
import { getDriver, DRIVERS } from './platforms/index.js'
import { getDesignFilePath } from './design-cache.js'
import type { AgentConfig } from './config.js'

export async function runOnce(cfg: AgentConfig, ctx: BrowserContext): Promise<{ uploads: number; failures: number }> {
  let uploads = 0, failures = 0
  const enabled = cfg.platforms.length > 0 ? cfg.platforms : Object.keys(DRIVERS)

  const stats = await fetchQueueStats(cfg).catch((e) => {
    console.error('[orchestrator] stats fetch failed:', (e as Error).message)
    return [] as Awaited<ReturnType<typeof fetchQueueStats>>
  })

  for (const platform of enabled) {
    const driver = getDriver(platform)
    if (!driver) { console.warn(`[${platform}] no driver registered, skipping`); continue }

    const stat = stats.find(s => s.platform === platform)
    if (stat && stat.remainingToday <= 0) {
      console.log(`[${platform}] daily cap hit (${stat.dailyCap}), skipping`); continue
    }
    if (stat && stat.queued === 0) {
      console.log(`[${platform}] queue empty, skipping`); continue
    }

    const jobs = await fetchNextJobs(cfg, platform, 1).catch((e) => {
      console.error(`[${platform}] fetchNextJobs failed:`, (e as Error).message); return []
    })
    if (jobs.length === 0) { console.log(`[${platform}] no jobs`); continue }
    const job = jobs[0]!

    // Acquire design file
    let designFilePath: string
    try {
      designFilePath = await getDesignFilePath(cfg, job.designId)
    } catch (e) {
      console.error(`[${platform}] design ${job.designId} fetch failed:`, (e as Error).message)
      failures++; continue
    }

    // Drive the upload
    const page = await ctx.newPage()
    try {
      console.log(`[${platform}] → upload "${job.title}" (queue ${job.id})`)
      const loggedIn = await driver.loginCheck(page)
      if (!loggedIn) {
        console.warn(`[${platform}] NOT LOGGED IN. Go log in at ${driver.loginUrl} in this browser, then re-run.`)
        failures++; continue
      }
      const result = await driver.upload({ page, item: job, designFilePath, dryRun: cfg.dryRun })
      if (!result.ok) {
        console.error(`[${platform}] driver failed: ${result.reason}`)
        failures++; continue
      }
      console.log(`[${platform}] ✓ live at ${result.externalUrl}`)
      if (!cfg.dryRun && result.externalUrl) {
        await markUploaded(cfg, job.id, result.externalUrl).catch(e =>
          console.error(`[${platform}] markUploaded failed:`, (e as Error).message))
      }
      uploads++
    } catch (e) {
      console.error(`[${platform}] uncaught:`, (e as Error).stack ?? (e as Error).message)
      failures++
    } finally {
      await page.close()
    }

    // Inter-upload jitter so same-platform uploads don't fingerprint as a burst
    const wait = pickInterUploadDelayMs()
    console.log(`[${platform}] pacing ${(wait/1000/60).toFixed(1)} min before next platform`)
    await sleep(Math.min(wait, 60_000))  // cap to 60s in once-mode; full delay in loop
  }
  return { uploads, failures }
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
