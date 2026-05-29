/**
 * Browser worker — executes Playwright automation jobs in isolated sessions.
 *
 * Job types:
 *   run-automation   — execute a sequence of browser actions
 *   verify-page      — navigate + screenshot for visual verification
 *   health-check     — ping a URL and check status
 *   web-capture      — navigate, capture title + screenshot + body text, persist to DB
 */
import { Worker, type Job }   from 'bullmq'
import { pino }               from 'pino'
import { eq }                 from 'drizzle-orm'
import { v7 as uuidv7 }       from 'uuid'
import {
  QUEUE_NAMES,
  createRedisFromEnv,
  attachWorkerLifecycle,
  installProcessSafetyNet,
} from '@ops/runtime-kernel'
import { browserSessions, browserActions, startWorkerHeartbeat }  from '@ops/db'
import { evaluatePolicy, AUTONOMY_LEVELS, extractActionCategory }  from '@ops/policy-engine'
import type { AutonomyLevel }                                      from '@ops/policy-engine'
import {
  createSession,
  closeBrowser,
  executeAction,
  type BrowserAction,
  type SessionOptions,
} from './session.js'
import { emitEvent }        from './events.js'
import { db, queryClient }  from './db.js'

/** Strip the query string (and userinfo if present) from a URL before
 *  logging. OAuth callbacks, signed S3 URLs, and pre-signed download
 *  links all carry secrets there; logging the raw URL exposes them in
 *  every captured-page log line. */
function safeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    const q = raw.indexOf('?')
    return q >= 0 ? raw.slice(0, q) : raw
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'browser-worker', level: process.env['LOG_LEVEL'] ?? 'info' })
const WORKER_ID = uuidv7()

// ─── Job interfaces ───────────────────────────────────────────────────────────

interface RunAutomationJob {
  jobId:        string
  workspaceId:  string
  runId?:       string
  stepId?:      string
  actions:      BrowserAction[]
  sessionOpts?: Partial<SessionOptions>
}

interface VerifyPageJob {
  jobId:       string
  workspaceId: string
  url:         string
  label?:      string
}

interface HealthCheckJob {
  url:         string
  workspaceId: string
  timeoutMs?:  number
}

interface WebCaptureJob {
  jobId:          string
  workspaceId:    string
  traceId:        string
  url:            string
  label?:         string
  autonomyLevel?: string
  agentId?:       string
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleRunAutomation(data: RunAutomationJob): Promise<{
  success:     boolean
  results:     unknown[]
  screenshots: string[]
  error?:      string
}> {
  const { jobId, workspaceId, actions, sessionOpts, runId, stepId } = data
  const session = await createSession({ jobId, workspaceId, ...sessionOpts })

  const results:     unknown[] = []
  const screenshots: string[]  = []

  try {
    await emitEvent('browser.session.started', workspaceId, { jobId, runId, stepId })

    for (const action of actions) {
      const result = await executeAction(session, action)
      results.push(result)
      if (result.screenshotPath) screenshots.push(result.screenshotPath)

      if (!result.success) {
        log.warn({ action: action.type, error: result.error }, 'Action failed')
        await emitEvent('browser.action.failed', workspaceId, {
          jobId, action: action.type, error: result.error,
          screenshotPath: result.screenshotPath,
        })
        const failShot = await session.captureScreenshot('final-failure')
        screenshots.push(failShot)
        return { success: false, results, screenshots, error: result.error ?? 'unknown' }
      }

      log.debug({ action: action.type }, 'Action succeeded')
    }

    await emitEvent('browser.session.completed', workspaceId, {
      jobId, runId, stepId, actionsCompleted: actions.length, screenshots,
    })

    return { success: true, results, screenshots }
  } finally {
    await session.close()
  }
}

async function handleVerifyPage(data: VerifyPageJob): Promise<{
  success:        boolean
  screenshotPath: string
  url:            string
  error?:         string
}> {
  const { jobId, workspaceId, url, label = 'verify' } = data
  const session = await createSession({ jobId, workspaceId })

  try {
    const navResult = await executeAction(session, { type: 'navigate', url, timeout: 15_000 })
    if (!navResult.success) {
      return { success: false, screenshotPath: '', url, error: navResult.error ?? 'Navigation failed' }
    }

    const shotPath = await session.captureScreenshot(label)
    return { success: true, screenshotPath: shotPath, url }
  } finally {
    await session.close()
  }
}

async function handleHealthCheck(data: HealthCheckJob): Promise<{
  ok:         boolean
  statusCode: number
  latencyMs:  number
  error?:     string
}> {
  const { url, timeoutMs = 10_000 } = data
  const start = Date.now()

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return { ok: res.ok, statusCode: res.status, latencyMs: Date.now() - start }
  } catch (err) {
    return { ok: false, statusCode: 0, latencyMs: Date.now() - start, error: (err as Error).message }
  }
}

