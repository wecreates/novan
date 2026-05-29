#!/usr/bin/env node
/**
 * Novan Windows Bridge — connects an always-on Windows PC to the cloud
 * API so GUI-driven ops (CapCut, Mixcraft, ACE-Step) run locally while
 * the rest of the platform stays in the cloud 24/7.
 *
 *   NOVAN_API_URL=https://api.your-host.com    (required)
 *   NOVAN_API_TOKEN=...                        (required — workspace API token)
 *   NOVAN_WORKSPACE_ID=default
 *   NOVAN_BRIDGE_ID=my-bridge                  (defaults to hostname)
 *
 * Run as a Windows service (recommended):
 *   nssm install NovanBridge "C:\Program Files\nodejs\node.exe" "C:\path\to\bridge.mjs"
 *   nssm set NovanBridge AppEnvironmentExtra NOVAN_API_URL=https://api.novan.com ...
 *   nssm start NovanBridge
 *
 * What it does:
 *   1. Polls bridge.claim every 4s for ops matching the families it can
 *      handle (capcut.* / mixcraft.* / music.*).
 *   2. Dispatches each claimed job to the matching local handler.
 *   3. Posts result via bridge.complete.
 *   4. Logs everything to stdout (+ rotates) so nssm can read.
 *
 * For ACE-Step the bridge auto-starts the ACE-Step API server on
 * localhost:8001 if it's down (same logic as music-studio.ts:autoStartServer).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

const API_URL      = process.env.NOVAN_API_URL ?? 'http://127.0.0.1:3001'
const API_TOKEN    = process.env.NOVAN_API_TOKEN ?? ''
const WORKSPACE_ID = process.env.NOVAN_WORKSPACE_ID ?? 'default'
const BRIDGE_ID    = process.env.NOVAN_BRIDGE_ID ?? `bridge-${hostname()}`
const POLL_MS      = Number(process.env.NOVAN_POLL_MS ?? 4000)

const OP_FAMILIES = ['capcut.', 'mixcraft.', 'music.']

if (!API_TOKEN) {
  console.error('NOVAN_API_TOKEN required'); process.exit(2)
}

function log(msg, ...rest) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [${BRIDGE_ID}] ${msg}`, ...rest)
}

async function callApi(op, params) {
  const r = await fetch(`${API_URL}/api/v1/brain/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify({ workspaceId: WORKSPACE_ID, plan: [{ op, params }] }),
  })
  if (!r.ok) throw new Error(`${op} ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  return j.results?.[0]?.data ?? null
}

async function claimNext(opPrefix) {
  return callApi('bridge.claim', { bridgeId: BRIDGE_ID, opPrefix })
}

async function postComplete(jobId, ok, result, error) {
  return callApi('bridge.complete', { jobId, ok, result, error })
}

/**
 * Local dispatch — import the same controllers the API uses. The bridge
 * runs against the same monorepo source via a sibling install.
 */
async function execute(op, params) {
  // capcut.* — the bridge has the source mounted at NOVAN_REPO_PATH
  const repo = process.env.NOVAN_REPO_PATH ?? 'C:\\Users\\19496\\ops-platform'
  if (!existsSync(join(repo, 'apps', 'api', 'src', 'services'))) {
    throw new Error(`NOVAN_REPO_PATH not found: ${repo}`)
  }
  const baseUrl = `file://${repo.replace(/\\/g, '/')}/apps/api/dist/services`

  if (op.startsWith('capcut.')) {
    const mod = await import(`${baseUrl}/capcut-controller.js`)
    if (op === 'capcut.assemble') {
      // Bypass the queue routing inside assemble() by directly calling
      // the internal — but the public assemble() now early-returns to the
      // queue when NOVAN_GUI_REMOTE=1. The bridge runs without that flag,
      // so calling assemble() executes locally.
      return mod.assemble(params)
    }
    if (op === 'capcut.export') return mod.exportProject(params.outPath, params.opts ?? {})
    if (op === 'capcut.import') return mod.importMedia(params.path)
    throw new Error(`unsupported op: ${op}`)
  }
  if (op.startsWith('mixcraft.')) {
    const mod = await import(`${baseUrl}/mixcraft-controller.js`)
    if (op === 'mixcraft.compose')        return mod.compose(params)
    if (op === 'mixcraft.exportMixdown')  return mod.exportMixdown(params.outPath, params.format ?? 'wav')
    throw new Error(`unsupported op: ${op}`)
  }
  if (op.startsWith('music.')) {
    // Ensure ACE-Step server is up
    const mod = await import(`${baseUrl}/music-studio.js`)
    const up = await mod.isAceServerUp()
    if (!up) await mod.autoStartServer()
    if (op === 'music.generate')   return mod.generateMusic(params)
    if (op === 'music.replicate')  return mod.replicateSong(params)
    throw new Error(`unsupported op: ${op}`)
  }
  throw new Error(`unknown op family: ${op}`)
}

async function pollLoop() {
  log(`started; polling ${API_URL} every ${POLL_MS}ms for ${OP_FAMILIES.join(', ')}`)
  let consecutiveErrors = 0
  let lastHeartbeat = 0
  while (true) {
    // Heartbeat every 20s so bridge.status shows us alive even when idle
    if (Date.now() - lastHeartbeat > 20_000) {
      try { await callApi('bridge.heartbeat', { bridgeId: BRIDGE_ID }); lastHeartbeat = Date.now() }
      catch { /* heartbeat failure is non-fatal */ }
    }
    let didWork = false
    for (const prefix of OP_FAMILIES) {
      try {
        const job = await claimNext(prefix)
        if (job && job.id) {
          log(`claimed job ${job.id} → ${job.op}`)
          didWork = true
          try {
            const result = await execute(job.op, job.params)
            await postComplete(job.id, true, result)
            log(`completed ${job.id}`)
          } catch (e) {
            const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1500)
            log(`failed ${job.id}: ${msg}`)
            await postComplete(job.id, false, undefined, msg)
          }
          consecutiveErrors = 0
        }
      } catch (e) {
        consecutiveErrors++
        const msg = e instanceof Error ? e.message : String(e)
        log(`poll error (${consecutiveErrors}x): ${msg}`)
        if (consecutiveErrors > 10) {
          log('too many consecutive errors — backing off 60s')
          await new Promise(r => setTimeout(r, 60_000))
          consecutiveErrors = 0
        }
      }
    }
    if (!didWork) await new Promise(r => setTimeout(r, POLL_MS))
  }
}

process.on('SIGINT',  () => { log('shutting down (SIGINT)');  process.exit(0) })
process.on('SIGTERM', () => { log('shutting down (SIGTERM)'); process.exit(0) })

pollLoop().catch(e => { log('fatal:', e); process.exit(1) })

// suppress unused-import warning
void tmpdir; void spawn
