/**
 * R602 — Background autobrowser pool.
 *
 * Any agent (R193 selfdev, R598 pipelines, chat ops, cron) can run a Playwright
 * task without stepping on each other. The pool runs N isolated Chromium
 * workers concurrently; agents submit jobs and either await results or fire-and-
 * forget.
 *
 * Hard safety guarantees:
 *   - Uses Playwright's BUNDLED Chromium binary only (chromium.launch()).
 *     NEVER touches the operator's real Chrome — no taskkill, no pkill, no
 *     Get-Process chrome | Stop-Process. Each worker spawns its own chromium
 *     process tree, killed only via Playwright API on shutdown.
 *   - Each worker has its own user_data_dir under /tmp so cookies and storage
 *     do not bleed between agents or businesses.
 *
 * Concurrency model:
 *   - AUTOBROWSER_POOL_SIZE workers (default 4, env-tunable).
 *   - Jobs in `autobrowser_jobs` table with status queued|running|done|failed.
 *   - tickPool() picks queued jobs, assigns to idle workers, runs the script
 *     against a context.page, persists result. Called every 5s by learning-cron.
 *   - jobRun() runs a job synchronously and returns the result (for callers
 *     that need the answer right now).
 *
 * Job script types:
 *   - 'navigate'      { url, waitForSelector? }                → returns title + html length
 *   - 'screenshot'    { url, waitForSelector?, fullPage? }     → returns base64 PNG
 *   - 'extract_text'  { url, selector? }                       → returns text content
 *   - 'click_chain'   { url, steps: [{action,selector,value?}] }→ returns success bool + final url
 *   - 'fetch_html'    { url, waitForSelector? }                → returns full HTML
 *
 * Future scripts plug in via JOB_RUNNERS.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

// ─── Pool size + state ───────────────────────────────────────────────────────

const POOL_SIZE = (() => {
  const n = Number(process.env['AUTOBROWSER_POOL_SIZE'] ?? '4')
  return Number.isFinite(n) && n > 0 ? Math.min(16, Math.max(1, Math.floor(n))) : 4
})()
const JOB_TIMEOUT_MS = 90_000

interface Worker {
  id:       number
  busy:     boolean
  browser?: any   // Playwright Browser
  dataDir?: string
}

const workers: Worker[] = Array.from({ length: POOL_SIZE }, (_, i) => ({ id: i, busy: false }))

async function getPlaywright(): Promise<any> {
  return await import('playwright')
}

async function ensureWorker(w: Worker): Promise<any> {
  if (w.browser) return w.browser
  const pw = await getPlaywright()
  w.dataDir = await mkdtemp(join(tmpdir(), `r602-pw-${w.id}-`))
  const launchOpts: Record<string, unknown> = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    viewport: { width: 1280, height: 800 },
  }
  // R602 — Alpine container ships chromium via apk; point Playwright at it.
  if (process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']) {
    launchOpts['executablePath'] = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
  }
  w.browser = await pw.chromium.launchPersistentContext(w.dataDir, launchOpts)
  return w.browser
}

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS autobrowser_jobs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      business_id  TEXT,
      agent_id     TEXT NOT NULL,
      script       TEXT NOT NULL,
      input        JSONB NOT NULL DEFAULT '{}'::jsonb,
      status       TEXT NOT NULL DEFAULT 'queued',
      result       JSONB,
      error        TEXT,
      worker_id    INT,
      duration_ms  INT,
      created_at   BIGINT NOT NULL,
      started_at   BIGINT,
      ended_at     BIGINT,
      priority     INT NOT NULL DEFAULT 50
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS autobrowser_jobs_status_idx ON autobrowser_jobs (status, priority DESC, created_at ASC) WHERE status = 'queued'`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS autobrowser_jobs_ws_idx ON autobrowser_jobs (workspace_id, created_at DESC)`).catch(() => {})
}

// ─── Job runners ─────────────────────────────────────────────────────────────

type JobInput = Record<string, unknown>

const JOB_RUNNERS: Record<string, (page: any, input: JobInput) => Promise<unknown>> = {
  navigate: async (page, input) => {
    const url = String(input['url'] ?? '')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (input['waitForSelector']) await page.waitForSelector(String(input['waitForSelector']), { timeout: 15_000 }).catch(() => null)
    const title = await page.title()
    const html  = await page.content()
    return { ok: true, title, finalUrl: page.url(), htmlLength: html.length }
  },
  screenshot: async (page, input) => {
    const url = String(input['url'] ?? '')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (input['waitForSelector']) await page.waitForSelector(String(input['waitForSelector']), { timeout: 15_000 }).catch(() => null)
    const buf: Buffer = await page.screenshot({ fullPage: !!input['fullPage'], type: 'png' })
    return { ok: true, finalUrl: page.url(), pngBase64: buf.toString('base64'), bytes: buf.length }
  },
  extract_text: async (page, input) => {
    const url = String(input['url'] ?? '')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const selector = input['selector'] ? String(input['selector']) : 'body'
    const text = await page.locator(selector).first().innerText().catch(() => '')
    return { ok: true, finalUrl: page.url(), selector, text: text.slice(0, 100_000) }
  },
  fetch_html: async (page, input) => {
    const url = String(input['url'] ?? '')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    if (input['waitForSelector']) await page.waitForSelector(String(input['waitForSelector']), { timeout: 15_000 }).catch(() => null)
    return { ok: true, finalUrl: page.url(), html: (await page.content()).slice(0, 500_000) }
  },
  click_chain: async (page, input) => {
    const url = String(input['url'] ?? '')
    const steps = Array.isArray(input['steps']) ? input['steps'] as Array<{ action: string; selector?: string; value?: string; waitMs?: number }> : []
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    for (const step of steps) {
      try {
        if (step.action === 'click' && step.selector)  await page.locator(step.selector).first().click({ timeout: 10_000 })
        else if (step.action === 'fill' && step.selector) await page.locator(step.selector).first().fill(String(step.value ?? ''), { timeout: 10_000 })
        else if (step.action === 'press' && step.value)   await page.keyboard.press(step.value)
        else if (step.action === 'wait')                  await page.waitForTimeout(Math.min(10_000, step.waitMs ?? 1000))
        else if (step.action === 'waitForSelector' && step.selector) await page.waitForSelector(step.selector, { timeout: 15_000 })
      } catch (e) {
        return { ok: false, error: `step ${step.action}/${step.selector ?? step.value} failed: ${(e as Error).message}`, finalUrl: page.url() }
      }
    }
    return { ok: true, finalUrl: page.url(), title: await page.title() }
  },
}

export const SUPPORTED_SCRIPTS = Object.keys(JOB_RUNNERS)

// ─── Submit + run ────────────────────────────────────────────────────────────

export interface SubmitInput {
  agentId:    string
  script:     string
  input:      JobInput
  priority?:  number
  businessId?:string
}

export async function submitJob(workspaceId: string, input: SubmitInput): Promise<{ id: string; status: 'queued' }> {
  await ensureTables()
  if (!JOB_RUNNERS[input.script]) throw new Error(`unknown script: ${input.script} (supported: ${SUPPORTED_SCRIPTS.join(', ')})`)
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO autobrowser_jobs (id, workspace_id, business_id, agent_id, script, input, priority, created_at, status)
    VALUES (${id}, ${workspaceId}, ${input.businessId ?? null}, ${input.agentId}, ${input.script},
            ${JSON.stringify(input.input)}::jsonb, ${input.priority ?? 50}, ${Date.now()}, 'queued')
  `).catch(() => {})
  return { id, status: 'queued' }
}

async function runOne(workerId: number, browser: any, jobId: string, script: string, jobInput: JobInput): Promise<{ ok: boolean; result?: unknown; error?: string; durationMs: number }> {
  const t0 = Date.now()
  let page: any = null
  try {
    page = await browser.newPage()
    const result = await Promise.race([
      JOB_RUNNERS[script]!(page, jobInput),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`job ${jobId} timeout ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS)),
    ])
    return { ok: true, result, durationMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 500), durationMs: Date.now() - t0 }
  } finally {
    if (page) { try { await page.close() } catch { /* tolerated */ } }
  }
}

