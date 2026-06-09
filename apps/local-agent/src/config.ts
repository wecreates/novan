/**
 * R357 — Local agent runtime config.
 *
 * Reads env vars. NEVER commit a .env file with NOVAN_OPS_TOKEN; keep it in
 * .env.local (gitignored) or pass via shell.
 */
export interface AgentConfig {
  apiBase:        string                  // droplet API root
  opsToken:       string                  // ops_* bearer
  workspaceId:    string                  // 'default'
  profilePath:    string                  // persistent Playwright user-data dir
  designsRoot:    string                  // local path to design files
  pollSeconds:    number                  // job poll interval
  headless:       boolean                 // false during account-cookie capture
  platforms:      string[]                // empty = all enabled
  runOnce:        boolean                 // CLI --once flag
  dryRun:         boolean                 // skip the final Publish click
  loginMode:      boolean                 // open browser + wait, no automation
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true'
}
function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}
function envStr(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export function loadConfig(): AgentConfig {
  const args = process.argv.slice(2)
  return {
    apiBase:     envStr('NOVAN_API_BASE', 'https://137-184-198-2.sslip.io'),
    opsToken:    envStr('NOVAN_OPS_TOKEN', ''),
    workspaceId: envStr('NOVAN_WORKSPACE_ID', 'default'),
    profilePath: envStr('NOVAN_PROFILE_PATH', './.profile'),
    designsRoot: envStr('NOVAN_DESIGNS_ROOT', '../../designs'),
    pollSeconds: envInt('NOVAN_POLL_SECONDS', 180),
    headless:    envBool('NOVAN_HEADLESS', false),
    platforms:   envStr('NOVAN_PLATFORMS', '').split(',').map(s => s.trim()).filter(Boolean),
    runOnce:     args.includes('--once'),
    dryRun:      args.includes('--dry-run') || envBool('NOVAN_DRY_RUN', false),
    loginMode:   args.includes('--login'),
  }
}

export function requireOpsToken(cfg: AgentConfig): asserts cfg is AgentConfig & { opsToken: string } {
  if (!cfg.opsToken) {
    throw new Error('NOVAN_OPS_TOKEN env var is required (operator bearer token from droplet).')
  }
}
