/**
 * R357 — Novan Local Agent entry point.
 *
 * Runs on operator's machine. Polls the droplet's upload_queue, drives
 * Playwright through per-platform drivers using a persistent residential
 * browser profile.
 *
 * Usage:
 *   NOVAN_OPS_TOKEN=ops_... pnpm --filter @ops/local-agent start
 *   NOVAN_OPS_TOKEN=ops_... pnpm --filter @ops/local-agent once
 *   NOVAN_OPS_TOKEN=ops_... NOVAN_DRY_RUN=1 pnpm --filter @ops/local-agent once
 */
// Manual .env.local loader — runs BEFORE any other import so config.ts sees the vars.
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
import { openContext, runOnce } from './orchestrator.js'
import { sleep } from './anti-flag.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  requireOpsToken(cfg)

  console.log('[agent] booting')
  console.log('  api          =', cfg.apiBase)
  console.log('  workspace    =', cfg.workspaceId)
  console.log('  profile      =', cfg.profilePath)
  console.log('  headless     =', cfg.headless)
  console.log('  platforms    =', cfg.platforms.length === 0 ? 'all' : cfg.platforms.join(', '))
  console.log('  poll seconds =', cfg.pollSeconds)
  console.log('  dry run      =', cfg.dryRun)
  console.log('  once         =', cfg.runOnce)

  const ctx = await openContext(cfg)

  // Login mode: open browser to platform login URLs, wait for operator to
  // close the window, then save the cookies and exit. One-time setup per
  // platform. Run with `pnpm login`.
  if (cfg.loginMode) {
    const { getDriver } = await import('./platforms/index.js')
    const targets = (cfg.platforms.length > 0 ? cfg.platforms : ['gumroad','inprnt','fine_art_america'])
    console.log('[agent] LOGIN MODE — opening tabs for:', targets.join(', '))
    console.log('[agent] log in to each, then CLOSE THE WINDOW (X). Cookies will persist.')
    for (const platform of targets) {
      const d = getDriver(platform)
      if (!d) continue
      const page = await ctx.newPage()
      await page.goto(d.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    // Wait for operator to close the window. We poll pages.length() instead
    // of subscribing to the close event because the close event can fire
    // spuriously during initial page loads. Only consider the window closed
    // when pages.length() drops to 0 AFTER a 30s grace period from launch.
    await new Promise<void>(resolve => setTimeout(resolve, 30_000))
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        try {
          if (ctx.pages().length === 0) { clearInterval(check); resolve() }
        } catch { clearInterval(check); resolve() }
      }, 2000)
      // safety timeout: 30 min
      setTimeout(() => { clearInterval(check); resolve() }, 30 * 60 * 1000)
    })
    console.log('[agent] login session ended; cookies persisted to', cfg.profilePath)
    return
  }

  // Single-pass mode (for debugging + first run)
  if (cfg.runOnce) {
    const result = await runOnce(cfg, ctx)
    console.log(`[agent] once-pass done: uploads=${result.uploads} failures=${result.failures}`)
    await ctx.close()
    return
  }

  // Long-running loop
  process.on('SIGINT',  async () => { console.log('[agent] SIGINT, closing'); await ctx.close(); process.exit(0) })
  process.on('SIGTERM', async () => { console.log('[agent] SIGTERM, closing'); await ctx.close(); process.exit(0) })

  while (true) {
    try {
      const result = await runOnce(cfg, ctx)
      console.log(`[agent] tick done uploads=${result.uploads} failures=${result.failures} sleeping ${cfg.pollSeconds}s`)
    } catch (e) {
      console.error('[agent] tick crashed:', (e as Error).stack ?? (e as Error).message)
    }
    await sleep(cfg.pollSeconds * 1000)
  }
}

main().catch((e: unknown) => {
  console.error('[agent] fatal:', e)
  process.exit(1)
})