/** Pull one queued job and run it synchronously on a leased worker. Returns the result. */
export async function jobRun(workspaceId: string, input: SubmitInput): Promise<{ id: string; ok: boolean; result?: unknown; error?: string; durationMs: number; workerId: number }> {
  await ensureTables()
  const submitted = await submitJob(workspaceId, input)
  // Lease worker (busy-wait up to 30s).
  const deadline = Date.now() + 30_000
  let worker: Worker | null = null
  while (Date.now() < deadline) {
    worker = workers.find(w => !w.busy) ?? null
    if (worker) break
    await new Promise(r => setTimeout(r, 250))
  }
  if (!worker) throw new Error('autobrowser pool exhausted (no worker free within 30s)')
  worker.busy = true
  await db.execute(sql`UPDATE autobrowser_jobs SET status = 'running', worker_id = ${worker.id}, started_at = ${Date.now()} WHERE id = ${submitted.id}`).catch(() => {})
  try {
    const browser = await ensureWorker(worker)
    const res = await runOne(worker.id, browser, submitted.id, input.script, input.input)
    await db.execute(sql`
      UPDATE autobrowser_jobs SET
        status = ${res.ok ? 'done' : 'failed'},
        result = ${res.result ? JSON.stringify(res.result) : null}::jsonb,
        error  = ${res.error ?? null},
        duration_ms = ${res.durationMs},
        ended_at = ${Date.now()}
      WHERE id = ${submitted.id}
    `).catch(() => {})
    return { id: submitted.id, workerId: worker.id, ...res }
  } finally {
    worker.busy = false
  }
}

