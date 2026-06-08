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
