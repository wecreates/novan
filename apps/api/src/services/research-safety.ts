/**
 * research-safety.ts — Safety gates for the Research Learning Engine.
 *
 *   1. robots.txt compliance (cached 24h)
 *   2. Unsafe-task blocklist (illegal/abusive research)
 *   3. Per-workspace kill switch ('research') overrides everything
 *   4. Source URL must be http(s) — SSRF block delegated to webFetch
 *
 * Every gate decision emits a runtime event.
 */
import { db }                from '../db/client.js'
import { killSwitches, events } from '../db/schema.js'
import { and, eq }           from 'drizzle-orm'
import { v7 as uuidv7 }      from 'uuid'

const ROBOTS_CACHE = new Map<string, { allow: boolean; expiresAt: number }>()
const ROBOTS_TTL_MS = 24 * 60 * 60_000

const UNSAFE_TASK_PATTERNS: RegExp[] = [
  /\bcsam\b|child\s+sex/i,
  /\bmake\s+(a\s+)?(bomb|explosive|weapon)/i,
  /\bdoxx?\s+/i,
  /\bbypass\s+(captcha|2fa|paywall)/i,
  /\bcredit\s+card\s+(numbers?|generator)/i,
  /\b(hack|crack)\s+into\b/i,
  /\bmalware\s+(creation|tutorial)/i,
]

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'research-safety', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function isKillSwitchOn(workspaceId: string, switchType = 'research'): Promise<boolean> {
  const row = await db.select().from(killSwitches)
    .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.switchType, switchType)))
    .limit(1).then(r => r[0]).catch(() => null)
  return !!row?.enabled
}

export function classifyUnsafeTask(text: string): { unsafe: boolean; reason?: string } {
  for (const p of UNSAFE_TASK_PATTERNS) {
    if (p.test(text)) return { unsafe: true, reason: `matched blocklist pattern: ${p.source}` }
  }
  return { unsafe: false }
}

/** Fetch + parse robots.txt for the URL's origin. Caches result 24h. */
export async function checkRobotsTxt(url: string, userAgent = 'NovanBot'): Promise<{ allowed: boolean; reason?: string }> {
  let origin: string
  try { origin = new URL(url).origin } catch { return { allowed: false, reason: 'invalid url' } }

  const cached = ROBOTS_CACHE.get(origin)
  if (cached && cached.expiresAt > Date.now()) return { allowed: cached.allow }

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      // No robots.txt → permissive default per RFC9309
      ROBOTS_CACHE.set(origin, { allow: true, expiresAt: Date.now() + ROBOTS_TTL_MS })
      return { allowed: true }
    }
    const txt = (await res.text()).slice(0, 50_000)
    const allowed = parseRobotsAllow(txt, userAgent, new URL(url).pathname)
    ROBOTS_CACHE.set(origin, { allow: allowed, expiresAt: Date.now() + ROBOTS_TTL_MS })
    return allowed ? { allowed: true } : { allowed: false, reason: 'disallowed by robots.txt' }
  } catch {
    // Fail-open on network errors but with shorter cache
    ROBOTS_CACHE.set(origin, { allow: true, expiresAt: Date.now() + 60_000 })
    return { allowed: true }
  }
}

function parseRobotsAllow(robotsTxt: string, userAgent: string, path: string): boolean {
  // Minimal RFC9309 parser: per User-agent group, collect Disallow rules.
  // Returns false if any matching rule disallows the path under * or matching UA.
  const lines = robotsTxt.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
  let currentAgents: string[] = []
  const groups = new Map<string, string[]>()
  for (const line of lines) {
    const m = line.match(/^(User-agent|Disallow|Allow):\s*(.*)$/i)
    if (!m) continue
    const key = m[1] ?? ''
    const val = m[2] ?? ''
    if (/^user-agent$/i.test(key)) {
      const ua = val.toLowerCase()
      const last = currentAgents[currentAgents.length - 1]
      currentAgents = currentAgents.length && last !== undefined && groups.has(last) ? [ua] : [...currentAgents, ua]
      if (!groups.has(ua)) groups.set(ua, [])
    } else if (/^disallow$/i.test(key)) {
      for (const a of currentAgents) {
        const arr = groups.get(a) ?? []
        arr.push(`D:${val}`)
        groups.set(a, arr)
      }
    } else if (/^allow$/i.test(key)) {
      for (const a of currentAgents) {
        const arr = groups.get(a) ?? []
        arr.push(`A:${val}`)
        groups.set(a, arr)
      }
    }
  }
  const rules = [...(groups.get(userAgent.toLowerCase()) ?? []), ...(groups.get('*') ?? [])]
  let denied = false
  for (const r of rules) {
    const [kind, pattern] = [r[0], r.slice(2)]
    if (!pattern) continue
    if (path.startsWith(pattern)) {
      if (kind === 'A') return true       // explicit allow wins
      if (kind === 'D') denied = true
    }
  }
  return !denied
}

/**
 * One-shot gate — call before every research action.
 * Returns { ok: true } only if all checks pass.
 */
export async function gateResearch(opts: {
  workspaceId: string
  url?:        string
  taskText?:   string
}): Promise<{ ok: boolean; reason?: string }> {
  if (await isKillSwitchOn(opts.workspaceId, 'research')) {
    await emit(opts.workspaceId, 'research.gate.blocked', { reason: 'kill_switch', url: opts.url })
    return { ok: false, reason: 'kill_switch enabled for research' }
  }
  if (opts.taskText) {
    const u = classifyUnsafeTask(opts.taskText)
    if (u.unsafe) {
      await emit(opts.workspaceId, 'research.gate.blocked', { reason: 'unsafe_task', detail: u.reason })
      return { ok: false, reason: `unsafe task: ${u.reason}` }
    }
  }
  if (opts.url) {
    if (!/^https?:\/\//i.test(opts.url)) {
      return { ok: false, reason: 'url must be http(s)' }
    }
    const r = await checkRobotsTxt(opts.url)
    if (!r.allowed) {
      await emit(opts.workspaceId, 'research.gate.blocked', { reason: 'robots_txt', url: opts.url })
      return { ok: false, reason: r.reason ?? 'robots.txt disallow' }
    }
  }
  return { ok: true }
}

/** Emit a learning-action event (visibility requirement). */
export async function emitLearningEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await emit(workspaceId, type, payload)
}