/** Background sweep: pick up to POOL_SIZE queued jobs and dispatch to idle workers. */
export async function tickPool(): Promise<{ picked: number; running: number }> {
  await ensureTables()
  const idle = workers.filter(w => !w.busy)
  if (idle.length === 0) return { picked: 0, running: workers.filter(w => w.busy).length }
  const r = await db.execute(sql`
    SELECT id, script, input FROM autobrowser_jobs
    WHERE status = 'queued'
    ORDER BY priority DESC, created_at ASC
    LIMIT ${idle.length}
  `).catch(() => [] as unknown[])
  const jobs = (r as Array<{ id: string; script: string; input: JobInput }>)
  let picked = 0
  for (const j of jobs) {
    const w = workers.find(x => !x.busy)
    if (!w) break
    w.busy = true; picked++
    void (async () => {
      try {
        await db.execute(sql`UPDATE autobrowser_jobs SET status = 'running', worker_id = ${w.id}, started_at = ${Date.now()} WHERE id = ${j.id}`).catch(() => {})
        const browser = await ensureWorker(w)
        const res = await runOne(w.id, browser, j.id, j.script, j.input)
        await db.execute(sql`
          UPDATE autobrowser_jobs SET
            status = ${res.ok ? 'done' : 'failed'},
            result = ${res.result ? JSON.stringify(res.result) : null}::jsonb,
            error  = ${res.error ?? null},
            duration_ms = ${res.durationMs},
            ended_at = ${Date.now()}
          WHERE id = ${j.id}
        `).catch(() => {})
      } catch (e) {
        await db.execute(sql`UPDATE autobrowser_jobs SET status = 'failed', error = ${(e as Error).message.slice(0, 500)}, ended_at = ${Date.now()} WHERE id = ${j.id}`).catch(() => {})
      } finally { w.busy = false }
    })()
  }
  return { picked, running: workers.filter(x => x.busy).length }
}

export async function getJob(workspaceId: string, id: string): Promise<unknown> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM autobrowser_jobs WHERE workspace_id = ${workspaceId} AND id = ${id} LIMIT 1`).catch(() => [] as unknown[])
  return (r as any[])[0] ?? null
}

export async function recentJobs(workspaceId: string, limit = 20): Promise<Array<{ id: string; agent_id: string; script: string; status: string; duration_ms: number | null; created_at: number; worker_id: number | null }>> {
  await ensureTables()
  const r = await db.execute(sql`
    SELECT id, agent_id, script, status, duration_ms, created_at, worker_id
    FROM autobrowser_jobs WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC LIMIT ${Math.min(limit, 100)}
  `).catch(() => [] as unknown[])
  return (r as any[]).map(x => ({ ...x, duration_ms: x.duration_ms == null ? null : Number(x.duration_ms), created_at: Number(x.created_at), worker_id: x.worker_id == null ? null : Number(x.worker_id) }))
}

export async function poolHealth(): Promise<{ poolSize: number; idle: number; busy: number; supportedScripts: string[] }> {
  return {
    poolSize: POOL_SIZE,
    idle:     workers.filter(w => !w.busy).length,
    busy:     workers.filter(w => w.busy).length,
    supportedScripts: SUPPORTED_SCRIPTS,
  }
}

export async function shutdownPool(): Promise<void> {
  for (const w of workers) {
    if (w.browser) { try { await w.browser.close() } catch { /* tolerated */ } }
    if (w.dataDir) { try { await rm(w.dataDir, { recursive: true, force: true }) } catch { /* tolerated */ } }
    w.browser = undefined; w.dataDir = undefined; w.busy = false
  }
}
