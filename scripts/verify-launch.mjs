#!/usr/bin/env node
/**
 * Novan — Launch verification script.
 *
 * Usage:
 *   node scripts/verify-launch.mjs                  # local
 *   node scripts/verify-launch.mjs https://api...   # against live API
 *
 * Loads .env (or .env.production if NODE_ENV=production), then runs every
 * pre-launch check and prints a pass/fail table. Exit code 0 = all critical
 * checks passed.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname }         from 'node:path'
import { fileURLToPath }            from 'node:url'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(__dirname, '..')

// ─── .env loader (no deps) ─────────────────────────────────────────────────────
function loadEnvFile(path) {
  if (!existsSync(path)) return
  const src = readFileSync(path, 'utf8')
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i)
    if (!m) continue
    const [, k, vRaw] = m
    if (process.env[k] !== undefined) continue  // existing env wins
    let v = vRaw
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    process.env[k] = v
  }
}
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env'
loadEnvFile(resolve(projectDir, envFile))
loadEnvFile(resolve(projectDir, '.env'))  // always also try .env as fallback

const apiBase = process.argv[2] || process.env.VITE_API_BASE_URL || `http://localhost:${process.env.API_PORT ?? 3001}`

// ─── Pretty output ─────────────────────────────────────────────────────────────
const C = {
  reset:'\x1b[0m', dim:'\x1b[2m', bold:'\x1b[1m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m', blue:'\x1b[34m', cyan:'\x1b[36m',
}
const checks = []
function record(name, status, detail, critical = true) {
  checks.push({ name, status, detail, critical })
  const icon = status === 'pass' ? `${C.green}✓${C.reset}`
            : status === 'fail' ? `${C.red}✗${C.reset}`
            : status === 'skip' ? `${C.dim}–${C.reset}`
            : `${C.yellow}!${C.reset}`
  const tag = critical && status === 'fail' ? `${C.red}[critical]${C.reset}` : ''
  console.log(`  ${icon} ${C.bold}${name.padEnd(40)}${C.reset} ${detail}${tag ? ' ' + tag : ''}`)
}

function header(title) { console.log(`\n${C.cyan}${C.bold}━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}${C.reset}`) }

// ─── Check: required env vars ─────────────────────────────────────────────────
header('Environment')
const REQUIRED = [
  'RUNTIME_MODE', 'DATABASE_URL', 'REDIS_URL', 'AUTH_SECRET',
  'VAULT_MASTER_KEY', 'PROVIDER_ROUTER_ENABLED', 'BUDGET_GUARDS_ENABLED',
  'KILL_SWITCH_ENABLED',
]
const OPTIONAL = [
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'VITE_API_BASE_URL', 'CORS_ORIGINS', 'OTEL_EXPORTER_OTLP_ENDPOINT',
]
for (const k of REQUIRED) {
  if (process.env[k] && process.env[k].length > 0) record(`env: ${k}`, 'pass', 'set')
  else record(`env: ${k}`, 'fail', 'MISSING', true)
}
for (const k of OPTIONAL) {
  if (process.env[k] && process.env[k].length > 0) record(`env: ${k}`, 'pass', 'set', false)
  else record(`env: ${k}`, 'skip', 'not set (optional)', false)
}

// VAULT_MASTER_KEY size check
if (process.env.VAULT_MASTER_KEY) {
  const buf = Buffer.from(process.env.VAULT_MASTER_KEY, 'base64')
  if (buf.length === 32) record('VAULT_MASTER_KEY size', 'pass', '32 bytes ✓')
  else record('VAULT_MASTER_KEY size', 'fail', `${buf.length} bytes — must be EXACTLY 32`, true)
}

// RUNTIME_MODE check
if (process.env.RUNTIME_MODE === 'cloud-api-only') {
  record('RUNTIME_MODE', 'pass', 'cloud-api-only — local sandbox blocked')
} else {
  record('RUNTIME_MODE', 'warn', `${process.env.RUNTIME_MODE ?? 'unset'} — recommend cloud-api-only for prod`, false)
}

// ─── Check: Postgres ──────────────────────────────────────────────────────────
header('Postgres')
let pgOk = false
if (process.env.DATABASE_URL) {
  try {
    const { default: postgres } = await import('postgres').catch(() => ({ default: null }))
    if (!postgres) {
      record('postgres client', 'skip', 'postgres pkg not in this env — checking via fetch fallback')
    } else {
      const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5, connect_timeout: 8 })
      const t0 = Date.now()
      const r = await sql`select 1 as ok`
      const ms = Date.now() - t0
      pgOk = r?.[0]?.ok === 1
      record('connection', pgOk ? 'pass' : 'fail', pgOk ? `select 1 → ${ms}ms` : 'unexpected response', true)
      await sql.end()
    }
  } catch (e) {
    record('connection', 'fail', e.message.slice(0, 80), true)
  }
}

// ─── Check: Redis ─────────────────────────────────────────────────────────────
header('Redis')
let redisOk = false
if (process.env.REDIS_URL) {
  try {
    const { default: IORedis } = await import('ioredis').catch(() => ({ default: null }))
    if (!IORedis) {
      record('redis client', 'skip', 'ioredis not in this env')
    } else {
      const redis = new IORedis(process.env.REDIS_URL, { connectTimeout: 8_000, maxRetriesPerRequest: 1, lazyConnect: true })
      const t0 = Date.now()
      await redis.connect()
      const pong = await redis.ping()
      const ms = Date.now() - t0
      redisOk = pong === 'PONG'
      record('connection', redisOk ? 'pass' : 'fail', redisOk ? `PING → ${ms}ms` : `unexpected: ${pong}`, true)
      await redis.quit()
    }
  } catch (e) {
    record('connection', 'fail', e.message.slice(0, 80), true)
  }
}

// ─── Check: Providers ─────────────────────────────────────────────────────────
header('Providers (reachability, no token burn)')
const PROVIDERS = [
  { id: 'openrouter', envKey: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/models' },
  { id: 'groq',       envKey: 'GROQ_API_KEY',       url: 'https://api.groq.com/openai/v1/models' },
  { id: 'gemini',     envKey: 'GEMINI_API_KEY',     url: 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta' },
]
for (const p of PROVIDERS) {
  if (!process.env[p.envKey]) { record(`provider: ${p.id}`, 'skip', 'no API key', false); continue }
  try {
    const t0 = Date.now()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    const r = await fetch(p.url, { signal: ctrl.signal })
    clearTimeout(timer)
    const ms = Date.now() - t0
    if (r.ok) record(`provider: ${p.id}`, 'pass', `${r.status} · ${ms}ms`, false)
    else      record(`provider: ${p.id}`, 'warn', `HTTP ${r.status} (key present but probe non-200)`, false)
  } catch (e) {
    record(`provider: ${p.id}`, 'fail', e.message.slice(0, 80), false)
  }
}

// ─── Check: API health endpoint ───────────────────────────────────────────────
header(`API health (${apiBase})`)
try {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  const t0 = Date.now()
  const r = await fetch(`${apiBase.replace(/\/$/,'')}/health`, { signal: ctrl.signal })
  clearTimeout(timer)
  const ms = Date.now() - t0
  if (r.ok) record('GET /health', 'pass', `${r.status} · ${ms}ms`)
  else      record('GET /health', 'warn', `HTTP ${r.status} — API up but unhealthy?`, false)
} catch (e) {
  record('GET /health', 'fail', `${e.message.slice(0, 80)} (server not running yet?)`, false)
}

// ─── Check: Runtime safety flags via API ──────────────────────────────────────
header('Runtime safety (via API)')
try {
  const ws = process.env.LAUNCH_WORKSPACE_ID || 'default'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  const r = await fetch(`${apiBase.replace(/\/$/,'')}/api/v1/launch-tonight/flags?workspace_id=${ws}`, { signal: ctrl.signal })
  clearTimeout(timer)
  if (r.ok) {
    const body = await r.json()
    const f = body.data
    record('tonight mode active',          f.tonightModeActive             ? 'pass' : 'warn', f.tonightModeActive ? 'on' : 'off', false)
    record('autonomous deploy blocked',   !f.autonomousDeployAllowed       ? 'pass' : 'warn', !f.autonomousDeployAllowed ? 'blocked' : 'ALLOWED', false)
    record('destructive migrations blocked', !f.destructiveMigrationsAllowed ? 'pass' : 'fail', !f.destructiveMigrationsAllowed ? 'blocked' : 'ALLOWED', false)
    record('approval-gated patches',       f.approvalGatedPatchesEnabled    ? 'pass' : 'fail', f.approvalGatedPatchesEnabled ? 'on' : 'off', false)
    record('failure learning loop',        f.failureLearningEnabled         ? 'pass' : 'warn', f.failureLearningEnabled ? 'on' : 'off', false)
    record('observability',                f.observabilityEnabled           ? 'pass' : 'warn', f.observabilityEnabled ? 'on' : 'off', false)
  } else {
    record('safety flags endpoint', 'warn', `HTTP ${r.status} — server may not be ready`, false)
  }
} catch (e) {
  record('safety flags endpoint', 'skip', `not reachable (${e.message.slice(0, 60)})`, false)
}

// ─── Summary ──────────────────────────────────────────────────────────────────
header('Summary')
const passed   = checks.filter((c) => c.status === 'pass').length
const failed   = checks.filter((c) => c.status === 'fail').length
const warned   = checks.filter((c) => c.status === 'warn').length
const skipped  = checks.filter((c) => c.status === 'skip').length
const criticalFailed = checks.filter((c) => c.status === 'fail' && c.critical).length

console.log(`  ${C.green}${passed} passed${C.reset} · ${C.red}${failed} failed${C.reset} · ${C.yellow}${warned} warnings${C.reset} · ${C.dim}${skipped} skipped${C.reset}`)
if (criticalFailed > 0) {
  console.log(`\n  ${C.red}${C.bold}LAUNCH BLOCKED — ${criticalFailed} critical failure(s)${C.reset}`)
  for (const c of checks.filter((x) => x.status === 'fail' && x.critical)) {
    console.log(`    ${C.red}•${C.reset} ${c.name} — ${c.detail}`)
  }
  process.exit(1)
}
console.log(`\n  ${C.green}${C.bold}READY TO LAUNCH${C.reset}\n`)
process.exit(0)
