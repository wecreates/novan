/**
 * R365 — Drive-all-tabs.
 *
 * Opens persistent Chromium with one tab per enabled platform, drives each
 * tab sequentially through whatever work is possible, and KEEPS THE BROWSER
 * OPEN AT THE END. Operator closes when satisfied — agent does not close.
 *
 * Run:  pnpm drive
 */
import fs from 'node:fs'
import path from 'node:path'
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
import { openContext } from './orchestrator.js'
import { fetchNextJobs, markUploaded } from './api.js'
import { getDriver, DRIVERS } from './platforms/index.js'
import { getDesignFilePath } from './design-cache.js'
import { postUploadEvent, postFailureReport } from './telemetry.js'

const AGENT_ID = process.env['NOVAN_AGENT_ID'] ?? `agent-${Math.random().toString(36).slice(2, 10)}`

async function main(): Promise<void> {
  const cfg = loadConfig()
  requireOpsToken(cfg)

  const enabled = cfg.platforms.length > 0 ? cfg.platforms : Object.keys(DRIVERS)

  console.log('[drive-all] opening browser')
  const ctx = await openContext(cfg)

  // 1) Open ONE tab per platform up front so operator sees them all
  const tabs: Array<{ platform: string; page: Awaited<ReturnType<typeof ctx.newPage>> }> = []
  for (const platform of enabled) {
    const d = getDriver(platform)
    if (!d) continue
    const page = await ctx.newPage()
    await page.goto(d.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    tabs.push({ platform, page })
  }

  console.log(`[drive-all] ${tabs.length} tabs open. Driving each one — browser stays open.`)

  // 2) For each tab, attempt the platform's upload flow
  for (const { platform, page } of tabs) {
    const driver = getDriver(platform)
    if (!driver) continue
    console.log(`[${platform}] ──────────────────`)
    try {
      // Skip loginCheck — operator may already be logged in but our check selectors are wrong.
      // Just attempt the upload; if it fails because of auth, the upload() will surface it.
      // Pull next job for this platform
      const jobs = await fetchNextJobs(cfg, platform, 1).catch(() => [])
      if (jobs.length === 0) {
        console.log(`[${platform}] queue empty`)
        continue
      }
      const job = jobs[0]!
      let designPath: string
      try { designPath = await getDesignFilePath(cfg, job.designId) }
      catch (e) { console.error(`[${platform}] design fetch:`, (e as Error).message); continue }

      console.log(`[${platform}] → uploading "${job.title}"`)
      const startedAt = Date.now()
      const result = await driver.upload({ page, item: job, designFilePath: designPath, dryRun: cfg.dryRun })
      const durationMs = Date.now() - startedAt
      if (!result.ok) {
        console.error(`[${platform}] ✗ ${result.reason}`)
        await postUploadEvent(cfg, AGENT_ID, { platform, queueItemId: job.id, status: 'failed', reason: result.reason ?? '?', durationMs })
        continue
      }
      console.log(`[${platform}] ✓ ${result.externalUrl}`)
      if (!cfg.dryRun && result.externalUrl) {
        await markUploaded(cfg, job.id, result.externalUrl, platform).catch(e =>
          console.error(`[${platform}] markUploaded:`, (e as Error).message))
      }
      await postUploadEvent(cfg, AGENT_ID, {
        platform, queueItemId: job.id, status: 'success',
        ...(result.externalUrl ? { externalUrl: result.externalUrl } : {}),
        durationMs,
      })
    } catch (e) {
      const err = e as Error
      console.error(`[${platform}] crashed:`, err.message)
      try {
        const buf = await page.screenshot({ fullPage: false, timeout: 5000 })
        await postFailureReport(cfg, AGENT_ID, {
          platform,
          errorMessage: err.message,
          ...(err.stack ? { errorStack: err.stack } : {}),
          screenshotBase64: buf.toString('base64'),
          pageUrl: page.url(),
        })
      } catch { /* ignore */ }
    }
  }

  console.log('')
  console.log('[drive-all] done. Browser is staying open — close it yourself when you are satisfied.')
  console.log('[drive-all] Process will exit on its own when you close the window.')

  // Wait until operator closes the window
  await new Promise<void>(resolve => setTimeout(resolve, 30_000))
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      try { if (ctx.pages().length === 0) { clearInterval(check); resolve() } }
      catch { clearInterval(check); resolve() }
    }, 3000)
    setTimeout(() => { clearInterval(check); resolve() }, 4 * 60 * 60 * 1000)  // 4h max
  })
  console.log('[drive-all] browser closed by operator. Bye.')
}

main().catch((e: unknown) => {
  console.error('[drive-all] fatal:', e)
  process.exit(1)
})
