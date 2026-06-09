/**
 * R357 — Thin client for the droplet's brain/task API. Only the ops we need
 * for the local agent loop.
 */
import type { AgentConfig } from './config.js'

export interface QueueItem {
  id:            string
  designId:      string
  platform:      string
  status:        string
  priority:      number
  title:         string
  description:   string
  tags:          string                  // platform-stored format (csv or json)
  priceUsd:      number | null
  category:      string | null
  queuedAt:      number
  notes:         string | null
}

async function brainTask<T>(cfg: AgentConfig, plan: Array<{op: string; params: Record<string, unknown>}>): Promise<T[]> {
  const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${cfg.opsToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ workspace_id: cfg.workspaceId, plan }),
  })
  if (!res.ok) throw new Error(`brain/task ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json() as { success: boolean; data: { results: Array<{ ok: boolean; data: T; error?: string }> } }
  if (!j.success) throw new Error('brain/task: success=false')
  for (const r of j.data.results) {
    if (!r.ok) throw new Error(`op failed: ${r.error ?? 'unknown'}`)
  }
  return j.data.results.map(r => r.data)
}

export async function fetchNextJobs(cfg: AgentConfig, platform: string, limit = 1): Promise<QueueItem[]> {
  const [items] = await brainTask<QueueItem[]>(cfg, [{
    op:     'upload_queue.next',
    params: { platform, limit },
  }])
  return items ?? []
}

export async function markUploaded(cfg: AgentConfig, queueItemId: string, externalUrl: string, platform?: string): Promise<void> {
  // R506 — also touch session validity so dashboard can warn before session expires.
  const plan: Array<{ op: string; params: Record<string, unknown> }> = [
    { op: 'upload_queue.mark_uploaded', params: { queueItemId, externalUrl } },
  ]
  if (platform) plan.push({ op: 'session.touch', params: { platform, kind: 'upload_success' } })
  await brainTask<unknown>(cfg, plan)
}

/** R426 — Report a driver failure back to the queue so R402/R412/R421 can act on it. */
export async function markFailed(cfg: AgentConfig, queueItemId: string, opts: {
  reason:        string
  step?:         string         // 'upload_image', 'fill_title', 'click_publish', etc.
  pageUrl?:      string
  pageHtml?:     string         // first ~8KB stripped, helps R421 selector improver
  previousSelectors?: string[]
}): Promise<void> {
  await brainTask<unknown>(cfg, [{
    op:     'upload_queue.mark_failed',
    params: { queueItemId, ...opts, reason: opts.reason.slice(0, 500), pageHtml: opts.pageHtml?.slice(0, 8192) },
  }]).catch((e: unknown) => { console.error('[markFailed]', (e as Error).message) })
}

export async function fetchDesignFileUrl(cfg: AgentConfig, designId: string): Promise<string | null> {
  try {
    const [data] = await brainTask<{ image_url?: string }>(cfg, [{
      op:     'design.get',
      params: { designId },
    }])
    return data?.image_url ?? null
  } catch {
    return null
  }
}

export async function fetchQueueStats(cfg: AgentConfig): Promise<Array<{ platform: string; queued: number; dailyCap: number; remainingToday: number }>> {
  const [stats] = await brainTask<Array<{ platform: string; queued: number; dailyCap: number; remainingToday: number }>>(cfg, [{
    op:     'upload_queue.stats',
    params: {},
  }])
  return stats ?? []
}
