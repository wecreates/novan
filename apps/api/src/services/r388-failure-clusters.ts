/**
 * R388 — Failure cluster detector.
 *
 * Scans the last N agent.failure events, groups by signature
 * (platform + normalized errorMessage), and surfaces the top recurring
 * failure modes. When a cluster has frequency ≥ 3, marks it as a "live
 * pattern" worth operator attention. Suggests a fix per pattern.
 *
 * Renders into the dashboard so operator sees "5 failures on etsy
 * file_upload_input — selector likely outdated, run selector.improve" at
 * a glance, instead of scrolling 50 raw events.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const LOOKBACK_MS = 7 * 24 * 60 * 60_000     // 7 days
const MIN_CLUSTER_SIZE = 2                    // ≥2 = potential pattern, ≥3 = live pattern
const MAX_CLUSTERS = 10

/** Normalize an error message so similar errors collapse: strip numbers,
 *  UUIDs, file paths, line numbers. Keep the structural skeleton. */
function normalize(msg: string): string {
  return msg
    .slice(0, 240)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\d+/g, '<n>')
    .replace(/['"][^'"]{20,}['"]/g, '<long_str>')
    .replace(/[A-Z]:\\[^\s)]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
}

function suggestFix(platform: string, normalized: string): string {
  const lc = normalized.toLowerCase()
  if (lc.includes('selector') || lc.includes('not visible') || lc.includes('timeout') && lc.includes('locator')) {
    return `Selector likely outdated for ${platform}. Run R366 selector.improve on the next failure to LLM-suggest fresh selectors from page HTML.`
  }
  if (lc.includes('cloudflare') || lc.includes('captcha') || lc.includes('challenge')) {
    return `${platform} is challenging the session. Operator: sign in once via the persistent browser context, then retry.`
  }
  if (lc.includes('navigation') || lc.includes('net::') || lc.includes('econnreset') || lc.includes('econnrefused')) {
    return `Transient network or page-navigation issue. Likely self-heals on next attempt; if recurring, check ${platform} status.`
  }
  if (lc.includes('rate') && (lc.includes('limit') || lc.includes('throttl'))) {
    return `${platform} is rate-limiting. R378 pacing should respect this; consider tightening MIN_INTERVAL_MS for ${platform}.`
  }
  if (lc.includes('login') || lc.includes('auth') || lc.includes('sign in') || lc.includes('not logged')) {
    return `Operator: session for ${platform} expired. Re-authenticate in the persistent browser.`
  }
  if (lc.includes('file') && (lc.includes('not found') || lc.includes('enoent'))) {
    return `Missing design file on disk. Verify the design_upload_queue rows reference paths that exist.`
  }
  return `Inspect a recent ${platform} failure event to identify the root cause. R366 may help if the page DOM has shifted.`
}

export interface FailureCluster {
  platform:     string
  signature:    string                       // normalized error
  count:        number
  firstSeen:    number
  lastSeen:     number
  exampleEventIds: string[]
  isLivePattern: boolean                     // count >= 3
  suggestedFix: string
}

export interface DetectClustersResult {
  clusters:        FailureCluster[]
  totalFailures:   number
  lookbackHours:   number
}

export async function detectFailureClusters(workspaceId: string): Promise<DetectClustersResult> {
  const cutoff = Date.now() - LOOKBACK_MS
  const rows = await db.execute(sql`
    SELECT id, payload, created_at
    FROM events
    WHERE workspace_id = ${workspaceId}
      AND type IN ('agent.failure', 'agent.upload.failed')
      AND created_at >= ${cutoff}
    ORDER BY created_at DESC
    LIMIT 500
  `).catch(() => [] as unknown[])

  type Row = { id: string; payload: Record<string, unknown>; created_at: number }
  const events = rows as Row[]
  const totalFailures = events.length

  const map = new Map<string, FailureCluster>()
  for (const e of events) {
    const platform = String(e.payload['platform'] ?? 'unknown')
    const rawMsg = String(e.payload['errorMessage'] ?? e.payload['reason'] ?? '')
    if (!rawMsg) continue
    const sig = normalize(rawMsg)
    const key = `${platform}|${sig}`
    const ts = Number(e.created_at)
    const ex = map.get(key)
    if (ex) {
      ex.count++
      if (ts < ex.firstSeen) ex.firstSeen = ts
      if (ts > ex.lastSeen)  ex.lastSeen = ts
      if (ex.exampleEventIds.length < 3) ex.exampleEventIds.push(e.id)
    } else {
      map.set(key, {
        platform, signature: sig,
        count: 1, firstSeen: ts, lastSeen: ts,
        exampleEventIds: [e.id],
        isLivePattern: false,
        suggestedFix: '',
      })
    }
  }

  const clusters = [...map.values()]
    .filter(c => c.count >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CLUSTERS)
    .map(c => ({
      ...c,
      isLivePattern: c.count >= 3,
      suggestedFix:  suggestFix(c.platform, c.signature),
    }))

  return { clusters, totalFailures, lookbackHours: Math.round(LOOKBACK_MS / 3_600_000) }
}