async function handleWebCapture(data: WebCaptureJob): Promise<{
  success:         boolean
  sessionId:       string
  screenshotPath?: string
  pageTitle?:      string
  pageText?:       string
  error?:          string
}> {
  const {
    jobId, workspaceId, traceId, url,
    autonomyLevel = AUTONOMY_LEVELS.APPROVAL_REQUIRED_EXECUTION,
    agentId,
  } = data

  // ── Policy check ──────────────────────────────────────────────────────────
  const policyCtx = {
    workspaceId,
    action:          'browser.navigate',
    actionCategory:  extractActionCategory('browser.navigate'),
    subject:         url,
    autonomyLevel:   autonomyLevel as AutonomyLevel,
    traceId,
    targetDomain:    new URL(url).hostname,
    ...(agentId !== undefined ? { agentId } : {}),
  }

  const report = evaluatePolicy(policyCtx)

  if (report.verdict === 'deny') {
    const reason = report.decidingPolicy.reason
    log.warn({ url: safeUrl(url), reason }, 'Browser capture denied by policy')
    await emitEvent('browser.action.blocked', workspaceId, { jobId, url, reason }, traceId)
    return { success: false, sessionId: '', error: `Policy denied: ${reason}` }
  }

  if (report.verdict === 'require_approval') {
    log.info({ url: safeUrl(url) }, 'Browser capture requires approval — blocked in worker')
    await emitEvent('browser.action.approval_required', workspaceId, {
      jobId, url, policyId: report.decidingPolicy.policyId,
    }, traceId)
    return { success: false, sessionId: '', error: 'Requires approval' }
  }

  // ── Execute capture ───────────────────────────────────────────────────────
  const sessionId = uuidv7()
  const startedAt = Date.now()
  const createdAt = startedAt

  await db.insert(browserSessions).values({
    id: sessionId, workspaceId, jobId, traceId, url,
    status: 'active', startedAt, createdAt,
  })

  await emitEvent('browser.session.started', workspaceId, { sessionId, jobId, url }, traceId)

  const session = await createSession({ jobId, workspaceId })
  let pageTitle:      string | undefined
  let pageText:       string | undefined
  let screenshotPath: string | undefined
  let errorMessage:   string | undefined

  try {
    // Navigate
    const navStart  = Date.now()
    const navResult = await executeAction(session, { type: 'navigate', url, timeout: 20_000 })
    const navMs     = Date.now() - navStart

    await db.insert(browserActions).values({
      id:          uuidv7(),
      sessionId,
      workspaceId,
      actionType:  'navigate',
      actionInput: { url } as Record<string, unknown>,
      success:     navResult.success,
      durationMs:  navMs,
      executedAt:  Date.now(),
      ...(navResult.output !== undefined
        ? { output: navResult.output as Record<string, unknown> }
        : {}),
      ...(navResult.error !== undefined ? { error: navResult.error } : {}),
    })

    if (!navResult.success) {
      errorMessage = navResult.error ?? 'Navigation failed'
      throw new Error(errorMessage)
    }

    await emitEvent('browser.step.completed', workspaceId, {
      sessionId, action: 'navigate', url, durationMs: navMs,
    }, traceId)

    // Page title
    pageTitle = await session.page.title().catch(() => undefined)

    // Screenshot
    const shotStart = Date.now()
    const shotPath  = await session.captureScreenshot('capture').catch(() => undefined)
    const shotMs    = Date.now() - shotStart
    screenshotPath  = shotPath

    await db.insert(browserActions).values({
      id:          uuidv7(),
      sessionId,
      workspaceId,
      actionType:  'screenshot',
      actionInput: { label: 'capture' } as Record<string, unknown>,
      success:     screenshotPath !== undefined,
      durationMs:  shotMs,
      executedAt:  Date.now(),
      ...(screenshotPath !== undefined ? { screenshotPath } : {}),
    })

    // Extract body text
    const extractStart = Date.now()
    const rawText = await session.page
      .evaluate(() => (document.body as HTMLElement).innerText)
      .catch(() => undefined)
    const extractMs = Date.now() - extractStart
    pageText = rawText !== undefined ? rawText.slice(0, 10_000) : undefined

    await db.insert(browserActions).values({
      id:          uuidv7(),
      sessionId,
      workspaceId,
      actionType:  'extract',
      actionInput: { selector: 'body' } as Record<string, unknown>,
      success:     rawText !== undefined,
      durationMs:  extractMs,
      executedAt:  Date.now(),
      ...(rawText !== undefined
        ? { output: { text: rawText.slice(0, 500) } as Record<string, unknown> }
        : {}),
    })

    const completedAt = Date.now()
    const durationMs  = completedAt - startedAt

    await db.update(browserSessions)
      .set({
        status: 'completed',
        completedAt,
        durationMs,
        ...(pageTitle      !== undefined ? { pageTitle }      : {}),
        ...(pageText       !== undefined ? { pageText }       : {}),
        ...(screenshotPath !== undefined ? { screenshotPath } : {}),
      })
      .where(eq(browserSessions.id, sessionId))

    await emitEvent('browser.session.ended', workspaceId, {
      sessionId, jobId, url, status: 'completed', durationMs,
      ...(pageTitle      !== undefined ? { pageTitle }      : {}),
      ...(screenshotPath !== undefined ? { screenshotPath } : {}),
    }, traceId)

    return {
      success: true,
      sessionId,
      ...(screenshotPath !== undefined ? { screenshotPath } : {}),
      ...(pageTitle      !== undefined ? { pageTitle }      : {}),
      ...(pageText       !== undefined ? { pageText }       : {}),
    }

  } catch (err) {
    errorMessage = (err as Error).message
    log.error({ sessionId, url: safeUrl(url), err: errorMessage }, 'Web capture failed')

    const completedAt = Date.now()
    const durationMs  = completedAt - startedAt

    await db.update(browserSessions)
      .set({
        status: 'failed',
        completedAt,
        durationMs,
        errorMessage,
        ...(screenshotPath !== undefined ? { screenshotPath } : {}),
      })
      .where(eq(browserSessions.id, sessionId))
      .catch(() => undefined)

    await emitEvent('browser.step.failed', workspaceId, {
      sessionId, jobId, url, error: errorMessage,
    }, traceId).catch(() => undefined)

    await emitEvent('browser.session.ended', workspaceId, {
      sessionId, jobId, url, status: 'failed', error: errorMessage,
    }, traceId).catch(() => undefined)

    return { success: false, sessionId, error: errorMessage }
  } finally {
    await session.close().catch(() => undefined)
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const redisConnection = createRedisFromEnv()

startWorkerHeartbeat({ db, name: 'browser-worker', capabilities: ['playwright', 'browser-session', 'screenshot'] })

const worker = new Worker(
  QUEUE_NAMES.BROWSER,
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing browser job')

    switch (job.name) {
      case 'run-automation':
        return handleRunAutomation(job.data as RunAutomationJob)
      case 'verify-page':
        return handleVerifyPage(job.data as VerifyPageJob)
      case 'health-check':
        return handleHealthCheck(job.data as HealthCheckJob)
      case 'web-capture':
        return handleWebCapture(job.data as WebCaptureJob)
      default:
        log.warn({ jobName: job.name }, 'Unknown job type')
        return { skipped: true }
    }
  },
  {
    connection:  redisConnection,
    concurrency: 3,
  },
)

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const cleanupLifecycle = attachWorkerLifecycle(worker, {
  workerName: 'browser-worker',
  queueName:  QUEUE_NAMES.BROWSER,
  workerId:   WORKER_ID,
  log,
  emitEvent,
})

async function shutdown(): Promise<void> {
  log.info('Shutting down browser worker')
  await cleanupLifecycle()
  await worker.close()
  await closeBrowser()
  await queryClient.end()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT',  () => { void shutdown() })
installProcessSafetyNet({ workerName: 'browser-worker', log })

log.info('Browser worker started')
