/**
 * brain-task.ts — Natural-language task executor.
 *
 * Operator says "do X". The brain plans a structured sequence of
 * whitelisted operations, executes them via existing services,
 * and returns evidence. Every execution emits events for audit.
 *
 * Architecture:
 *   text → planner (LLM, optional) → ordered list of Operations
 *   Operations → dispatcher → existing services → results
 *
 * Safety:
 *   - Operations are a CLOSED set. The LLM can't invent new ones.
 *   - Each operation declares its risk level. High-risk ops require
 *     an explicit `approvalToken`.
 *   - All writes go through existing governance / safety gates.
 *   - SELECT-only DB access (no INSERT/UPDATE/DELETE from raw SQL).
 */
import { db } from '../db/client.js'
import { events, codeProposals, issues } from '../db/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { guardOperation } from './brain-task-money-guard.js'
import { recordAgentActivityAsync } from './agent-state-sync.js'
import {
  browserOpen, browserClick, browserFill, browserText, browserScreenshot,
  browserEvaluate, browserWaitFor, browserNavigate, browserList, browserClose,
} from './brain-task-browser.js'
import {
  desktopExec, desktopReadFile, desktopWriteFile, desktopListDir,
  desktopOpenApp, desktopScreenshot, desktopProcesses, desktopKill,
} from './brain-task-desktop.js'

// ─── Operation registry ────────────────────────────────────────────────

export type OpRisk = 'low' | 'medium' | 'high' | 'critical'

interface OpSpec {
  description: string
  risk:        OpRisk
  // Operation handler — typed loosely because params vary.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (workspaceId: string, params: Record<string, unknown>) => Promise<any>
}

// Read-only SELECT against a small whitelist of tables.
// SECURITY: each entry is a closure that uses drizzle's tagged template
// (sql`...${value}...`) so workspace_id, since, and limit are parameter-
// bound by the driver, not string-interpolated. Previously this code
// used sql.raw(stmt.replace('$1', `'${ws}'`)) which was a SQL injection
// vector — anyone passing workspaceId="x' OR 1=1--" could read any row.
async function safeQuery(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const table = String(params['table'] ?? '')
  const rawLimit = Number(params['limit'] ?? 50)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50
  const rawMinutes = Number(params['minutes'] ?? 60)
  const minutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? Math.min(rawMinutes, 7 * 24 * 60) : 60
  const since = Date.now() - minutes * 60_000
  // Defense-in-depth: validate workspaceId shape even though it's bound.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(_ws)) {
    throw new Error('db.query: invalid workspace_id format')
  }
  const WL: Record<string, () => Promise<unknown>> = {
    events:                 () => db.execute(sql`SELECT type, source, payload, created_at FROM events WHERE workspace_id = ${_ws} AND created_at > ${since} ORDER BY created_at DESC LIMIT ${limit}`),
    incidents:              () => db.execute(sql`SELECT id, title, severity, summary, root_cause_hypothesis, detected_at FROM incidents WHERE workspace_id = ${_ws} AND detected_at > ${since} ORDER BY detected_at DESC LIMIT ${limit}`),
    issues:                 () => db.execute(sql`SELECT id, status, symptom, root_cause, severity, created_at FROM issues WHERE workspace_id = ${_ws} AND created_at > ${since} ORDER BY created_at DESC LIMIT ${limit}`),
    code_proposals:         () => db.execute(sql`SELECT id, title, status, risk_level, created_at FROM code_proposals WHERE workspace_id = ${_ws} AND created_at > ${since} ORDER BY created_at DESC LIMIT ${limit}`),
    reasoning_chains:       () => db.execute(sql`SELECT id, kind, source, decision, confidence, created_at FROM reasoning_chains WHERE workspace_id = ${_ws} AND created_at > ${since} ORDER BY created_at DESC LIMIT ${limit}`),
    patch_records:          () => db.execute(sql`SELECT id, file_path, lines_added, lines_removed, status, created_at FROM patch_records WHERE workspace_id = ${_ws} AND created_at > ${since} ORDER BY created_at DESC LIMIT ${limit}`),
    optimization_recommendations: () => db.execute(sql`SELECT id, subject, category, impact_score, risk_score, status FROM optimization_recommendations WHERE workspace_id = ${_ws} ORDER BY impact_score DESC LIMIT ${limit}`),
    roadmap_tasks:          () => db.execute(sql`SELECT id, title, phase, category, status, priority_score FROM roadmap_tasks WHERE workspace_id = ${_ws} ORDER BY priority_score DESC LIMIT ${limit}`),
    businesses:             () => db.execute(sql`SELECT id, name, stage, health, domain, industry, created_at FROM businesses WHERE workspace_id = ${_ws} ORDER BY created_at DESC LIMIT ${limit}`),
    agent_delegations:      () => db.execute(sql`SELECT id, department, task, status, requested_by, tokens, cost_usd, created_at FROM agent_delegations WHERE workspace_id = ${_ws} AND created_at > ${since} ORDER BY created_at DESC LIMIT ${limit}`),
    agent_definitions:      () => db.execute(sql`SELECT id, slug, department, name, description FROM agent_definitions WHERE workspace_id = ${_ws} ORDER BY department, name LIMIT ${limit}`),
    memories:               () => db.execute(sql`SELECT id, type, summary, confidence, tags, updated_at FROM memories WHERE workspace_id = ${_ws} ORDER BY confidence DESC, updated_at DESC LIMIT ${limit}`),
    external_feeds:         () => db.execute(sql`SELECT name, feed_url, enabled, poll_count, items_ingested, error_count FROM external_feeds WHERE workspace_id = ${_ws} ORDER BY items_ingested DESC LIMIT ${limit}`),
    agents:                 () => db.execute(sql`SELECT type, status, capabilities, last_active_at, heartbeat_at FROM agents WHERE workspace_id = ${_ws} ORDER BY last_active_at DESC NULLS LAST LIMIT ${limit}`),
    research_topics:        () => db.execute(sql`SELECT id, topic, status, last_run_at, total_findings FROM research_topics WHERE workspace_id = ${_ws} ORDER BY last_run_at DESC NULLS LAST LIMIT ${limit}`),
  }
  const exec = WL[table]
  if (!exec) throw new Error(`db.query: table '${table}' not whitelisted`)
  const result = await exec()
  return { table, rowCount: (result as Array<unknown>).length, rows: result }
}

const OPERATIONS: Record<string, OpSpec> = {
  // ─── Diagnostic / read ─────────────────────────────────────────
  'db.query': {
    description: 'SELECT from a whitelisted table. Params: table, limit?, minutes?',
    risk: 'low',
    handler: safeQuery,
  },
  'platform.smoke': {
    description: 'Hit every public GET route the UI uses; return pass/fail.',
    risk: 'low',
    handler: async (ws) => {
      const { runPlatformSmoke } = await import('./platform-smoke.js')
      return runPlatformSmoke(ws)
    },
  },
  'providers.validate': {
    description: 'Probe every configured provider for liveness + auth.',
    risk: 'low',
    handler: async (ws) => {
      const { validateProviders } = await import('./provider-validation.js')
      return validateProviders(ws)
    },
  },
  'mind.cycle': {
    description: 'Force a capability-gap detection + planning cycle.',
    risk: 'low',
    handler: async (ws) => {
      const { runMindCycle } = await import('./autonomous-mind.js')
      return runMindCycle(ws)
    },
  },

  // ─── Issue lifecycle ───────────────────────────────────────────
  'issue.ingest': {
    description: 'Convert recent cron-errors + incidents into issues.',
    risk: 'low',
    handler: async (ws) => {
      const { autoIngestSignals } = await import('./issues.js')
      return autoIngestSignals(ws)
    },
  },
  'issue.auto_loop': {
    description: 'Run the full auto-loop: diagnose → propose → approve → build → apply → reconcile.',
    // High risk because the loop may auto-apply code patches. Approval
    // gate at executePlan ensures the operator opted in via approval_token.
    // The selfEditLoops kill-switch is checked inside the handler so a
    // direct brain.task call cannot bypass it the way the prior medium
    // classification allowed.
    risk: 'high',
    handler: async (ws) => {
      const { isAllowed } = await import('./safety-mode.js')
      if (!(await isAllowed(ws, 'self_edit_loop'))) {
        throw new Error('issue.auto_loop: self_edit_loop is disabled for this workspace (Tomorrow Mode off)')
      }
      const { runAutoLoopFor } = await import('./issue-auto-loop.js')
      return runAutoLoopFor(ws)
    },
  },
  'issue.create': {
    description: 'Create an issue. Params: symptom (required), severity?, affectedSystems?, rootCause?, proposedFix?',
    risk: 'low',
    handler: async (ws, p) => {
      const { createOrAppendIssue } = await import('./issues.js')
      const symptom = String(p['symptom'] ?? '').trim()
      if (!symptom) throw new Error('issue.create: symptom required')
      return createOrAppendIssue({
        workspaceId: ws,
        source:    'operator',
        symptom,
        severity:  (p['severity'] as 'info' | 'warning' | 'critical' | 'emergency') ?? 'warning',
        affectedSystems: (p['affectedSystems'] as string[]) ?? [],
        ...(p['rootCause']     ? { rootCause:     String(p['rootCause'])     } : {}),
        ...(p['proposedFix']   ? { proposedFix:   String(p['proposedFix'])   } : {}),
        ...(p['riskLevel']     ? { riskLevel:     String(p['riskLevel']) as 'low' | 'medium' | 'high' | 'critical' } : {}),
        fingerprint: `brain-task:${Date.now()}:${symptom.slice(0, 40)}`,
        evidence: [],
      })
    },
  },

  // ─── Code / proposal lifecycle ─────────────────────────────────
  'proposal.approve': {
    description: 'Approve a code proposal by id. Param: proposalId',
    // High risk because approval gates downstream auto-apply behavior —
    // an approved proposal can be picked up by the build/apply pipeline.
    // Was 'medium' which let it slip past the high-risk approval-token
    // gate; tightening forces explicit OPERATOR_APPROVED on every approval.
    risk: 'high',
    handler: async (ws, p) => {
      const { setProposalStatus } = await import('./code-writer.js')
      const id = String(p['proposalId'] ?? '')
      if (!id) throw new Error('proposal.approve: proposalId required')
      await setProposalStatus(ws, id, 'approved')
      return { proposalId: id, status: 'approved' }
    },
  },
  'proposal.reject': {
    description: 'Reject a code proposal by id. Params: proposalId, reason',
    risk: 'low',
    handler: async (ws, p) => {
      const { setProposalStatus } = await import('./code-writer.js')
      const id = String(p['proposalId'] ?? '')
      if (!id) throw new Error('proposal.reject: proposalId required')
      await setProposalStatus(ws, id, 'rejected')
      return { proposalId: id, status: 'rejected' }
    },
  },
  'proposal.build': {
    description: 'Run code-agent on a proposal to generate the patch. Param: proposalId',
    risk: 'medium',
    handler: async (ws, p) => {
      const { buildPatchFromProposal } = await import('./code-agent.js')
      const id = String(p['proposalId'] ?? '')
      if (!id) throw new Error('proposal.build: proposalId required')
      return buildPatchFromProposal(ws, id)
    },
  },

  // ─── Code search ───────────────────────────────────────────────
  'code.search': {
    description: 'Grep the codebase. Params: pattern (required), maxFiles?',
    risk: 'low',
    handler: async (_ws, p) => {
      const pattern = String(p['pattern'] ?? '').trim()
      if (!pattern) throw new Error('code.search: pattern required')
      const maxFiles = Math.min(Number(p['maxFiles'] ?? 25), 100)
      // Native Node grep — portable, no PATH dependency. Walk a fixed
      // set of source roots, read each text file under 1 MB, match.
      const { readdir, readFile, stat } = await import('node:fs/promises')
      const { join, relative, resolve, dirname } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      // cwd is apps/api when running via tsx — walk up to find the repo
      // root (pnpm-workspace.yaml lives there).
      const here = dirname(fileURLToPath(import.meta.url))
      let root = resolve(here, '..', '..', '..', '..')   // services -> src -> api -> apps -> root
      try { await stat(join(root, 'pnpm-workspace.yaml')) } catch { root = process.cwd() }
      const roots = ['apps', 'packages', 'workers']
      const allowedExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.sql', '.md', '.yaml', '.yml', '.toml', '.css'])
      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.launch-logs', '.openclaw', 'coverage'])
      // R146.57 — ReDoS guard. pattern comes from operator/LLM input.
      // Without this, a value like `(a+)+$` against a 1MB file (re.test
      // below, line ~245) triggers catastrophic backtracking and pins
      // the API event loop until the OOM killer or watchdog notices.
      if (pattern.length > 500) {
        throw new Error(`code.search: pattern too long (max 500 chars)`)
      }
      // Reject nested quantifiers — the canonical ReDoS shape.
      // Matches: (X+)+, (X*)+, (X+)*, (X*)*, (X{1,})+ etc. Conservative —
      // some legit patterns will be rejected too; operators can escape
      // the inner paren if they really need it.
      if (/\([^)]*[*+?][^)]*\)\s*[*+?{]/.test(pattern)) {
        throw new Error(`code.search: pattern has nested quantifier (ReDoS risk); flatten it`)
      }
      const re = (() => {
        try { return new RegExp(pattern, 'i') } catch { return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      })()
      const matched: string[] = []
      async function walk(dir: string): Promise<void> {
        if (matched.length >= maxFiles) return
        let entries: import('node:fs').Dirent[]
        try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (matched.length >= maxFiles) return
          if (skipDirs.has(e.name)) continue
          const full = join(dir, e.name)
          if (e.isDirectory()) { await walk(full); continue }
          if (!e.isFile()) continue
          const dot = e.name.lastIndexOf('.')
          if (dot < 0 || !allowedExt.has(e.name.slice(dot).toLowerCase())) continue
          try {
            const s = await stat(full)
            if (s.size > 1_000_000) continue
            const txt = await readFile(full, 'utf8')
            if (re.test(txt)) matched.push(relative(root, full).replace(/\\/g, '/'))
          } catch { /* skip */ }
        }
      }
      for (const r of roots) await walk(join(root, r))
      return { pattern, matchedFiles: matched.slice(0, maxFiles), tool: 'native' }
    },
  },

  // ─── Web fetch ─────────────────────────────────────────────────
  'web.fetch': {
    description: 'Render-fetch a URL via playwright. Param: url',
    risk: 'low',
    handler: async (_ws, p) => {
      const { renderFetch } = await import('./playwright-fetcher.js')
      const url = String(p['url'] ?? '').trim()
      if (!url) throw new Error('web.fetch: url required')
      const r = await renderFetch(url)
      if (!r.ok) return r
      return { ...r, text: r.text.slice(0, 4000), html: undefined }
    },
  },
  'video.analyze': {
    description: 'Analyze a video URL — YouTube/Vimeo/direct mp4. Returns metadata + transcript + LLM summary + key moments. Params: url, context?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { analyzeVideo } = await import('./video-analyzer.js')
      const url = String(p['url'] ?? '').trim()
      if (!url) throw new Error('video.analyze: url required')
      const context = String(p['context'] ?? '')
      return analyzeVideo(url, context, workspaceId)
    },
  },

  // ─── Music studio (ACE-Step v1.5) ──────────────────────────────
  'music.generate': {
    description: 'Generate a song from prompt + optional lyrics via ACE-Step master preset (beats Suno/Udio quality — 120 inference steps, ADG, SDE diffusion, 32-bit wav). Params: prompt, lyrics?, duration?, bpm?, key?, language?, quality? (master|studio|draft, default master), seed?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { generateMusic } = await import('./music-studio.js')
      const prompt = String(p['prompt'] ?? '').trim()
      if (!prompt && !p['lyrics']) throw new Error('music.generate: prompt or lyrics required')
      const input: import('./music-studio.js').GenerateMusicInput = { prompt, workspaceId }
      if (p['lyrics'])       input.lyrics       = String(p['lyrics'])
      if (p['duration'])     input.duration     = Number(p['duration'])
      if (p['bpm'])          input.bpm          = Number(p['bpm'])
      if (p['key'])          input.key          = String(p['key'])
      if (p['language'])     input.language     = String(p['language'])
      if (p['quality'])      input.quality      = p['quality'] as 'master' | 'studio' | 'draft'
      if (p['seed'] !== undefined) input.seed   = Number(p['seed'])
      return generateMusic(input)
    },
  },
  'music.replicate': {
    description: 'Replicate any song by URL (Spotify/Apple Music/YouTube Music/SoundCloud/Bandcamp/Tidal/direct mp3). Downloads source, analyzes, regenerates a near-identical but legally distinct version. Params: url, instructions?, variationStrength? (0..1, default 0.4)',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { replicateSong } = await import('./music-studio.js')
      const url = String(p['url'] ?? '').trim()
      if (!url) throw new Error('music.replicate: url required')
      const input: import('./music-studio.js').ReplicateInput = { url, workspaceId }
      if (p['instructions'])        input.instructions       = String(p['instructions'])
      if (p['variationStrength'] !== undefined) input.variationStrength = Number(p['variationStrength'])
      return replicateSong(input)
    },
  },
  'music.status': {
    description: 'Check ACE-Step server health. Auto-starts if down. Returns {up, started}.',
    risk: 'low',
    handler: async () => {
      const { isAceServerUp, autoStartServer } = await import('./music-studio.js')
      const up = await isAceServerUp()
      if (up) return { up: true, started: false }
      const started = await autoStartServer()
      return { up: started, started }
    },
  },
  'music.knowledge': {
    description: 'Recall the brain\'s studied music-production knowledge for a query (mixing, mastering, vocal techniques, genre playbooks, anti-robotic vocals, etc). Returns ranked findings from research + memories. Params: query, limit? (default 8)',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { recallMusicKnowledge } = await import('./music-knowledge.js')
      const query = String(p['query'] ?? '').trim()
      if (!query) throw new Error('music.knowledge: query required')
      const limit = Math.max(1, Math.min(30, Number(p['limit'] ?? 8)))
      const items = await recallMusicKnowledge(workspaceId, query, limit)
      return { count: items.length, items }
    },
  },
  'music.master': {
    description: 'Master an audio file to broadcast spec: two-pass EBU R128 loudness normalization (-14 LUFS), true-peak limit -1 dBTP, 48 kHz / 24-bit, gentle HP/LP. Params: inPath, outPath, targetLufs?, truePeakDb?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { master } = await import('./music-mastering.js')
      const inPath  = String(p['inPath']  ?? '').trim()
      const outPath = String(p['outPath'] ?? '').trim()
      if (!inPath || !outPath) throw new Error('music.master: inPath + outPath required')
      const opts: import('./music-mastering.js').MasterOptions = {}
      if (p['targetLufs'] !== undefined) opts.targetLufs = Number(p['targetLufs'])
      if (p['truePeakDb'] !== undefined) opts.truePeakDb = Number(p['truePeakDb'])
      return master(inPath, outPath, opts)
    },
  },
  'music.vocalEnhance': {
    description: 'Per-vocal-stem enhancement: HP at 80Hz, de-ess notch at 6.5kHz, presence boost, gentle compand. Use before the master chain. Params: inPath, outPath',
    risk: 'low',
    handler: async (_ws, p) => {
      const { vocalEnhance } = await import('./music-mastering.js')
      const inPath = String(p['inPath'] ?? '').trim()
      const outPath = String(p['outPath'] ?? '').trim()
      if (!inPath || !outPath) throw new Error('music.vocalEnhance: inPath + outPath required')
      return vocalEnhance(inPath, outPath)
    },
  },
  'music.scoreNaturalness': {
    description: 'Score vocal naturalness (0-30) by LRA/headroom/dynamic-spread heuristics. Used by multi-take selection. Params: audioPath',
    risk: 'low',
    handler: async (_ws, p) => {
      const { scoreNaturalness } = await import('./music-mastering.js')
      const audioPath = String(p['audioPath'] ?? '').trim()
      if (!audioPath) throw new Error('music.scoreNaturalness: audioPath required')
      const score = await scoreNaturalness(audioPath)
      return { audioPath, score }
    },
  },
  'system.ffmpegAvailable': {
    description: 'Check if ffmpeg is available on the host (gates color/audio/master/repurpose ops).',
    risk: 'low',
    handler: async () => {
      const { isFfmpegAvailable } = await import('./music-mastering.js')
      const available = await isFfmpegAvailable()
      return { available }
    },
  },

  // ─── Multimodal: image/video/audio → song ──────────────────────
  'music.fromImage': {
    description: 'Generate a song matching the mood/style of an image. Vision LLM extracts genre, tempo, instrumentation, vocal type, then renders master-tier. Params: path? or url?, instructions?, duration?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { fromImage } = await import('./music-multimodal.js')
      const input: import('./music-multimodal.js').FromImageInput = { workspaceId }
      if (p['path']) input.path = String(p['path'])
      if (p['url'])  input.url  = String(p['url'])
      if (!input.path && !input.url) throw new Error('music.fromImage: path or url required')
      if (p['instructions']) input.instructions = String(p['instructions'])
      if (p['duration'])     input.duration     = Number(p['duration'])
      return fromImage(input)
    },
  },
  'music.fromVideo': {
    description: 'Generate a song matching the mood/visuals of a video. Reuses video-analyzer for frames + transcript + on-screen text. Params: url, instructions?, matchDuration?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { fromVideo } = await import('./music-multimodal.js')
      const url = String(p['url'] ?? '').trim()
      if (!url) throw new Error('music.fromVideo: url required')
      const input: import('./music-multimodal.js').FromVideoInput = { url, workspaceId }
      if (p['instructions'])  input.instructions  = String(p['instructions'])
      if (p['matchDuration']) input.matchDuration = Boolean(p['matchDuration'])
      return fromVideo(input)
    },
  },
  'music.fromAudio': {
    description: 'Generate a song inspired by a sound clip. Whisper transcribes any lyrics, ACE-Step extracts bpm/key, then renders cover/continuation/remix. Params: path? or url?, instructions?, mode? (cover|continue|remix)',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { fromAudio } = await import('./music-multimodal.js')
      const input: import('./music-multimodal.js').FromAudioInput = { workspaceId }
      if (p['path']) input.path = String(p['path'])
      if (p['url'])  input.url  = String(p['url'])
      if (!input.path && !input.url) throw new Error('music.fromAudio: path or url required')
      if (p['instructions']) input.instructions = String(p['instructions'])
      if (p['mode'])         input.mode = p['mode'] as 'cover' | 'continue' | 'remix'
      return fromAudio(input)
    },
  },

  // ─── Mixcraft desktop controller ───────────────────────────────
  'mixcraft.status': {
    description: 'Check Mixcraft install + running state. Returns {installed, running, exePath?}.',
    risk: 'low',
    handler: async () => (await import('./mixcraft-controller.js')).status(),
  },
  'mixcraft.open': {
    description: 'Launch Mixcraft (optionally with a project file). Params: projectPath?',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { openMixcraft } = await import('./mixcraft-controller.js')
      return openMixcraft(p['projectPath'] ? String(p['projectPath']) : undefined)
    },
  },
  'mixcraft.new': {
    description: 'New project in Mixcraft (Ctrl+N).',
    risk: 'medium',
    handler: async () => (await import('./mixcraft-controller.js')).newProject(),
  },
  'mixcraft.importStem': {
    description: 'Import an audio file into Mixcraft as a new track. Params: path, trackName?',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { importStem } = await import('./mixcraft-controller.js')
      const path = String(p['path'] ?? '').trim()
      if (!path) throw new Error('mixcraft.importStem: path required')
      const opts: { trackName?: string } = {}
      if (p['trackName']) opts.trackName = String(p['trackName'])
      return importStem(path, opts)
    },
  },
  'mixcraft.play':    { description: 'Press play in Mixcraft.',  risk: 'medium', handler: async () => (await import('./mixcraft-controller.js')).play() },
  'mixcraft.pause':   { description: 'Pause Mixcraft transport.', risk: 'medium', handler: async () => (await import('./mixcraft-controller.js')).pause() },
  'mixcraft.stop':    { description: 'Stop Mixcraft transport.',  risk: 'medium', handler: async () => (await import('./mixcraft-controller.js')).stop() },
  'mixcraft.saveProject': {
    description: 'Save Mixcraft project to path. Params: path',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { saveProject } = await import('./mixcraft-controller.js')
      const path = String(p['path'] ?? '').trim()
      if (!path) throw new Error('mixcraft.saveProject: path required')
      return saveProject(path)
    },
  },
  'mixcraft.exportMaster': {
    description: 'Export final mixdown from Mixcraft to a file. Params: outPath, format? (wav|mp3|flac)',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { exportMixdown } = await import('./mixcraft-controller.js')
      const outPath = String(p['outPath'] ?? '').trim()
      if (!outPath) throw new Error('mixcraft.exportMaster: outPath required')
      const fmt = (String(p['format'] ?? 'wav') as 'wav' | 'mp3' | 'flac')
      return exportMixdown(outPath, fmt)
    },
  },
  // ─── CapCut desktop controller + video studio ──────────────────
  'capcut.status': {
    description: 'Check CapCut install + running state.',
    risk: 'low',
    handler: async () => (await import('./capcut-controller.js')).status(),
  },
  'capcut.open': {
    description: 'Launch CapCut Desktop. Returns {ok, pid}.',
    risk: 'medium',
    handler: async () => (await import('./capcut-controller.js')).openCapCut(),
  },
  'capcut.new':       { description: 'New CapCut project (Ctrl+N).', risk: 'medium', handler: async () => (await import('./capcut-controller.js')).newProject() },
  'capcut.import':    { description: 'Import media into current project. Params: path', risk: 'medium', handler: async (_w, p) => (await import('./capcut-controller.js')).importMedia(String(p['path'] ?? '')) },
  'capcut.split':     { description: 'Split clip at playhead (Ctrl+B).', risk: 'medium', handler: async () => (await import('./capcut-controller.js')).splitAtPlayhead() },
  'capcut.save':      { description: 'Save draft (Ctrl+S).',           risk: 'medium', handler: async () => (await import('./capcut-controller.js')).save() },
  'capcut.export':    {
    description: 'Export project to file. Params: outPath, quality? (high|4k|1080p|720p)',
    risk: 'medium',
    handler: async (_w, p) => {
      const { exportProject } = await import('./capcut-controller.js')
      const outPath = String(p['outPath'] ?? '').trim()
      if (!outPath) throw new Error('capcut.export: outPath required')
      const opts: { quality?: 'high' | '4k' | '1080p' | '720p' } = {}
      if (p['quality']) opts.quality = p['quality'] as 'high' | '4k' | '1080p' | '720p'
      return exportProject(outPath, opts)
    },
  },
  'video.scrapeAssets': {
    description: 'Search Pexels/Pixabay/Unsplash in parallel for footage matching a brief. Returns downloaded asset paths ready for CapCut. Params: brief, mix? {video?, image?, music?}, orientation? (landscape|portrait|square), queries?',
    risk: 'low',
    handler: async (_w, p) => {
      const { findAssets } = await import('./video-asset-scraper.js')
      const brief = String(p['brief'] ?? '').trim()
      if (!brief) throw new Error('video.scrapeAssets: brief required')
      const input: import('./video-asset-scraper.js').FindAssetsInput = { brief }
      if (p['mix'])         input.mix         = p['mix'] as { video?: number; image?: number; music?: number }
      if (p['orientation']) input.orientation = p['orientation'] as 'landscape' | 'portrait' | 'square'
      if (Array.isArray(p['queries'])) input.queries = (p['queries'] as string[]).map(String)
      return findAssets(input)
    },
  },
  'video.editorAgent': {
    description: 'Full single-video pipeline: plan beats → scrape assets → drive CapCut → export. Params: brief, outPath, format? (long|short|square), originalFootage? (string[])',
    risk: 'high',     // GUI automation
    handler: async (workspaceId, p) => {
      const { editOne } = await import('./video-editor-agent.js')
      const brief   = String(p['brief']   ?? '').trim()
      const outPath = String(p['outPath'] ?? '').trim()
      if (!brief || !outPath) throw new Error('video.editorAgent: brief + outPath required')
      const input: import('./video-editor-agent.js').EditOneInput = { brief, outPath, workspaceId }
      if (p['format'])   input.format = p['format'] as 'long' | 'short' | 'square'
      if (Array.isArray(p['originalFootage'])) input.originalFootage = (p['originalFootage'] as string[]).map(String)
      return editOne(input)
    },
  },
  'video.massProduce': {
    description: 'Mass-produce N videos from N prompts (parallel asset scraping + serial CapCut assembly). Params: prompts (string[]), outDir, format? (long|short|square), concurrency? (default 1)',
    risk: 'high',
    handler: async (workspaceId, p) => {
      const { massProduce } = await import('./video-editor-agent.js')
      const prompts = Array.isArray(p['prompts']) ? (p['prompts'] as string[]).map(String).filter(s => s.length > 0) : []
      const outDir  = String(p['outDir'] ?? '').trim()
      if (prompts.length === 0) throw new Error('video.massProduce: prompts (non-empty array) required')
      if (!outDir) throw new Error('video.massProduce: outDir required')
      const input: import('./video-editor-agent.js').MassProduceInput = { prompts, outDir, workspaceId }
      if (p['format'])      input.format      = p['format'] as 'long' | 'short' | 'square'
      if (p['concurrency']) input.concurrency = Number(p['concurrency'])
      return massProduce(input)
    },
  },
  'tts.synthesize': {
    description: 'Generate voiceover audio from text. Fallback chain: ElevenLabs → OpenAI → PlayHT. Params: text, voice?, style? (neutral|narrator|energetic|calm|authoritative), speed?, outPath?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { synthesize } = await import('./voiceover-service.js')
      const text = String(p['text'] ?? '').trim()
      if (!text) throw new Error('tts.synthesize: text required')
      const input: import('./voiceover-service.js').TtsInput = { text, workspaceId }
      if (p['voice'])   input.voice   = String(p['voice'])
      if (p['style'])   input.style   = p['style'] as 'neutral' | 'narrator' | 'energetic' | 'calm' | 'authoritative'
      if (p['speed'])   input.speed   = Number(p['speed'])
      if (p['outPath']) input.outPath = String(p['outPath'])
      return synthesize(input)
    },
  },
  'captions.transcribe': {
    description: 'Whisper-transcribe a video/audio file to SRT. Params: path, wordLevel? (default false)',
    risk: 'low',
    handler: async (_w, p) => {
      const { transcribeToSrt } = await import('./caption-service.js')
      const path = String(p['path'] ?? '').trim()
      if (!path) throw new Error('captions.transcribe: path required')
      return transcribeToSrt(path, { wordLevel: !!p['wordLevel'] })
    },
  },
  'captions.burn': {
    description: 'Burn captions onto video (libass styled, tuned for vertical shorts). Params: videoPath, srtPath, outPath, fontSize?, bottomMargin?',
    risk: 'low',
    handler: async (_w, p) => {
      const { burnCaptions } = await import('./caption-service.js')
      const videoPath = String(p['videoPath'] ?? '').trim()
      const srtPath   = String(p['srtPath']   ?? '').trim()
      const outPath   = String(p['outPath']   ?? '').trim()
      if (!videoPath || !srtPath || !outPath) throw new Error('captions.burn: videoPath + srtPath + outPath required')
      const opts: import('./caption-service.js').BurnOptions = {}
      if (p['fontSize'])     opts.fontSize     = Number(p['fontSize'])
      if (p['bottomMargin']) opts.bottomMargin = Number(p['bottomMargin'])
      return burnCaptions(videoPath, srtPath, outPath, opts)
    },
  },
  'brand.saveKit': {
    description: 'Save brand kit for the workspace (logo, intro/outro, color, font, CTA). Params: logoPath?, logoPosition?, introPath?, outroPath?, primaryColor?, fontName?, callToAction?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { saveKit } = await import('./brand-kit.js')
      const kit: import('./brand-kit.js').BrandKit = { workspaceId }
      if (p['logoPath'])     kit.logoPath     = String(p['logoPath'])
      if (p['logoPosition']) kit.logoPosition = p['logoPosition'] as 'tl' | 'tr' | 'bl' | 'br'
      if (p['logoOpacity'])  kit.logoOpacity  = Number(p['logoOpacity'])
      if (p['introPath'])    kit.introPath    = String(p['introPath'])
      if (p['outroPath'])    kit.outroPath    = String(p['outroPath'])
      if (p['primaryColor']) kit.primaryColor = String(p['primaryColor'])
      if (p['fontName'])     kit.fontName     = String(p['fontName'])
      if (p['callToAction']) kit.callToAction = String(p['callToAction'])
      return saveKit(kit)
    },
  },
  'brand.loadKit': {
    description: 'Load the workspace brand kit (returns null if not configured).',
    risk: 'low',
    handler: async (workspaceId) => (await import('./brand-kit.js')).loadKit(workspaceId),
  },
  'brand.apply': {
    description: 'Apply brand kit (intro + logo overlay + outro) to a video. Params: inputVideo, outputVideo',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { applyBrandKit } = await import('./brand-kit.js')
      const inputVideo  = String(p['inputVideo']  ?? '').trim()
      const outputVideo = String(p['outputVideo'] ?? '').trim()
      if (!inputVideo || !outputVideo) throw new Error('brand.apply: inputVideo + outputVideo required')
      return applyBrandKit(workspaceId, inputVideo, outputVideo)
    },
  },
  'video.repurpose': {
    description: 'Turn a long-form video into N vertical shorts via Whisper-driven best-clip detection. Params: longFormPath, outDir, count? (default 6), durationSec? (default 45), vertical? (default true), burnCaptions? (default true)',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { repurpose } = await import('./video-repurpose.js')
      const longFormPath = String(p['longFormPath'] ?? '').trim()
      const outDir       = String(p['outDir']       ?? '').trim()
      if (!longFormPath || !outDir) throw new Error('video.repurpose: longFormPath + outDir required')
      const input: import('./video-repurpose.js').RepurposeInput = { longFormPath, outDir, workspaceId }
      if (p['count'] !== undefined)        input.count        = Number(p['count'])
      if (p['durationSec'] !== undefined)  input.durationSec  = Number(p['durationSec'])
      if (p['vertical'] !== undefined)     input.vertical     = Boolean(p['vertical'])
      if (p['burnCaptions'] !== undefined) input.burnCaptions = Boolean(p['burnCaptions'])
      return repurpose(input)
    },
  },
  'video.publish': {
    description: 'Publish a video to YouTube/TikTok/Instagram. REQUIRES confirm:true (operator approval). Params: videoPath, platforms? (string[]), title?, description?, tags? (string[]), publishAt? (ISO), privacy?, confirm:true',
    risk: 'high',
    handler: async (workspaceId, p) => {
      const { publishEverywhere } = await import('./video-publisher.js')
      const videoPath = String(p['videoPath'] ?? '').trim()
      const confirm   = p['confirm'] === true
      if (!videoPath) throw new Error('video.publish: videoPath required')
      if (!confirm)   throw new Error('video.publish: confirm:true required (operator approval gate)')
      const input: import('./video-publisher.js').PublishInput = { videoPath, confirm: true, workspaceId }
      if (p['title'])       input.title       = String(p['title'])
      if (p['description']) input.description = String(p['description'])
      if (Array.isArray(p['tags'])) input.tags = (p['tags'] as string[]).map(String)
      if (p['publishAt'])   input.publishAt   = String(p['publishAt'])
      if (p['privacy'])     input.privacy     = p['privacy'] as 'public' | 'private' | 'unlisted'
      const platforms = Array.isArray(p['platforms'])
        ? (p['platforms'] as string[]).filter(s => ['youtube', 'tiktok', 'instagram'].includes(s)) as Array<'youtube' | 'tiktok' | 'instagram'>
        : ['youtube', 'tiktok'] as const
      return publishEverywhere(input, platforms as Array<'youtube' | 'tiktok' | 'instagram'>)
    },
  },
  'broll.generate': {
    description: 'Generate synthetic b-roll via Runway/Luma/Replicate-SVD. Params: prompt, durationSec? (4-10), aspectRatio? (16:9|9:16|1:1), seedImageUrl?',
    risk: 'low',
    handler: async (_w, p) => {
      const { generateBroll } = await import('./ai-broll-generator.js')
      const prompt = String(p['prompt'] ?? '').trim()
      if (!prompt) throw new Error('broll.generate: prompt required')
      const input: import('./ai-broll-generator.js').BrollPrompt = { prompt }
      if (p['durationSec']) input.durationSec = Number(p['durationSec'])
      if (p['aspectRatio']) input.aspectRatio = p['aspectRatio'] as '16:9' | '9:16' | '1:1'
      if (p['seedImageUrl']) input.seedImageUrl = String(p['seedImageUrl'])
      return generateBroll(input)
    },
  },
  'broll.generateBatch': {
    description: 'Generate N synthetic b-roll clips in parallel. Params: prompts (array of {prompt, durationSec?, aspectRatio?})',
    risk: 'low',
    handler: async (_w, p) => {
      const { generateBatch } = await import('./ai-broll-generator.js')
      const prompts = Array.isArray(p['prompts']) ? (p['prompts'] as Array<Record<string, unknown>>) : []
      if (prompts.length === 0) throw new Error('broll.generateBatch: prompts required')
      return generateBatch(prompts.map(pr => {
        const out: import('./ai-broll-generator.js').BrollPrompt = { prompt: String(pr['prompt'] ?? '') }
        if (pr['durationSec']) out.durationSec = Number(pr['durationSec'])
        if (pr['aspectRatio']) out.aspectRatio = pr['aspectRatio'] as '16:9' | '9:16' | '1:1'
        if (pr['seedImageUrl']) out.seedImageUrl = String(pr['seedImageUrl'])
        return out
      }))
    },
  },
  'cache.stats':  { description: 'Asset cache stats.', risk: 'low', handler: async () => (await import('./asset-cache.js')).stats() },
  'cache.clear':  { description: 'Wipe asset cache.',   risk: 'low', handler: async () => (await import('./asset-cache.js')).clear() },
  'color.autoCorrect': {
    description: 'Auto base color correction (WB + contrast + sharpening). Params: inputVideo, outputVideo',
    risk: 'low',
    handler: async (_w, p) => {
      const { autoCorrect } = await import('./color-grading.js')
      const a = String(p['inputVideo'] ?? ''), b = String(p['outputVideo'] ?? '')
      if (!a || !b) throw new Error('color.autoCorrect: inputVideo + outputVideo required')
      return autoCorrect(a, b)
    },
  },
  'color.applyGrade': {
    description: 'Apply a creative color preset. Params: inputVideo, outputVideo, preset (cinematic|vlog|vintage|moody|clean|warm|cold|teal-orange|bw|punchy)',
    risk: 'low',
    handler: async (_w, p) => {
      const { applyGrade } = await import('./color-grading.js')
      const a = String(p['inputVideo'] ?? ''), b = String(p['outputVideo'] ?? ''), pr = String(p['preset'] ?? '')
      if (!a || !b || !pr) throw new Error('color.applyGrade: inputVideo + outputVideo + preset required')
      return applyGrade(a, b, pr as import('./color-grading.js').GradePreset)
    },
  },
  'color.applyLut': {
    description: 'Apply a .cube LUT file. Params: inputVideo, outputVideo, lutPath',
    risk: 'low',
    handler: async (_w, p) => {
      const { applyLut } = await import('./color-grading.js')
      return applyLut(String(p['inputVideo'] ?? ''), String(p['outputVideo'] ?? ''), String(p['lutPath'] ?? ''))
    },
  },
  'audio.duckMix': {
    description: 'Duck music under voiceover via sidechain compression + mux onto video. Params: videoPath, musicPath, voicePath, outPath, reductionDb?, attackMs?, releaseMs?, ratio?',
    risk: 'low',
    handler: async (_w, p) => {
      const { videoDuckedMix } = await import('./audio-ducking.js')
      const v = String(p['videoPath'] ?? ''), m = String(p['musicPath'] ?? ''), vo = String(p['voicePath'] ?? ''), o = String(p['outPath'] ?? '')
      if (!v || !m || !vo || !o) throw new Error('audio.duckMix: videoPath + musicPath + voicePath + outPath required')
      const opts: import('./audio-ducking.js').DuckOptions = {}
      if (p['reductionDb'] !== undefined) opts.reductionDb = Number(p['reductionDb'])
      if (p['attackMs']    !== undefined) opts.attackMs    = Number(p['attackMs'])
      if (p['releaseMs']   !== undefined) opts.releaseMs   = Number(p['releaseMs'])
      if (p['ratio']       !== undefined) opts.ratio       = Number(p['ratio'])
      return videoDuckedMix(v, m, vo, o, opts)
    },
  },
  'channel.save': {
    description: 'Save a channel (account + platform + OAuth token). Params: id, platform (youtube|tiktok|instagram), label, accessToken, refreshToken?, igUserId?, privacy?, defaultTags?, dailyQuota?',
    risk: 'high',     // writes OAuth tokens — credential write requires approval
    handler: async (workspaceId, p) => {
      const { saveChannel } = await import('./channel-manager.js')
      const ch: Omit<import('./channel-manager.js').Channel, 'createdAt'> = {
        id: String(p['id'] ?? ''), workspaceId,
        platform: p['platform'] as 'youtube' | 'tiktok' | 'instagram',
        label: String(p['label'] ?? ''),
        accessToken: String(p['accessToken'] ?? ''),
      }
      if (p['refreshToken']) ch.refreshToken = String(p['refreshToken'])
      if (p['igUserId'])     ch.igUserId     = String(p['igUserId'])
      if (p['privacy'])      ch.privacy      = p['privacy'] as 'public' | 'private' | 'unlisted'
      if (Array.isArray(p['defaultTags'])) ch.defaultTags = (p['defaultTags'] as string[]).map(String)
      if (p['dailyQuota'])   ch.dailyQuota   = Number(p['dailyQuota'])
      if (!ch.id || !ch.platform || !ch.label || !ch.accessToken) throw new Error('channel.save: id + platform + label + accessToken required')
      return saveChannel(ch)
    },
  },
  'channel.list':  { description: 'List channels for workspace. Params: platform?', risk: 'low', handler: async (workspaceId, p) => (await import('./channel-manager.js')).listChannels(workspaceId, p['platform'] as 'youtube' | 'tiktok' | 'instagram' | undefined) },
  'channel.delete':{ description: 'Delete a channel by id. Params: id', risk: 'medium', handler: async (_w, p) => { const id = String(p['id'] ?? '').trim(); if (!id) throw new Error('channel.delete: id required'); return (await import('./channel-manager.js')).deleteChannel(id) } },
  'channel.publishAll': {
    description: 'Publish a video to multiple channels in parallel. REQUIRES confirm:true. Params: videoPath, channelIds? (string[], default all), platforms?, title?, description?, tags?, publishAt?, privacy?, confirm:true',
    risk: 'high',
    handler: async (workspaceId, p) => {
      const { publishAcrossChannels } = await import('./channel-manager.js')
      if (p['confirm'] !== true) throw new Error('channel.publishAll: confirm:true required')
      const input: import('./channel-manager.js').MultiPublishInput = {
        videoPath: String(p['videoPath'] ?? ''),
        confirm: true, workspaceId,
      }
      if (Array.isArray(p['channelIds'])) input.channelIds = (p['channelIds'] as string[]).map(String)
      if (Array.isArray(p['platforms']))  input.platforms  = (p['platforms']  as string[]).filter(s => ['youtube','tiktok','instagram'].includes(s)) as Array<'youtube' | 'tiktok' | 'instagram'>
      if (p['title'])       input.title       = String(p['title'])
      if (p['description']) input.description = String(p['description'])
      if (Array.isArray(p['tags'])) input.tags = (p['tags'] as string[]).map(String)
      if (p['publishAt'])   input.publishAt   = String(p['publishAt'])
      if (p['privacy'])     input.privacy     = p['privacy'] as 'public' | 'private' | 'unlisted'
      if (!input.videoPath) throw new Error('channel.publishAll: videoPath required')
      return publishAcrossChannels(input)
    },
  },
  'analytics.snapshot': {
    description: 'Snapshot performance stats for a published video and persist as a memory. Params: platform (youtube|tiktok), videoId, brief?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { recordPerformance } = await import('./content-analytics.js')
      const platform = p['platform'] as 'youtube' | 'tiktok'
      const videoId  = String(p['videoId'] ?? '')
      if (!platform || !videoId) throw new Error('analytics.snapshot: platform + videoId required')
      return recordPerformance(workspaceId, platform, videoId, p['brief'] ? String(p['brief']) : undefined)
    },
  },
  'analytics.snapshotMany': {
    description: 'Bulk snapshot many published videos. Params: items (array of {platform, videoId, brief?})',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { snapshotMany } = await import('./content-analytics.js')
      const items = Array.isArray(p['items']) ? (p['items'] as Array<Record<string, unknown>>) : []
      return snapshotMany(workspaceId, items.map(it => {
        const out: { platform: 'youtube' | 'tiktok'; videoId: string; brief?: string } = {
          platform: it['platform'] as 'youtube' | 'tiktok',
          videoId: String(it['videoId'] ?? ''),
        }
        if (it['brief']) out.brief = String(it['brief'])
        return out
      }))
    },
  },
  'thumbnail.generate': {
    description: 'Generate a high-CTR thumbnail. Params: brief, videoPath?, title?, format? (landscape|portrait), strategy? (frame-pick|ai-generate|auto), outPath?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { generateThumbnail } = await import('./thumbnail-generator.js')
      const brief = String(p['brief'] ?? '').trim()
      if (!brief) throw new Error('thumbnail.generate: brief required')
      const input: import('./thumbnail-generator.js').ThumbnailInput = { brief, workspaceId }
      if (p['videoPath']) input.videoPath = String(p['videoPath'])
      if (p['title'])     input.title     = String(p['title'])
      if (p['format'])    input.format    = p['format'] as 'landscape' | 'portrait'
      if (p['strategy'])  input.strategy  = p['strategy'] as 'frame-pick' | 'ai-generate' | 'auto'
      if (p['outPath'])   input.outPath   = String(p['outPath'])
      return generateThumbnail(input)
    },
  },
  'schedule.save': {
    description: 'Save a daily-production schedule. Params: id, name, format (long|short|square), prompts (string[]), dailyQuota, outDir, hoursOfDay (number[]), publishChannels (string[]), confirmAutoPublish (bool), enabled (bool)',
    risk: 'medium',
    handler: async (workspaceId, p) => {
      const { saveSchedule } = await import('./scheduled-production.js')
      const s: Omit<import('./scheduled-production.js').ProductionSchedule, 'createdAt' | 'nextPromptIndex'> = {
        id: String(p['id'] ?? ''), workspaceId,
        name: String(p['name'] ?? ''),
        format: p['format'] as 'long' | 'short' | 'square',
        prompts: Array.isArray(p['prompts']) ? (p['prompts'] as string[]).map(String) : [],
        dailyQuota: Number(p['dailyQuota'] ?? 1),
        outDir: String(p['outDir'] ?? ''),
        hoursOfDay: Array.isArray(p['hoursOfDay']) ? (p['hoursOfDay'] as number[]).map(Number) : [9],
        publishChannels: Array.isArray(p['publishChannels']) ? (p['publishChannels'] as string[]).map(String) : [],
        confirmAutoPublish: Boolean(p['confirmAutoPublish']),
        enabled: Boolean(p['enabled']),
      }
      if (!s.id || !s.name || !s.outDir || s.prompts.length === 0) throw new Error('schedule.save: id + name + outDir + prompts required')
      return saveSchedule(s)
    },
  },
  'schedule.list':   { description: 'List production schedules for workspace.', risk: 'low', handler: async (workspaceId) => (await import('./scheduled-production.js')).listSchedules(workspaceId) },
  'schedule.delete': { description: 'Delete a schedule by id. Params: id', risk: 'medium', handler: async (_w, p) => { const id = String(p['id'] ?? '').trim(); if (!id) throw new Error('schedule.delete: id required'); return (await import('./scheduled-production.js')).deleteSchedule(id) } },
  'schedule.tick':   { description: 'Manually run the scheduled-production tick (normally cron-driven). Produces + publishes any schedules whose hour matches now.', risk: 'high', handler: async () => (await import('./scheduled-production.js')).tick() },
  'production.log': {
    description: 'List recent production events (music renders, video edits, mass-produce runs, publishes). Params: kind? (music|video|mass-produce|schedule|publish|thumbnail|repurpose), days? (default 7), limit? (default 200)',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { listEvents } = await import('./production-log.js')
      const opts: { workspaceId: string; kind?: import('./production-log.js').ProductionEvent['kind']; days?: number; limit?: number } = { workspaceId }
      if (p['kind'])  opts.kind  = p['kind']  as import('./production-log.js').ProductionEvent['kind']
      if (p['days'])  opts.days  = Number(p['days'])
      if (p['limit']) opts.limit = Number(p['limit'])
      return listEvents(opts)
    },
  },
  'production.cancel': {
    description: 'Cancel an in-flight mass-produce or scheduled-production run by token. Params: token',
    risk: 'low',
    handler: async (_w, p) => {
      const { cancel } = await import('./production-log.js')
      return cancel(String(p['token'] ?? ''))
    },
  },
  'production.activeCancelTokens': {
    description: 'List active cancel tokens (in-flight cancellable runs).',
    risk: 'low',
    handler: async () => ({ tokens: (await import('./production-log.js')).listActiveCancelTokens() }),
  },
  'bridge.claim': {
    description: 'Windows bridge pulls the next pending GUI job to execute locally. Params: bridgeId, opPrefix (e.g. "capcut." or "mixcraft." or "music.")',
    risk: 'low',
    handler: async (_w, p) => {
      const { claimNextJob } = await import('./gui-queue.js')
      return claimNextJob(String(p['bridgeId'] ?? 'bridge'), String(p['opPrefix'] ?? ''))
    },
  },
  'bridge.complete': {
    description: 'Windows bridge posts the result of an executed GUI job. Params: jobId, ok, result?, error?',
    risk: 'low',
    handler: async (_w, p) => {
      const { completeGuiJob } = await import('./gui-queue.js')
      const jobId = String(p['jobId'] ?? '')
      if (!jobId) throw new Error('bridge.complete: jobId required')
      await completeGuiJob(jobId, !!p['ok'], p['result'] as Record<string, unknown> | undefined, p['error'] ? String(p['error']) : undefined)
      return { ok: true }
    },
  },
  'bridge.status': {
    description: 'Is a Windows bridge actively claiming jobs? Returns {active, lastSeenMs, pendingJobs, bridges}.',
    risk: 'low',
    handler: async () => (await import('./gui-queue.js')).bridgeStatus(),
  },
  'bridge.heartbeat': {
    description: 'Windows bridge calls this every poll cycle to prove liveness. Params: bridgeId',
    risk: 'low',
    handler: async (_w, p) => {
      const { recordBridgeHeartbeat } = await import('./gui-queue.js')
      const id = String(p['bridgeId'] ?? '').trim()
      if (!id) throw new Error('bridge.heartbeat: bridgeId required')
      await recordBridgeHeartbeat(id)
      return { ok: true, at: Date.now() }
    },
  },
  'bridge.listJobs': {
    description: 'List queued GUI jobs. Params: status? (pending|claimed|completed|failed), limit?',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { listGuiJobs } = await import('./gui-queue.js')
      return listGuiJobs(workspaceId, p['status'] as 'pending' | 'claimed' | 'completed' | 'failed' | undefined, Number(p['limit'] ?? 50))
    },
  },
  // ─── Civilization-scale systems ────────────────────────────────
  'world.upsertNode':  { description: 'Add/update a node in the unified world model. Params: id, kind, label, attrs, health, importance', risk: 'low',
    handler: async (workspaceId, p) => {
      const { upsertNode } = await import('./world-model.js')
      await upsertNode({ id: String(p['id']), workspaceId, kind: p['kind'] as never, label: String(p['label']), attrs: (p['attrs'] as Record<string, unknown>) ?? {}, health: Number(p['health'] ?? 1.0), importance: Number(p['importance'] ?? 0.5) })
      return { ok: true }
    } },
  'world.upsertEdge':  { description: 'Add/update an edge. Params: id, fromId, toId, kind, weight, attrs?', risk: 'low',
    handler: async (workspaceId, p) => {
      const { upsertEdge } = await import('./world-model.js')
      await upsertEdge({ id: String(p['id']), workspaceId, fromId: String(p['fromId']), toId: String(p['toId']), kind: p['kind'] as never, weight: Number(p['weight'] ?? 0.5), ...(p['attrs'] ? { attrs: p['attrs'] as Record<string, unknown> } : {}) })
      return { ok: true }
    } },
  'world.neighbors':   { description: 'Query a node\'s neighborhood. Params: nodeId, depth?', risk: 'low',
    handler: async (workspaceId, p) => (await import('./world-model.js')).neighbors(workspaceId, String(p['nodeId']), Number(p['depth'] ?? 1)) },
  'world.causalChain': { description: 'Causal chain from a node. Params: nodeId, direction? (upstream|downstream), depth?', risk: 'low',
    handler: async (workspaceId, p) => (await import('./world-model.js')).causalChain(workspaceId, String(p['nodeId']), p['direction'] as 'upstream' | 'downstream' ?? 'downstream', Number(p['depth'] ?? 3)) },
  'world.listNodes':   { description: 'List all world-model nodes. Params: kind?', risk: 'low',
    handler: async (workspaceId, p) => (await import('./world-model.js')).listNodes(workspaceId, p['kind'] as never) },

  'twin.snapshotAll':  { description: 'Snapshot digital twins for all channels + businesses in workspace.', risk: 'low',
    handler: async (workspaceId) => (await import('./digital-twin.js')).snapshotAllForWorkspace(workspaceId) },
  'twin.list':         { description: 'List cached twins (from world-model).', risk: 'low',
    handler: async (workspaceId) => (await import('./digital-twin.js')).listTwinsFromModel(workspaceId) },

  'economic.scoreVideo': { description: 'ROI score for a published video. Params: videoId', risk: 'low',
    handler: async (workspaceId, p) => (await import('./economic-engine.js')).scorePublishedVideo(workspaceId, String(p['videoId'] ?? '')) },
  'economic.health':     { description: 'Workspace economic health (last N days). Params: days? (default 30)', risk: 'low',
    handler: async (workspaceId, p) => (await import('./economic-engine.js')).workspaceHealth(workspaceId, Number(p['days'] ?? 30)) },
  'economic.simulatePricing': { description: 'Pricing simulation. Params: candidates (number[]), fixedCostsUsdPerMonth, variableCostUsdPerUser, expectedConversionRate, expectedMonthlyVisitors', risk: 'low',
    handler: async (_w, p) => {
      const { simulatePricing } = await import('./economic-engine.js')
      return simulatePricing({
        candidates: (p['candidates'] as number[]) ?? [9, 19, 29, 49, 99],
        fixedCostsUsdPerMonth: Number(p['fixedCostsUsdPerMonth'] ?? 200),
        variableCostUsdPerUser: Number(p['variableCostUsdPerUser'] ?? 0.5),
        expectedConversionRate: Number(p['expectedConversionRate'] ?? 0.02),
        expectedMonthlyVisitors: Number(p['expectedMonthlyVisitors'] ?? 5000),
      })
    } },

  'governance.check':  { description: 'Check what governance would do for an op. Params: op, context?', risk: 'low',
    handler: async (workspaceId, p) => (await import('./governance-engine.js')).check(workspaceId, String(p['op'] ?? ''), String(p['context'] ?? '')) },
  'governance.listRules': { description: 'List governance rules.', risk: 'low',
    handler: async (workspaceId) => (await import('./governance-engine.js')).listRules(workspaceId) },
  'governance.saveRule': { description: 'Save a governance rule. Params: id, name, matcher, verdict (allow|approve|escalate|block), reason, priority?, enabled?', risk: 'medium',
    handler: async (workspaceId, p) => {
      const { saveRule } = await import('./governance-engine.js')
      return saveRule({
        id: String(p['id']), workspaceId, name: String(p['name']),
        matcher: String(p['matcher']), verdict: p['verdict'] as never,
        reason: String(p['reason']), priority: Number(p['priority'] ?? 500),
        enabled: p['enabled'] !== false,
      })
    } },

  'trust.record':  { description: 'Record a call outcome. Params: subject, ok, latencyMs, failureReason?', risk: 'low',
    handler: async (workspaceId, p) => { await (await import('./trust-reputation.js')).record(workspaceId, String(p['subject']), !!p['ok'], Number(p['latencyMs'] ?? 0), p['failureReason'] ? String(p['failureReason']) : undefined); return { ok: true } } },
  'trust.score':   { description: 'Get trust score for a subject. Params: subject', risk: 'low',
    handler: async (workspaceId, p) => (await import('./trust-reputation.js')).getScore(workspaceId, String(p['subject'] ?? '')) },
  'trust.topBroken': { description: 'Top broken/low-trust subjects.', risk: 'low',
    handler: async (workspaceId, p) => (await import('./trust-reputation.js')).listTopBroken(workspaceId, Number(p['limit'] ?? 10)) },

  'wisdom.check':  { description: 'Wisdom check before action. Params: action, expectedROI?, riskLevel?, reversible?, affectedSystems?', risk: 'low',
    handler: async (_w, p) => {
      const { wisdomCheck } = await import('./civilization-core.js')
      const input: Parameters<typeof wisdomCheck>[0] = { action: String(p['action']) }
      if (p['expectedROI']     !== undefined) input.expectedROI = Number(p['expectedROI'])
      if (p['riskLevel']       !== undefined) input.riskLevel = p['riskLevel'] as 'low' | 'medium' | 'high' | 'critical'
      if (p['reversible']      !== undefined) input.reversible = Boolean(p['reversible'])
      if (p['affectedSystems'] !== undefined) input.affectedSystems = Number(p['affectedSystems'])
      return wisdomCheck(input)
    } },

  'dna.get':       { description: 'Get operator DNA preferences.', risk: 'low',
    handler: async (workspaceId) => (await import('./civilization-core.js')).getOperatorDna(workspaceId) },
  'dna.observe':   { description: 'Record signals from a turn to refine operator DNA. Params: messageLength?, userClarifiedRisk?, hourOfDay?, rejectedAutomation?', risk: 'low',
    handler: async (workspaceId, p) => {
      const { observeTurn } = await import('./civilization-core.js')
      const signals: Parameters<typeof observeTurn>[1] = {}
      if (p['messageLength']      !== undefined) signals.messageLength = Number(p['messageLength'])
      if (p['userClarifiedRisk']  !== undefined) signals.userClarifiedRisk = Boolean(p['userClarifiedRisk'])
      if (p['hourOfDay']          !== undefined) signals.hourOfDay = Number(p['hourOfDay'])
      if (p['rejectedAutomation'] !== undefined) signals.rejectedAutomation = Boolean(p['rejectedAutomation'])
      await observeTurn(workspaceId, signals)
      return { ok: true }
    } },

  'physics.state': { description: 'Execution physics: velocity, friction, bottlenecks, leverage.', risk: 'low',
    handler: async (workspaceId) => (await import('./civilization-core.js')).execPhysics(workspaceId) },

  'evolve.discoverWeaknesses': { description: 'Discover self-evolution candidates.', risk: 'low',
    handler: async (workspaceId) => (await import('./civilization-core.js')).discoverWeaknesses(workspaceId) },

  'wargame.simulate': { description: 'Strategic scenario simulation. Params: scenario (platform-ban|api-rate-limit|competitor-launch|cost-spike|viral-spike|team-loss|security-breach|infra-outage), channels, dependencies, reserveBudgetUsd?', risk: 'low',
    handler: async (_w, p) => (await import('./civilization-core.js')).simulateScenario(p['scenario'] as never, { channels: Number(p['channels'] ?? 1), dependencies: (p['dependencies'] as string[]) ?? [], ...(p['reserveBudgetUsd'] !== undefined ? { reserveBudgetUsd: Number(p['reserveBudgetUsd']) } : {}) }) },

  'emergent.patterns': { description: 'Discover emergent strategic patterns from data.', risk: 'low',
    handler: async (workspaceId) => (await import('./civilization-core.js')).discoverPatterns(workspaceId) },

  'recap.generate':    { description: 'Generate executive recap. Params: sinceHoursAgo? (default 24)', risk: 'low',
    handler: async (workspaceId, p) => (await import('./civilization-core.js')).generateRecap(workspaceId, Number(p['sinceHoursAgo'] ?? 24)) },

  // ─── Business portfolio — tracks each business against the $10k/mo floor.
  //     See services/business-portfolio.ts.
  'portfolio.list': {
    description: 'List every business in the workspace with 30-day revenue and gap to $10k/mo target.',
    risk: 'low',
    handler: async (ws) => (await import('./business-portfolio.js')).listStatuses(ws),
  },
  'portfolio.status': {
    description: 'Single business deep status. Params: businessId (required).',
    risk: 'low',
    handler: async (ws, p) => {
      const id = String(p['businessId'] ?? '')
      if (!id) throw new Error('portfolio.status: businessId required')
      return (await import('./business-portfolio.js')).statusFor(ws, id)
    },
  },
  'portfolio.recordRevenue': {
    // High risk because revenue rows feed billing/operator decisions —
    // the brain should not append fake events. Operator-approval gated.
    description: 'Append a revenue event. Params: businessId, kind (ad_share|sale|sponsorship|affiliate|tip|refund|other), amountUsd, source?, sourceRef?, earningsMonth? (YYYY-MM)',
    risk: 'high',
    handler: async (ws, p) => {
      const { recordRevenue } = await import('./business-portfolio.js')
      const businessId = String(p['businessId'] ?? '')
      const kind       = String(p['kind'] ?? '')
      const amountUsd  = Number(p['amountUsd'])
      if (!businessId)               throw new Error('portfolio.recordRevenue: businessId required')
      if (!/^(ad_share|sale|sponsorship|affiliate|tip|refund|other)$/.test(kind))
                                     throw new Error('portfolio.recordRevenue: invalid kind')
      if (!Number.isFinite(amountUsd)) throw new Error('portfolio.recordRevenue: amountUsd must be finite')
      const opts: Parameters<typeof recordRevenue>[0] = {
        workspaceId: ws, businessId, kind: kind as never, amountUsd,
      }
      if (typeof p['source']        === 'string') opts.source        = p['source']        as string
      if (typeof p['sourceRef']     === 'string') opts.sourceRef     = p['sourceRef']     as string
      if (typeof p['earningsMonth'] === 'string') opts.earningsMonth = p['earningsMonth'] as string
      const id = await recordRevenue(opts)
      return { id, recorded: true }
    },
  },
  'portfolio.weeklyReview': {
    description: 'Monday-briefing structured review: per-business gap, on-track list, sunset candidates, action items.',
    risk: 'low',
    handler: async (ws) => (await import('./business-portfolio.js')).weeklyReview(ws),
  },
  'business.attach': {
    // Link a YouTube channel / Etsy shop / TikTok account / etc to a
    // business so the portfolio system auto-rolls-up revenue + signals.
    description: 'Attach an external revenue source (channel, shop, account) to a business. Params: businessId, source (youtube_channel|etsy_shop|tiktok_account|instagram_account|twitter_account|newsletter|stripe_product|shopify_store|other), sourceRef (platform id), label?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { attach } = await import('./business-attachments.js')
      const businessId = String(p['businessId'] ?? '')
      const source     = String(p['source']     ?? '')
      const sourceRef  = String(p['sourceRef']  ?? '')
      if (!businessId || !source || !sourceRef) {
        throw new Error('business.attach: businessId, source, sourceRef required')
      }
      const opts: Parameters<typeof attach>[0] = {
        workspaceId: ws, businessId,
        source:    source    as Parameters<typeof attach>[0]['source'],
        sourceRef,
      }
      if (typeof p['label']    === 'string') opts.label    = p['label']    as string
      if (typeof p['metadata'] === 'object' && p['metadata'] !== null) {
        opts.metadata = p['metadata'] as Record<string, unknown>
      }
      return attach(opts)
    },
  },
  'business.detach': {
    description: 'Soft-disable a business attachment (preserves history; re-attach to re-enable). Params: attachmentId.',
    risk: 'medium',
    handler: async (ws, p) => {
      const id = String(p['attachmentId'] ?? '')
      if (!id) throw new Error('business.detach: attachmentId required')
      return (await import('./business-attachments.js')).detach(ws, id)
    },
  },
  'business.listAttachments': {
    description: 'List all attachments for a business. Params: businessId.',
    risk: 'low',
    handler: async (ws, p) => {
      const id = String(p['businessId'] ?? '')
      if (!id) throw new Error('business.listAttachments: businessId required')
      return (await import('./business-attachments.js')).listForBusiness(ws, id)
    },
  },
  'business.realityCheck': {
    // Honest pace assessment against the $10k/mo floor. Side-effect free.
    description: 'Projects last-7d velocity forward, classifies the business as on-pace / drifting / structurally-off vs the $10k floor, and recommends continue / tweak / pivot / sunset / raise-target.',
    risk: 'low',
    handler: async (ws, p) => {
      const id = String(p['businessId'] ?? '')
      if (!id) throw new Error('business.realityCheck: businessId required')
      return (await import('./business-reality.js')).realityCheck(ws, id)
    },
  },
  'business.sunsetProposal': {
    // Per playbook §8 — never executes; always operator-confirmed.
    description: 'Compose a sunset proposal for a business (per multi-channel-operations §8). Brain never executes sunset; operator confirms.',
    risk: 'low',
    handler: async (ws, p) => {
      const id = String(p['businessId'] ?? '')
      if (!id) throw new Error('business.sunsetProposal: businessId required')
      return (await import('./business-reality.js')).sunsetProposal(ws, id)
    },
  },
  'portfolio.improve': {
    // The continuous-improvement loop, callable. Composes weekly review +
    // playbook references + an LLM step into a structured action plan.
    // Side-effect free; the operator decides which steps to execute.
    description: 'Produce a structured weekly action plan toward closing the $10k/mo per-business gap. Pulls playbook references + LLM-suggested steps.',
    risk: 'low',
    handler: async (ws) => (await import('./portfolio-improve.js')).improvePlan(ws),
  },
  'business.feasibility': {
    // Deterministic $10k/mo math — no LLM, no DB. Pure calculation from
    // the playbook unit economics. Brain calls this BEFORE proposing
    // any work on a business so it never wastes effort on a niche where
    // the math cannot close to $10k/mo.
    description: 'Run the deterministic $10k/mo feasibility math for a (category, niche, RPM, volume) combination. Returns gap, bottleneck, and closers. No DB writes.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { feasibility } = await import('./business-feasibility.js')
      const cat = String(p['category'] ?? 'mixed')
      const validCats = ['youtube', 'pod', 'social', 'newsletter', 'saas', 'mixed'] as const
      if (!validCats.includes(cat as never)) {
        throw new Error(`business.feasibility: category must be one of ${validCats.join(', ')}`)
      }
      const input: Parameters<typeof feasibility>[0] = { category: cat as typeof validCats[number] }
      if (typeof p['estRpmUsd']         === 'number') input.estRpmUsd        = p['estRpmUsd']         as number
      if (typeof p['estMonthlyVolume']  === 'number') input.estMonthlyVolume = p['estMonthlyVolume']  as number
      if (typeof p['avgOrderValueUsd']  === 'number') input.avgOrderValueUsd = p['avgOrderValueUsd']  as number
      if (typeof p['marginPerUnitUsd']  === 'number') input.marginPerUnitUsd = p['marginPerUnitUsd']  as number
      if (typeof p['channelCount']      === 'number') input.channelCount     = p['channelCount']      as number
      if (typeof p['workingCapitalUsd'] === 'number') input.workingCapitalUsd = p['workingCapitalUsd'] as number
      return feasibility(input)
    },
  },
  'business.create': {
    // High risk: creates a tracked revenue unit. Operator approval gated.
    // Refuses creation when the feasibility math rules out $10k/mo at
    // any realistic closer — protects the operator from committing
    // weeks of work to a niche that cannot pay the floor.
    description: 'Create a business with the $10k/mo floor enforced. Params: name, category, brief?, niche?, estRpmUsd?, estMonthlyVolume?, channelCount?, override (boolean; bypass feasibility refusal — discouraged).',
    risk: 'high',
    handler: async (ws, p) => {
      const name     = String(p['name'] ?? '').trim()
      const category = String(p['category'] ?? '').trim()
      if (!name)                                throw new Error('business.create: name required')
      if (!category)                            throw new Error('business.create: category required')
      const validCats = ['youtube', 'pod', 'social', 'newsletter', 'saas', 'mixed'] as const
      if (!validCats.includes(category as never)) {
        throw new Error(`business.create: category must be one of ${validCats.join(', ')}`)
      }
      const { feasibility, FLOOR_USD } = await import('./business-feasibility.js')
      const fInput: Parameters<typeof feasibility>[0] = { category: category as typeof validCats[number] }
      if (typeof p['estRpmUsd']        === 'number') fInput.estRpmUsd        = p['estRpmUsd']        as number
      if (typeof p['estMonthlyVolume'] === 'number') fInput.estMonthlyVolume = p['estMonthlyVolume'] as number
      if (typeof p['channelCount']     === 'number') fInput.channelCount     = p['channelCount']     as number
      const feas = feasibility(fInput)
      if (feas.refusalReason && p['override'] !== true) {
        return { ok: false, refused: true, reason: feas.refusalReason, feasibility: feas }
      }
      const { db } = await import('../db/client.js')
      const { businesses } = await import('../db/schema.js')
      const { v7: uuidv7 } = await import('uuid')
      const now = Date.now()
      const id = uuidv7()
      // Metrics carry the monthlyTargetUsd ($10k floor) + the feasibility
      // snapshot so the brain can see the baseline assumptions at any
      // future planning tick without re-running the math.
      const metrics = {
        monthlyTargetUsd: FLOOR_USD,
        phase: 'warm-up',
        feasibilityAtCreate: {
          projectedMonthlyUsd: feas.monthlyRevenueProjUsd,
          gapAtCreateUsd:      feas.gapToFloorUsd,
          bottleneck:          feas.bottleneck,
          createdAt:           now,
        },
      }
      await db.insert(businesses).values({
        id,
        workspaceId:  ws,
        name,
        industry:     category,
        stage:        'early',
        health:       'green',
        metrics,
        metadata:     {},
        dna:          {},
        ...(typeof p['brief'] === 'string' ? { brief: p['brief'] as string } : {}),
        createdAt:    now,
        updatedAt:    now,
      })
      return { ok: true, businessId: id, feasibility: feas, targetUsd: FLOOR_USD }
    },
  },
  'portfolio.setTarget': {
    // Floor-enforced — refuses < $10k/mo. Use sparingly; the floor is a
    // platform constraint, not a soft preference.
    description: 'Raise a business\'s monthly target. Params: businessId, targetUsd (>= 10000).',
    risk: 'medium',
    handler: async (ws, p) => {
      const id  = String(p['businessId'] ?? '')
      const tgt = Number(p['targetUsd'])
      if (!id)                    throw new Error('portfolio.setTarget: businessId required')
      if (!Number.isFinite(tgt))  throw new Error('portfolio.setTarget: targetUsd required')
      return (await import('./business-portfolio.js')).setMonthlyTarget(ws, id, tgt)
    },
  },

  // ─── Prompt evolution — self-improving prompt registry.
  //     See services/prompt-evolution.ts.
  'prompt.list': {
    description: 'List prompt slots with version count, mean score, total uses.',
    risk: 'low',
    handler: async (ws) => (await import('./prompt-evolution.js')).listSlots(ws),
  },
  'prompt.use': {
    description: 'Get the active prompt for a slot. Params: slot.',
    risk: 'low',
    handler: async (ws, p) => {
      const slot = String(p['slot'] ?? '')
      if (!slot) throw new Error('prompt.use: slot required')
      return (await import('./prompt-evolution.js')).usePrompt(ws, slot)
    },
  },
  'prompt.seed': {
    description: 'Add a new prompt version. Params: slot, body, origin?',
    risk: 'medium',
    handler: async (ws, p) => {
      const slot = String(p['slot'] ?? '')
      const body = String(p['body'] ?? '')
      if (!slot || body.length < 10) throw new Error('prompt.seed: slot + body (>= 10 chars) required')
      const opts: { workspaceId: string; slot: string; body: string; origin?: 'seed' | 'manual_edit' | 'auto_mutation' | 'auto_promotion' } = { workspaceId: ws, slot, body }
      if (typeof p['origin'] === 'string') {
        const o = p['origin']
        if (o === 'seed' || o === 'manual_edit' || o === 'auto_mutation' || o === 'auto_promotion') opts.origin = o
      }
      return (await import('./prompt-evolution.js')).seedPrompt(opts)
    },
  },
  'prompt.recordOutcome': {
    description: 'Record a 0..1 outcome score for a prompt use. Params: promptId, score.',
    risk: 'low',
    handler: async (_ws, p) => {
      const id    = String(p['promptId'] ?? '')
      const score = Number(p['score'])
      if (!id)                          throw new Error('prompt.recordOutcome: promptId required')
      if (!Number.isFinite(score))      throw new Error('prompt.recordOutcome: score must be finite')
      await (await import('./prompt-evolution.js')).recordOutcome(id, score)
      return { ok: true }
    },
  },
  'prompt.applyContentOutcome': {
    // Closes the prompt-evolution feedback loop. Given the prompts used
    // to produce a piece of content + the platform performance signals,
    // computes a 0..1 score for each slot and applies it to the registry.
    description: 'Apply a content performance outcome to the prompts that produced it. Params: promptIds {script?, thumbnail?, title?, hook?, description?, tags?}, platform, signals {ctr?, avg_view_duration_sec?, durationSec?, conversion_rate?, ...}, baseline?',
    risk: 'low',
    handler: async (ws, p) => {
      const { applyOutcome } = await import('./content-prompt-scoring.js')
      const promptIds = p['promptIds']
      const platform  = p['platform']
      const signals   = p['signals']
      if (typeof promptIds !== 'object' || promptIds === null) throw new Error('prompt.applyContentOutcome: promptIds object required')
      if (typeof platform !== 'string')                        throw new Error('prompt.applyContentOutcome: platform required')
      if (typeof signals !== 'object' || signals === null)     throw new Error('prompt.applyContentOutcome: signals object required')
      const opts: Parameters<typeof applyOutcome>[0] = {
        workspaceId: ws,
        promptIds:   promptIds as Parameters<typeof applyOutcome>[0]['promptIds'],
        platform:    platform  as Parameters<typeof applyOutcome>[0]['platform'],
        signals:     signals   as Parameters<typeof applyOutcome>[0]['signals'],
      }
      if (typeof p['baseline'] === 'object' && p['baseline'] !== null) {
        opts.baseline = p['baseline'] as NonNullable<Parameters<typeof applyOutcome>[0]['baseline']>
      }
      return applyOutcome(opts)
    },
  },
  'prompt.evolve': {
    description: 'Mutate one slot via the LLM. Retires underperformers, adds a variant of the winner. Params: slot.',
    risk: 'medium',
    handler: async (ws, p) => {
      const slot = String(p['slot'] ?? '')
      if (!slot) throw new Error('prompt.evolve: slot required')
      return (await import('./prompt-evolution.js')).evolvePrompt(ws, slot)
    },
  },
  'prompt.seedAll': {
    // Idempotent — only inserts slots that have no version yet. Safe to
    // call on workspace bootstrap or after operator clears a slot.
    description: 'Seed the workspace with starter prompts from the playbooks (script, thumbnail, etsy listing, tiktok hook, etc.). Idempotent.',
    risk: 'low',
    handler: async (ws) => (await import('./prompt-seeds.js')).seedAll(ws),
  },
  'prompt.availableSlots': {
    description: 'List the prompt slots the platform ships seeds for.',
    risk: 'low',
    handler: async () => (await import('./prompt-seeds.js')).availableSlots(),
  },

  // ─── Playbook knowledge — operator-curated knowledge files the brain
  //     consults before drafting plans / replies. See apps/api/knowledge/*
  'playbook.list': {
    description: 'List available playbooks (YouTube automation, social, POD, multi-channel ops).',
    risk: 'low',
    handler: async () => (await import('./playbook-knowledge.js')).listPlaybooks(),
  },
  'playbook.consult': {
    description: 'Look up playbook content. Params: query? (free text), slug? (e.g. "youtube-automation"), section? (H2 heading), maxSections? (default 3)',
    risk: 'low',
    handler: async (_ws, p) => {
      const { consult } = await import('./playbook-knowledge.js')
      const opts: { slug?: string; section?: string; query?: string; maxSections?: number } = {}
      if (typeof p['slug']        === 'string') opts.slug        = p['slug']    as string
      if (typeof p['section']     === 'string') opts.section     = p['section'] as string
      if (typeof p['query']       === 'string') opts.query       = p['query']   as string
      if (typeof p['maxSections'] === 'number') opts.maxSections = p['maxSections'] as number
      return consult(opts)
    },
  },
  'playbook.reload': {
    // Surfaces the freshly-edited markdown without restarting the API.
    // Operator-only — the LLM should never invalidate cache mid-stream.
    description: 'Force-reload playbook knowledge from disk (after operator edits a knowledge file).',
    risk: 'low',
    handler: async () => {
      const { invalidate } = await import('./playbook-knowledge.js')
      invalidate()
      return { reloaded: true }
    },
  },

  // ─── R146.86 — Experiments + Hypotheses + Calibration ────────────────
  'experiment.create': {
    description: 'Log an experiment with a falsifiable prediction. Params: title, hypothesis, prediction, metric, intervention, businessId?, baseline?, confidence? (0..1 pre-experiment)',
    risk: 'low',
    handler: async (ws, p) => {
      const { createExperiment } = await import('./experiments.js')
      return createExperiment({
        workspaceId:  ws,
        title:        String(p['title'] ?? ''),
        hypothesis:   String(p['hypothesis'] ?? ''),
        prediction:   String(p['prediction'] ?? ''),
        metric:       String(p['metric'] ?? ''),
        intervention: String(p['intervention'] ?? ''),
        ...(p['businessId'] ? { businessId: String(p['businessId']) } : {}),
        ...(p['baseline']   ? { baseline:   p['baseline'] as Record<string, unknown> } : {}),
        ...(typeof p['confidence'] === 'number' ? { confidence: p['confidence'] as number } : {}),
      })
    },
  },
  'experiment.list': {
    description: 'List experiments. Params: status? (running|concluded|abandoned)',
    risk: 'low',
    handler: async (ws, p) => {
      const { listExperiments } = await import('./experiments.js')
      return listExperiments(ws, p['status'] ? String(p['status']) : undefined)
    },
  },
  'experiment.conclude': {
    description: 'Mark experiment concluded with outcome + verdict. Params: id, outcome (object), verdict (supported|refuted|inconclusive), lessons?, confidencePost?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { concludeExperiment } = await import('./experiments.js')
      await concludeExperiment({
        workspaceId: ws,
        id:          String(p['id'] ?? ''),
        outcome:     (p['outcome'] as Record<string, unknown>) ?? {},
        verdict:     (p['verdict'] as 'supported' | 'refuted' | 'inconclusive') ?? 'inconclusive',
        ...(p['lessons'] ? { lessons: String(p['lessons']) } : {}),
        ...(typeof p['confidencePost'] === 'number' ? { confidencePost: p['confidencePost'] as number } : {}),
      })
      return { ok: true }
    },
  },
  'experiment.abandon': {
    description: 'Abandon a running experiment (cannot reach a conclusion). Params: id, reason',
    risk: 'low',
    handler: async (ws, p) => {
      const { abandonExperiment } = await import('./experiments.js')
      await abandonExperiment(ws, String(p['id'] ?? ''), String(p['reason'] ?? 'no reason'))
      return { ok: true }
    },
  },
  'hypothesis.create': {
    description: 'Author a falsifiable hypothesis. Params: subject, claim, prediction, confidence (0..1), relatedChain?',
    risk: 'low',
    handler: async (ws, p) => {
      const { createHypothesis } = await import('./experiments.js')
      return createHypothesis({
        workspaceId: ws,
        subject:     String(p['subject'] ?? ''),
        claim:       String(p['claim'] ?? ''),
        prediction:  String(p['prediction'] ?? ''),
        confidence:  typeof p['confidence'] === 'number' ? p['confidence'] as number : 0.5,
        ...(p['relatedChain'] ? { relatedChain: String(p['relatedChain']) } : {}),
      })
    },
  },
  'hypothesis.evidence': {
    description: 'Add evidence for/against a hypothesis. Params: id, side (for|against), description, weight? (1..5)',
    risk: 'low',
    handler: async (ws, p) => {
      const { addEvidence } = await import('./experiments.js')
      await addEvidence({
        workspaceId: ws,
        id:          String(p['id'] ?? ''),
        side:        (p['side'] as 'for' | 'against') ?? 'for',
        description: String(p['description'] ?? ''),
        ...(typeof p['weight'] === 'number' ? { weight: p['weight'] as number } : {}),
      })
      return { ok: true }
    },
  },
  'hypothesis.review': {
    description: 'Conclude a hypothesis. Params: id, verdict (supported|refuted|superseded), notes?',
    risk: 'low',
    handler: async (ws, p) => {
      const { reviewHypothesis } = await import('./experiments.js')
      await reviewHypothesis({
        workspaceId: ws,
        id:          String(p['id'] ?? ''),
        verdict:     (p['verdict'] as 'supported' | 'refuted' | 'superseded') ?? 'refuted',
        ...(p['notes'] ? { notes: String(p['notes']) } : {}),
      })
      return { ok: true }
    },
  },
  'hypothesis.list': {
    description: 'List hypotheses. Params: status? (open|supported|refuted|superseded)',
    risk: 'low',
    handler: async (ws, p) => {
      const { listHypotheses } = await import('./experiments.js')
      return listHypotheses(ws, p['status'] ? String(p['status']) : undefined)
    },
  },
  'calibration.curve': {
    description: 'Compute the brain\'s calibration reliability curve + Brier score. Params: daysBack? (default 90)',
    risk: 'low',
    handler: async (ws, p) => {
      const { calibrationCurve } = await import('./experiments.js')
      return calibrationCurve(ws, typeof p['daysBack'] === 'number' ? p['daysBack'] as number : 90)
    },
  },

  // ─── R146.87 — CEO strategic ops ─────────────────────────────────────
  'ceo.prioritize': {
    description: 'Rank businesses by ROI-per-attention-unit. Returns priority-scored list with recommended action per business.',
    risk: 'low',
    handler: async (ws) => (await import('./ceo-strategic.js')).prioritizeBusinesses(ws),
  },
  'ceo.proposeReallocation': {
    description: 'Propose capital reallocation across businesses by priority score. Params: monthlyBudgetUsd',
    risk: 'low',
    handler: async (ws, p) => (await import('./ceo-strategic.js')).proposeReallocation(ws, Number(p['monthlyBudgetUsd'] ?? 1000)),
  },
  'ceo.diversificationCheck': {
    description: 'Flag concentration risk in the business portfolio (by industry + stage).',
    risk: 'low',
    handler: async (ws) => (await import('./ceo-strategic.js')).diversificationCheck(ws),
  },
  'ceo.setOkrs': {
    description: 'Set quarterly OKRs. Params: quarter (e.g. "2026Q2"), objective, keyResults (array of {description, target, current, unit})',
    risk: 'medium',
    handler: async (ws, p) => (await import('./ceo-strategic.js')).setOkrs(ws, {
      quarter:    String(p['quarter'] ?? ''),
      objective:  String(p['objective'] ?? ''),
      keyResults: Array.isArray(p['keyResults']) ? (p['keyResults'] as Array<{ description: string; target: number; current: number; unit: string }>) : [],
    }),
  },
  'ceo.readOkrs': {
    description: 'Read current OKRs. Params: quarter?',
    risk: 'low',
    handler: async (ws, p) => (await import('./ceo-strategic.js')).readOkrs(ws, p['quarter'] ? String(p['quarter']) : undefined),
  },
  'ceo.retireAgents': {
    description: 'Retire underperforming agents based on failure rate. Params: minLifetimeDays? (default 7), maxFailureRate? (default 0.6)',
    risk: 'medium',
    handler: async (ws, p) => (await import('./ceo-strategic.js')).retireUnderperformingAgents(ws, {
      ...(typeof p['minLifetimeDays'] === 'number' ? { minLifetimeDays: p['minLifetimeDays'] as number } : {}),
      ...(typeof p['maxFailureRate']  === 'number' ? { maxFailureRate:  p['maxFailureRate']  as number } : {}),
    }),
  },
  'ceo.adversarialReview': {
    description: 'Second-LLM adversarial review of a proposed CEO plan. Params: planSummary, rationale, affectedBusinesses?, estimatedSpendUsd?',
    risk: 'low',
    handler: async (ws, p) => (await import('./ceo-strategic.js')).adversarialReview({
      workspaceId: ws,
      planSummary: String(p['planSummary'] ?? ''),
      rationale:   String(p['rationale']   ?? ''),
      ...(Array.isArray(p['affectedBusinesses']) ? { affectedBusinesses: (p['affectedBusinesses'] as string[]).map(String) } : {}),
      ...(typeof p['estimatedSpendUsd'] === 'number' ? { estimatedSpendUsd: p['estimatedSpendUsd'] as number } : {}),
    }),
  },
  'ceo.operatorUnavailability': {
    description: 'Read operator-unavailability state + recommended posture. State machine: normal → cooling (2d) → stale (5d) → frozen (14d).',
    risk: 'low',
    handler: async (ws) => (await import('./ceo-strategic.js')).operatorUnavailabilityState(ws),
  },

  // ─── R146.88 — Brain upgrades ──────────────────────────────────────
  'brain.classifySituation': { description: 'Classify a task into situation type. Params: task', risk: 'low',
    handler: async (_ws, p) => (await import('./brain-upgrades.js')).classifySituation(String(p['task'] ?? '')) },
  'brain.explainPlan': { description: 'Show-your-work: explain reasoning behind plan steps. Params: task, plan (array of {op, params})', risk: 'low',
    handler: async (ws, p) => (await import('./brain-upgrades.js')).explainPlan({ workspaceId: ws, task: String(p['task'] ?? ''), plan: (p['plan'] as Array<{ op: string; params: Record<string, unknown> }>) ?? [] }) },
  'brain.bridgeMemories': { description: 'Surface lessons from other businesses matching a topic. Params: fromBusinessId, topic, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./brain-upgrades.js')).bridgeMemories({ workspaceId: ws, fromBusinessId: String(p['fromBusinessId'] ?? ''), topic: String(p['topic'] ?? ''), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'brain.detectStuckLoop': { description: 'Scan recent activity for stuck-loop patterns. Params: windowMinutes? (default 60)', risk: 'low',
    handler: async (ws, p) => (await import('./brain-upgrades.js')).detectStuckLoop(ws, { ...(typeof p['windowMinutes'] === 'number' ? { windowMinutes: p['windowMinutes'] as number } : {}) }) },
  'brain.captureCorrection': { description: 'Persist operator correction as high-priority training signal. Params: originalClaim, operatorCorrection, context?', risk: 'low',
    handler: async (ws, p) => (await import('./brain-upgrades.js')).captureCorrection({ workspaceId: ws, originalClaim: String(p['originalClaim'] ?? ''), operatorCorrection: String(p['operatorCorrection'] ?? ''), ...(p['context'] ? { context: String(p['context']) } : {}) }) },

  // ─── R146.89 — Business architecture ────────────────────────────────
  'productline.add': { description: 'Add a SKU / product line. Params: businessId, sku, name, priceUsd, cogsUsd?, tags?', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).addProductLine({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), sku: String(p['sku'] ?? ''), name: String(p['name'] ?? ''), priceUsd: Number(p['priceUsd'] ?? 0), ...(typeof p['cogsUsd'] === 'number' ? { cogsUsd: p['cogsUsd'] as number } : {}), ...(Array.isArray(p['tags']) ? { tags: (p['tags'] as string[]).map(String) } : {}) }) },
  'productline.list': { description: 'List product lines. Params: businessId?', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).listProductLines(ws, p['businessId'] ? String(p['businessId']) : undefined) },
  'business.runway': { description: 'Compute runway for a business. Params: businessId, cashOnHandUsd?', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).runwayForBusiness(ws, String(p['businessId'] ?? ''), { ...(typeof p['cashOnHandUsd'] === 'number' ? { cashOnHandUsd: p['cashOnHandUsd'] as number } : {}) }) },
  'competitor.add': { description: 'Track a competitor. Params: businessId, name, url?, notes?, threat (low|medium|high)', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).addCompetitor({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), name: String(p['name'] ?? ''), threat: (p['threat'] as 'low' | 'medium' | 'high') ?? 'medium', ...(p['url']   ? { url:   String(p['url']) }   : {}), ...(p['notes'] ? { notes: String(p['notes']) } : {}) }) },
  'competitor.list': { description: 'List competitors for a business. Params: businessId', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).listCompetitors(ws, String(p['businessId'] ?? '')) },
  'segment.define': { description: 'Define a customer segment. Params: businessId, name, criteria, estimatedSize?, ltvUsd?, cacUsd?', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).defineSegment({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), name: String(p['name'] ?? ''), criteria: String(p['criteria'] ?? ''), ...(typeof p['estimatedSize'] === 'number' ? { estimatedSize: p['estimatedSize'] as number } : {}), ...(typeof p['ltvUsd'] === 'number' ? { ltvUsd: p['ltvUsd'] as number } : {}), ...(typeof p['cacUsd'] === 'number' ? { cacUsd: p['cacUsd'] as number } : {}) }) },
  'segment.list': { description: 'List segments for a business. Params: businessId', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).listSegments(ws, String(p['businessId'] ?? '')) },
  'business.suggestStageTransition': { description: 'Suggest stage transition based on metrics. Params: businessId', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).suggestStageTransition(ws, String(p['businessId'] ?? '')) },
  'business.autoPostmortem': { description: 'Auto-draft postmortem when a business is sunsetted. Params: businessId', risk: 'low',
    handler: async (ws, p) => (await import('./business-arch.js')).autoPostmortem(ws, String(p['businessId'] ?? '')) },

  // ─── R146.90 — Learning system upgrades ────────────────────────────
  'prompt_ab.create': { description: 'Create an A/B prompt test. Params: slot, variantA, variantB, trafficSplit?, notes?', risk: 'medium',
    handler: async (ws, p) => (await import('./learning-upgrades.js')).createPromptAbTest({ workspaceId: ws, slot: String(p['slot'] ?? ''), variantA: String(p['variantA'] ?? ''), variantB: String(p['variantB'] ?? ''), ...(typeof p['trafficSplit'] === 'number' ? { trafficSplit: p['trafficSplit'] as number } : {}), ...(p['notes'] ? { notes: String(p['notes']) } : {}) }) },
  'prompt_ab.pick': { description: 'Pick a variant for a slot. Params: slot', risk: 'low',
    handler: async (ws, p) => (await import('./learning-upgrades.js')).pickPromptVariant(ws, String(p['slot'] ?? '')) },
  'prompt_ab.outcome': { description: 'Record outcome for an A/B variant. Params: testId, variant (A|B), score (0..1)', risk: 'low',
    handler: async (ws, p) => { await (await import('./learning-upgrades.js')).recordPromptOutcome({ workspaceId: ws, testId: String(p['testId'] ?? ''), variant: (p['variant'] as 'A' | 'B') ?? 'A', score: Number(p['score'] ?? 0) }); return { ok: true } } },
  'prompt_ab.results': { description: 'Read A/B results. Params: testId', risk: 'low',
    handler: async (ws, p) => (await import('./learning-upgrades.js')).promptAbResults(ws, String(p['testId'] ?? '')) },
  'memory.tagDurability': { description: 'Tag memory with durability class. Params: memoryId, durability (evergreen|long|medium|short|time-sensitive), reason?', risk: 'low',
    handler: async (ws, p) => { await (await import('./learning-upgrades.js')).tagLessonDurability({ workspaceId: ws, memoryId: String(p['memoryId'] ?? ''), durability: (p['durability'] as 'evergreen' | 'long' | 'medium' | 'short' | 'time-sensitive') ?? 'medium', ...(p['reason'] ? { reason: String(p['reason']) } : {}) }); return { ok: true } } },
  'memory.deprecateStale': { description: 'Mark old non-evergreen memories deprecated. Params: olderThanDays? (default 180)', risk: 'medium',
    handler: async (ws, p) => (await import('./learning-upgrades.js')).deprecateStaleLessons(ws, { ...(typeof p['olderThanDays'] === 'number' ? { olderThanDays: p['olderThanDays'] as number } : {}) }) },
  'knowledge.ingestExternal': { description: 'Ingest external knowledge (podcast/newsletter/youtube/blog). Params: sourceType, sourceUrl, title?, summary?, tags?', risk: 'low',
    handler: async (ws, p) => (await import('./learning-upgrades.js')).ingestExternalKnowledge({ workspaceId: ws, sourceType: (p['sourceType'] as 'podcast' | 'newsletter' | 'youtube' | 'blog') ?? 'blog', sourceUrl: String(p['sourceUrl'] ?? ''), ...(p['title']   ? { title:   String(p['title']) }   : {}), ...(p['summary'] ? { summary: String(p['summary']) } : {}), ...(Array.isArray(p['tags']) ? { tags: (p['tags'] as string[]).map(String) } : {}) }) },
  'models.compare': { description: 'Compare LLM providers on a single prompt. Params: taskType, prompt, models?', risk: 'low',
    handler: async (ws, p) => (await import('./learning-upgrades.js')).compareModels({ workspaceId: ws, taskType: String(p['taskType'] ?? 'general'), prompt: String(p['prompt'] ?? '') }) },

  // ─── R146.91 — Video upgrades ─────────────────────────────────────
  'video.matchBroll': { description: 'Match script beats to b-roll queries. Params: scriptBeats (array of {beatId, text, durationSec, mood?})', risk: 'low',
    handler: async (ws, p) => (await import('./video-upgrades.js')).matchBrollToScript({ workspaceId: ws, scriptBeats: (p['scriptBeats'] as Array<{ beatId: string; text: string; durationSec: number; mood?: string }>) ?? [] }) },
  'video.analyzeRetention': { description: 'Analyze retention curve for dropoffs. Params: videoId, platform, bucketRetentionPct, bucketSeconds', risk: 'low',
    handler: async (ws, p) => (await import('./video-upgrades.js')).analyzeRetentionCurve({ workspaceId: ws, videoId: String(p['videoId'] ?? ''), platform: (p['platform'] as 'youtube' | 'tiktok' | 'instagram') ?? 'youtube', bucketRetentionPct: (p['bucketRetentionPct'] as number[]) ?? [], bucketSeconds: (p['bucketSeconds'] as number[]) ?? [] }) },
  'video.platformHook': { description: 'Get platform-specific hook guidance. Params: platform', risk: 'low',
    handler: async (_ws, p) => (await import('./video-upgrades.js')).platformHookGuide((p['platform'] as 'youtube-long' | 'youtube-short' | 'tiktok' | 'instagram-reel' | 'instagram-feed') ?? 'youtube-long') },
  'video.recordTrend': { description: 'Record a trend observation. Params: platform, trendKind (sound|format|hook|effect), descriptor, engagementSignal?, expiresInDays?', risk: 'low',
    handler: async (ws, p) => (await import('./video-upgrades.js')).recordTrendObservation({ workspaceId: ws, platform: String(p['platform'] ?? ''), trendKind: (p['trendKind'] as 'sound' | 'format' | 'hook' | 'effect') ?? 'format', descriptor: String(p['descriptor'] ?? ''), ...(typeof p['engagementSignal'] === 'number' ? { engagementSignal: p['engagementSignal'] as number } : {}), ...(typeof p['expiresInDays']    === 'number' ? { expiresInDays:    p['expiresInDays']    as number } : {}) }) },
  'video.listTrends': { description: 'List active trends. Params: platform?', risk: 'low',
    handler: async (ws, p) => (await import('./video-upgrades.js')).listActiveTrends(ws, p['platform'] ? String(p['platform']) : undefined) },
  'video.thumbnailExposure': { description: 'Record thumbnail exposure data. Params: videoId, variant, impressions, clicks', risk: 'low',
    handler: async (ws, p) => { await (await import('./video-upgrades.js')).recordThumbnailExposure({ workspaceId: ws, videoId: String(p['videoId'] ?? ''), variant: String(p['variant'] ?? ''), impressions: Number(p['impressions'] ?? 0), clicks: Number(p['clicks'] ?? 0) }); return { ok: true } } },
  'video.thumbnailWinner': { description: 'Pick A/B thumbnail winner. Params: videoId', risk: 'low',
    handler: async (ws, p) => (await import('./video-upgrades.js')).thumbnailAbWinner(ws, String(p['videoId'] ?? '')) },
  'video.planRelocalization': { description: 'Plan multi-language relocalization. Params: sourceLanguage, targetLanguages, durationSec', risk: 'low',
    handler: async (_ws, p) => (await import('./video-upgrades.js')).planRelocalization({ sourceLanguage: String(p['sourceLanguage'] ?? 'en'), targetLanguages: (p['targetLanguages'] as string[]) ?? [], durationSec: Number(p['durationSec'] ?? 60) }) },
  'video.planContinuity': { description: 'Plan multi-shot continuity conditioning. Params: shotCount, characterRefs?, sceneRefs?', risk: 'low',
    handler: async (_ws, p) => (await import('./video-upgrades.js')).planMultiShotContinuity({ shotCount: Number(p['shotCount'] ?? 1), ...(Array.isArray(p['characterRefs']) ? { characterRefs: (p['characterRefs'] as string[]).map(String) } : {}), ...(Array.isArray(p['sceneRefs'])     ? { sceneRefs:     (p['sceneRefs']     as string[]).map(String) } : {}) }) },

  // ─── R146.92 — Social upgrades ────────────────────────────────────
  'social.planRepurposing': { description: 'Plan cross-platform repurposing. Params: sourcePlatform, sourceFormat, targetPlatforms, durationSec?', risk: 'low',
    handler: async (_ws, p) => (await import('./social-upgrades.js')).planRepurposing({ sourcePlatform: (p['sourcePlatform'] as 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin') ?? 'youtube', sourceFormat: (p['sourceFormat'] as 'video' | 'image' | 'text-thread' | 'blog-post') ?? 'video', targetPlatforms: ((p['targetPlatforms'] as string[]) ?? []) as Array<'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin'>, ...(typeof p['durationSec'] === 'number' ? { durationSec: p['durationSec'] as number } : {}) }) },
  'social.queueResponse': { description: 'Queue an engagement response for approval. Params: platform, sourceId, sourceType (comment|dm|mention), authorHandle?, originalText, draftedReply, sentiment?', risk: 'medium',
    handler: async (ws, p) => (await import('./social-upgrades.js')).queueEngagementResponse({ workspaceId: ws, platform: (p['platform'] as 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin') ?? 'x-twitter', sourceId: String(p['sourceId'] ?? ''), sourceType: (p['sourceType'] as 'comment' | 'dm' | 'mention') ?? 'comment', ...(p['authorHandle'] ? { authorHandle: String(p['authorHandle']) } : {}), originalText: String(p['originalText'] ?? ''), draftedReply: String(p['draftedReply'] ?? ''), ...(p['sentiment'] ? { sentiment: p['sentiment'] as 'positive' | 'neutral' | 'negative' } : {}) }) },
  'social.listPendingResponses': { description: 'List queued responses. Params: platform?', risk: 'low',
    handler: async (ws, p) => (await import('./social-upgrades.js')).listPendingResponses(ws, p['platform'] ? p['platform'] as 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin' : undefined) },
  'social.recommendCadence': { description: 'Get optimal posting cadence + hours. Params: platform, audienceTimezones?, currentPostsPerWeek?', risk: 'low',
    handler: async (_ws, p) => (await import('./social-upgrades.js')).recommendCadence({ platform: (p['platform'] as 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin') ?? 'x-twitter', ...(Array.isArray(p['audienceTimezones']) ? { audienceTimezones: (p['audienceTimezones'] as string[]).map(String) } : {}), ...(typeof p['currentPostsPerWeek'] === 'number' ? { currentPostsPerWeek: p['currentPostsPerWeek'] as number } : {}) }) },
  'social.audienceOverlap': { description: 'Estimate audience overlap across platforms. Params: platforms (array of {platform, followerCount}), estimatedUniqueReach?', risk: 'low',
    handler: async (_ws, p) => (await import('./social-upgrades.js')).estimateAudienceOverlap({ platforms: (p['platforms'] as Array<{ platform: 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin'; followerCount: number }>) ?? [], ...(typeof p['estimatedUniqueReach'] === 'number' ? { estimatedUniqueReach: p['estimatedUniqueReach'] as number } : {}) }) },
  'social.triageCrisis': { description: 'Triage a cluster of negative feedback. Params: platform, clusterSize, sample (strings), topThemes (strings)', risk: 'low',
    handler: async (ws, p) => (await import('./social-upgrades.js')).triageNegativeFeedbackCluster({ workspaceId: ws, platform: (p['platform'] as 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin') ?? 'x-twitter', clusterSize: Number(p['clusterSize'] ?? 0), sample: (p['sample']    as string[]) ?? [], topThemes:   (p['topThemes'] as string[]) ?? [] }) },
  'influencer.add': { description: 'Add an influencer candidate. Params: platform, handle, niche, followerCount, engagementRate?, estimatedReach?, notes?', risk: 'low',
    handler: async (ws, p) => (await import('./social-upgrades.js')).recordInfluencerCandidate({ workspaceId: ws, platform: (p['platform'] as 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin') ?? 'x-twitter', handle: String(p['handle'] ?? ''), niche: String(p['niche'] ?? ''), followerCount: Number(p['followerCount'] ?? 0), ...(typeof p['engagementRate'] === 'number' ? { engagementRate: p['engagementRate'] as number } : {}), ...(typeof p['estimatedReach']  === 'number' ? { estimatedReach:  p['estimatedReach']  as number } : {}), ...(p['notes'] ? { notes: String(p['notes']) } : {}) }) },
  'influencer.outreachTemplate': { description: 'Get an outreach template. Params: tier (nano|micro|mid|macro), offer (free-product|flat-fee|rev-share|affiliate)', risk: 'low',
    handler: async (_ws, p) => (await import('./social-upgrades.js')).influencerOutreachTemplate({ tier: (p['tier'] as 'nano' | 'micro' | 'mid' | 'macro') ?? 'micro', offer: (p['offer'] as 'free-product' | 'flat-fee' | 'rev-share' | 'affiliate') ?? 'free-product' }) },

  // ─── R146.93 — Image upgrades ─────────────────────────────────────
  'image.route': { description: 'Route image request to best provider. Params: style (photoreal|art|illustration|product|character|logo), needsCharacterRef?, needsHighResolution?, budgetUsd?', risk: 'low',
    handler: async (_ws, p) => (await import('./image-upgrades.js')).routeImageRequest({ style: (p['style'] as 'photoreal' | 'art' | 'illustration' | 'product' | 'character' | 'logo') ?? 'photoreal', ...(typeof p['needsCharacterRef'] === 'boolean' ? { needsCharacterRef: p['needsCharacterRef'] as boolean } : {}), ...(typeof p['needsHighResolution'] === 'boolean' ? { needsHighResolution: p['needsHighResolution'] as boolean } : {}), ...(typeof p['budgetUsd'] === 'number' ? { budgetUsd: p['budgetUsd'] as number } : {}) }) },
  'image.planCharacter': { description: 'Plan character-consistency generation. Params: characterId, referenceImageUrls (strings), numGenerations', risk: 'low',
    handler: async (ws, p) => (await import('./image-upgrades.js')).planCharacterConsistency({ workspaceId: ws, characterId: String(p['characterId'] ?? ''), referenceImageUrls: (p['referenceImageUrls'] as string[]) ?? [], numGenerations: Number(p['numGenerations'] ?? 1) }) },
  'image.planUpscale': { description: 'Plan upscale + face-fix pipeline. Params: sourceWidth, sourceHeight, targetWidth, hasFaces?', risk: 'low',
    handler: async (_ws, p) => (await import('./image-upgrades.js')).planUpscalePipeline({ sourceWidth: Number(p['sourceWidth'] ?? 1024), sourceHeight: Number(p['sourceHeight'] ?? 1024), targetWidth: Number(p['targetWidth'] ?? 2048), ...(typeof p['hasFaces'] === 'boolean' ? { hasFaces: p['hasFaces'] as boolean } : {}) }) },
  'image.defineStylePack': { description: 'Define a style-pack (LoRA training brief). Params: businessId, name, referenceImageUrls, styleNotes', risk: 'low',
    handler: async (ws, p) => (await import('./image-upgrades.js')).defineStylePack({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), name: String(p['name'] ?? ''), referenceImageUrls: (p['referenceImageUrls'] as string[]) ?? [], styleNotes: String(p['styleNotes'] ?? '') }) },
  'image.variationExposure': { description: 'Record variation exposure data. Params: promptHash, variantId, impressionsOrViews, conversionsOrClicks', risk: 'low',
    handler: async (ws, p) => { await (await import('./image-upgrades.js')).recordVariationExposure({ workspaceId: ws, promptHash: String(p['promptHash'] ?? ''), variantId: String(p['variantId'] ?? ''), impressionsOrViews: Number(p['impressionsOrViews'] ?? 0), conversionsOrClicks: Number(p['conversionsOrClicks'] ?? 0) }); return { ok: true } } },
  'image.variationWinner': { description: 'Pick variation winner. Params: promptHash', risk: 'low',
    handler: async (ws, p) => (await import('./image-upgrades.js')).variationWinner(ws, String(p['promptHash'] ?? '')) },
  'image.planMockup': { description: 'Plan a product mockup compositor. Params: kind, designImageUrl, backgroundHint?', risk: 'low',
    handler: async (_ws, p) => (await import('./image-upgrades.js')).planMockup({ kind: (p['kind'] as 'tshirt-on-model' | 'mug-on-desk' | 'phone-case-flatlay' | 'poster-on-wall' | 'sticker-on-laptop' | 'hoodie-on-model') ?? 'tshirt-on-model', designImageUrl: String(p['designImageUrl'] ?? ''), ...(p['backgroundHint'] ? { backgroundHint: p['backgroundHint'] as 'neutral' | 'lifestyle' | 'studio' } : {}) }) },

  // ─── R146.94 — AI Video Studio ──────────────────────────────────────
  'aiVideo.planEpisode': { description: 'Plan an AI video episode (script outline + act structure). Params: logline, targetMinutes, format (short|long|episode|series-episode|film-act|feature-film), tone?, seriesId?, characters?', risk: 'low',
    handler: async (ws, p) => (await import('./ai-video-studio.js')).planEpisode({ workspaceId: ws, ...(p['seriesId'] ? { seriesId: String(p['seriesId']) } : {}), logline: String(p['logline'] ?? ''), targetMinutes: Number(p['targetMinutes'] ?? 5), format: (p['format'] as 'short' | 'long' | 'episode' | 'series-episode' | 'film-act' | 'feature-film') ?? 'long', ...(p['tone'] ? { tone: String(p['tone']) } : {}), ...(Array.isArray(p['characters']) ? { characters: (p['characters'] as Array<{ name: string; description: string; voiceCloneRef?: string }>) } : {}) }) },
  'aiVideo.generateShotList': { description: 'Generate shot list from script. Params: episodeId, script, targetMinutes, preferredCamera?', risk: 'low',
    handler: async (ws, p) => (await import('./ai-video-studio.js')).generateShotList({ workspaceId: ws, episodeId: String(p['episodeId'] ?? ''), script: String(p['script'] ?? ''), targetMinutes: Number(p['targetMinutes'] ?? 5), ...(p['preferredCamera'] ? { preferredCamera: p['preferredCamera'] as 'static' | 'mixed' | 'cinematic' } : {}) }) },
  'aiVideo.routeShot': { description: 'Route a single shot to its best provider. Params: shot (object)', risk: 'low',
    handler: async (_ws, p) => (await import('./ai-video-studio.js')).routeShotToProvider(p['shot'] as import('./ai-video-studio.js').Shot) },
  'aiVideo.buildContinuityPlan': { description: 'Build continuity plan for an episode. Params: episode ({characters, scenes, shots})', risk: 'low',
    handler: async (_ws, p) => (await import('./ai-video-studio.js')).buildContinuityPlan({ episode: p['episode'] as Pick<import('./ai-video-studio.js').Episode, 'characters' | 'scenes' | 'shots'> }) },
  'aiVideo.planAssembly': { description: 'Plan editorial assembly. Params: shots, pacing?, musicMood?', risk: 'low',
    handler: async (_ws, p) => (await import('./ai-video-studio.js')).planAssembly({ shots: (p['shots'] as import('./ai-video-studio.js').Shot[]) ?? [], ...(p['pacing']    ? { pacing:    p['pacing']    as 'slow' | 'medium' | 'fast' } : {}), ...(p['musicMood'] ? { musicMood: String(p['musicMood']) } : {}) }) },
  'aiVideo.createSeries': { description: 'Create an AI video series. Params: title, logline, targetEpisodes, genre?', risk: 'low',
    handler: async (ws, p) => (await import('./ai-video-studio.js')).createSeries({ workspaceId: ws, title: String(p['title'] ?? ''), logline: String(p['logline'] ?? ''), targetEpisodes: Number(p['targetEpisodes'] ?? 6), ...(p['genre'] ? { genre: String(p['genre']) } : {}) }) },
  'aiVideo.listEpisodesInSeries': { description: 'List episodes within a series. Params: seriesId', risk: 'low',
    handler: async (ws, p) => (await import('./ai-video-studio.js')).listEpisodesInSeries(ws, String(p['seriesId'] ?? '')) },
  'aiVideo.planFeatureFilm': { description: 'Plan a feature film (30-180min). Params: logline, targetMinutes, genre?', risk: 'low',
    handler: async (ws, p) => (await import('./ai-video-studio.js')).planFeatureFilm({ workspaceId: ws, logline: String(p['logline'] ?? ''), targetMinutes: Number(p['targetMinutes'] ?? 90), ...(p['genre'] ? { genre: String(p['genre']) } : {}) }) },

  // ─── R146.95 — Frontier model rendering ─────────────────────────────
  'aiVideo.renderShot': {
    description: 'Render a single shot via a specific frontier provider. Params: provider (runway|veo|sora|kling|luma|huggingface), prompt, durationSec, aspectRatio?, seed?, referenceImages?, cameraMove?. huggingface = free tier.',
    risk: 'high',     // spends real money
    handler: async (ws, p) => {
      const { renderShot } = await import('./ai-video-providers.js')
      return renderShot(
        (p['provider'] as 'runway' | 'veo' | 'sora' | 'kling' | 'luma' | 'huggingface') ?? 'kling',
        {
          prompt:           String(p['prompt'] ?? ''),
          durationSec:      Number(p['durationSec'] ?? 5),
          ...(p['aspectRatio']     ? { aspectRatio:     p['aspectRatio']     as '16:9' | '9:16' | '1:1' } : {}),
          ...(typeof p['seed'] === 'number' ? { seed: p['seed'] as number } : {}),
          ...(Array.isArray(p['referenceImages']) ? { referenceImages: (p['referenceImages'] as string[]).map(String) } : {}),
          ...(p['cameraMove']      ? { cameraMove:      p['cameraMove']      as 'static' | 'pan' | 'dolly' | 'crane' | 'tracking' } : {}),
          workspaceId: ws,
        },
      )
    },
  },
  'aiVideo.renderShotWithFallback': {
    description: 'Render a shot with provider chain fallback. Params: primary, fallbacks (array), prompt, durationSec, aspectRatio?, referenceImages?',
    risk: 'high',
    handler: async (ws, p) => {
      const { renderShotWithFallback } = await import('./ai-video-providers.js')
      return renderShotWithFallback(
        (p['primary'] as 'runway' | 'veo' | 'sora' | 'kling' | 'luma' | 'huggingface') ?? 'kling',
        ((p['fallbacks'] as string[]) ?? []) as Array<'runway' | 'veo' | 'sora' | 'kling' | 'luma' | 'huggingface'>,
        {
          prompt:      String(p['prompt'] ?? ''),
          durationSec: Number(p['durationSec'] ?? 5),
          ...(p['aspectRatio'] ? { aspectRatio: p['aspectRatio'] as '16:9' | '9:16' | '1:1' } : {}),
          ...(Array.isArray(p['referenceImages']) ? { referenceImages: (p['referenceImages'] as string[]).map(String) } : {}),
          workspaceId: ws,
        },
      )
    },
  },

  // ─── R146.96 — Full episode execution: plan → render → assemble ─────
  // ─── R146.97 — Autonomy budgets ────────────────────────────────────
  'autonomy.setBudget': {
    description: 'Set autonomous spend ceiling. Params: category (ads|content-gen|data|all), period (daily|weekly|monthly), ceilingUsd, businessId?, notes?',
    risk: 'medium',
    handler: async (ws, p) => (await import('./autonomy-budget.js')).setBudget({
      workspaceId: ws,
      category:    (p['category'] as 'ads' | 'content-gen' | 'data' | 'all') ?? 'all',
      period:      (p['period']   as 'daily' | 'weekly' | 'monthly') ?? 'daily',
      ceilingUsd:  Number(p['ceilingUsd'] ?? 0),
      ...(p['businessId'] ? { businessId: String(p['businessId']) } : {}),
      ...(p['notes'] ? { notes: String(p['notes']) } : {}),
    }),
  },
  'autonomy.listBudgets': {
    description: 'List autonomy budgets. Params: businessId?',
    risk: 'low',
    handler: async (ws, p) => (await import('./autonomy-budget.js')).listBudgets(ws, p['businessId'] ? String(p['businessId']) : undefined),
  },
  'autonomy.disableBudget': {
    description: 'Disable an autonomy budget by id. Params: id',
    risk: 'medium',
    handler: async (ws, p) => {
      await (await import('./autonomy-budget.js')).disableBudget(ws, String(p['id'] ?? ''))
      return { ok: true }
    },
  },
  'autonomy.checkSpend': {
    description: 'Check if a proposed spend can proceed autonomously. Params: category, amountUsd, businessId?',
    risk: 'low',
    handler: async (ws, p) => (await import('./autonomy-budget.js')).checkSpend({
      workspaceId: ws,
      category:    (p['category'] as 'ads' | 'content-gen' | 'data' | 'all') ?? 'all',
      amountUsd:   Number(p['amountUsd'] ?? 0),
      ...(p['businessId'] ? { businessId: String(p['businessId']) } : {}),
    }),
  },
  'autonomy.logSpend': {
    description: 'Log an autonomous spend after action succeeds. Params: category, amountUsd, op, businessId?, reason?',
    risk: 'low',
    handler: async (ws, p) => {
      await (await import('./autonomy-budget.js')).logSpend({
        workspaceId: ws,
        category:    (p['category'] as 'ads' | 'content-gen' | 'data' | 'all') ?? 'all',
        amountUsd:   Number(p['amountUsd'] ?? 0),
        op:          String(p['op'] ?? ''),
        ...(p['businessId'] ? { businessId: String(p['businessId']) } : {}),
        ...(p['reason'] ? { reason: String(p['reason']) } : {}),
      })
      return { ok: true }
    },
  },
  // ─── R146.99 — Frontier image-model rendering ──────────────────────
  'image.render': {
    description: 'Render image via a specific frontier provider. Params: provider (replicate-flux|replicate-sdxl|openai|stability|gemini-imagen|pollinations), prompt, width?, height?, numImages?, seed?, referenceImages?, negativePrompt?, guidanceScale?, steps?. pollinations = free, no key.',
    risk: 'high',
    handler: async (ws, p) => {
      const { renderImage } = await import('./ai-image-providers.js')
      return renderImage(
        (p['provider'] as 'replicate-flux' | 'replicate-sdxl' | 'openai' | 'stability' | 'gemini-imagen' | 'pollinations') ?? 'replicate-flux',
        {
          prompt:        String(p['prompt'] ?? ''),
          ...(typeof p['width']         === 'number' ? { width:         p['width']         as number } : {}),
          ...(typeof p['height']        === 'number' ? { height:        p['height']        as number } : {}),
          ...(typeof p['numImages']     === 'number' ? { numImages:     p['numImages']     as number } : {}),
          ...(typeof p['seed']          === 'number' ? { seed:          p['seed']          as number } : {}),
          ...(typeof p['guidanceScale'] === 'number' ? { guidanceScale: p['guidanceScale'] as number } : {}),
          ...(typeof p['steps']         === 'number' ? { steps:         p['steps']         as number } : {}),
          ...(Array.isArray(p['referenceImages']) ? { referenceImages: (p['referenceImages'] as string[]).map(String) } : {}),
          ...(p['negativePrompt'] ? { negativePrompt: String(p['negativePrompt']) } : {}),
          workspaceId: ws,
        },
      )
    },
  },
  'image.renderWithFallback': {
    description: 'Render image with provider fallback chain. Params: primary, fallbacks (array), prompt, width?, height?, numImages?, referenceImages?',
    risk: 'high',
    handler: async (ws, p) => {
      const { renderImageWithFallback } = await import('./ai-image-providers.js')
      return renderImageWithFallback(
        (p['primary'] as 'replicate-flux' | 'replicate-sdxl' | 'openai' | 'stability' | 'gemini-imagen' | 'pollinations') ?? 'replicate-flux',
        ((p['fallbacks'] as string[]) ?? []) as Array<'replicate-flux' | 'replicate-sdxl' | 'openai' | 'stability' | 'gemini-imagen' | 'pollinations'>,
        {
          prompt: String(p['prompt'] ?? ''),
          ...(typeof p['width']     === 'number' ? { width:     p['width']     as number } : {}),
          ...(typeof p['height']    === 'number' ? { height:    p['height']    as number } : {}),
          ...(typeof p['numImages'] === 'number' ? { numImages: p['numImages'] as number } : {}),
          ...(Array.isArray(p['referenceImages']) ? { referenceImages: (p['referenceImages'] as string[]).map(String) } : {}),
          workspaceId: ws,
        },
      )
    },
  },
  'image.renderRouted': {
    description: 'Route image request via image.route() heuristic + render with fallback chain. Params: prompt, style, needsCharacterRef?, needsHighResolution?, budgetUsd?, referenceImages?, width?, height?',
    risk: 'high',
    handler: async (ws, p) => {
      const { routeImageRequest } = await import('./image-upgrades.js')
      const { renderImageWithFallback } = await import('./ai-image-providers.js')
      const routing = routeImageRequest({
        style: (p['style'] as 'photoreal' | 'art' | 'illustration' | 'product' | 'character' | 'logo') ?? 'photoreal',
        ...(typeof p['needsCharacterRef']   === 'boolean' ? { needsCharacterRef:   p['needsCharacterRef']   as boolean } : {}),
        ...(typeof p['needsHighResolution'] === 'boolean' ? { needsHighResolution: p['needsHighResolution'] as boolean } : {}),
        ...(typeof p['budgetUsd']           === 'number'  ? { budgetUsd:           p['budgetUsd']           as number }  : {}),
      })
      const renderResult = await renderImageWithFallback(
        routing.primary   as 'replicate-flux' | 'replicate-sdxl' | 'openai' | 'stability' | 'gemini-imagen' | 'pollinations',
        routing.fallbacks as Array<'replicate-flux' | 'replicate-sdxl' | 'openai' | 'stability' | 'gemini-imagen' | 'pollinations'>,
        {
          prompt: String(p['prompt'] ?? ''),
          ...(typeof p['width']     === 'number' ? { width:     p['width']     as number } : {}),
          ...(typeof p['height']    === 'number' ? { height:    p['height']    as number } : {}),
          ...(typeof p['numImages'] === 'number' ? { numImages: p['numImages'] as number } : {}),
          ...(Array.isArray(p['referenceImages']) ? { referenceImages: (p['referenceImages'] as string[]).map(String) } : {}),
          workspaceId: ws,
        },
      )
      return { routing, render: renderResult }
    },
  },

  'autonomy.spendSummary': {
    description: 'Summary of period spend per category + active budgets. Params: businessId?',
    risk: 'low',
    handler: async (ws, p) => (await import('./autonomy-budget.js')).spendSummary(ws, p['businessId'] ? String(p['businessId']) : undefined),
  },

  // ─── R146.102 — Video post-prod gap closures ──────────────────────
  'aiVideo.projectCost': {
    description: 'Project cost + render-time for executing an episode before paying. Params: episode (object), parallelShots?, includeMusic?, includeVoiceover?, voiceoverWordCount?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { projectEpisodeCost } = await import('./ai-video-postprod.js')
      const ep = p['episode'] as Pick<import('./ai-video-studio.js').Episode, 'shots' | 'characters'>
      return projectEpisodeCost({
        episode: ep,
        ...(typeof p['parallelShots']      === 'number'  ? { parallelShots:      p['parallelShots']      as number  } : {}),
        ...(typeof p['includeMusic']       === 'boolean' ? { includeMusic:       p['includeMusic']       as boolean } : {}),
        ...(typeof p['includeVoiceover']   === 'boolean' ? { includeVoiceover:   p['includeVoiceover']   as boolean } : {}),
        ...(typeof p['voiceoverWordCount'] === 'number'  ? { voiceoverWordCount: p['voiceoverWordCount'] as number  } : {}),
      })
    },
  },
  'aiVideo.extractLastFrame': {
    description: 'Extract last frame of a video file via ffmpeg. Params: videoPath, outDir?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { extractLastFrame } = await import('./ai-video-postprod.js')
      return extractLastFrame(String(p['videoPath'] ?? ''), p['outDir'] ? String(p['outDir']) : undefined)
    },
  },
  'aiVideo.renderMultipleTakes': {
    description: 'Render N takes of a shot with different seeds. Params: shot (object), takeCount, baseSeed?',
    risk: 'high',
    handler: async (ws, p) => {
      const { renderMultipleTakes } = await import('./ai-video-postprod.js')
      return renderMultipleTakes(
        ws,
        p['shot'] as import('./ai-video-studio.js').Shot,
        Number(p['takeCount'] ?? 3),
        typeof p['baseSeed'] === 'number' ? p['baseSeed'] as number : undefined,
      )
    },
  },
  'aiVideo.selectBestTake': {
    description: 'Score N takes + pick best by ok+size+cost. Params: takes (array of {takeIdx, result, localPath?})',
    risk: 'low',
    handler: async (_ws, p) => {
      const { selectBestTake } = await import('./ai-video-postprod.js')
      return selectBestTake((p['takes'] as Array<{ takeIdx: number; result: import('./ai-video-providers.js').RenderResult; localPath?: string }>) ?? [])
    },
  },
  'aiVideo.synthesizeCharacterVoices': {
    description: 'Synthesize voice lines per character via each character\'s voiceCloneRef. Params: characters (array), lines (array of {characterId, text, startTimeSec})',
    risk: 'medium',
    handler: async (ws, p) => {
      const { synthesizePerCharacterVoices } = await import('./ai-video-postprod.js')
      return synthesizePerCharacterVoices({
        workspaceId: ws,
        characters:  (p['characters'] as import('./ai-video-studio.js').Character[]) ?? [],
        lines:       (p['lines'] as Array<{ characterId: string; text: string; startTimeSec: number }>) ?? [],
      })
    },
  },
  // ─── R146.103 — Token stretching for AI video ────────────────────
  'aiVideo.stretchShotList': {
    description: 'Apply all 4 stretching strategies to a shot list (compress prompts, min-viable duration, dedup, efficiency routing). Returns optimized shots + savings report.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { stretchShotList } = await import('./ai-video-stretcher.js')
      return stretchShotList((p['shots'] as import('./ai-video-studio.js').Shot[]) ?? [])
    },
  },
  'aiVideo.compressPrompt': {
    description: 'Compress a single shot prompt — strip hedges, boilerplate, repeats. Params: prompt',
    risk: 'low',
    handler: async (_ws, p) => {
      const { compressPrompt } = await import('./ai-video-stretcher.js')
      return compressPrompt(String(p['prompt'] ?? ''))
    },
  },
  'aiVideo.budgetAwarePlan': {
    description: 'Compute optimal shot count + duration mix + provider assignment for a budget. Params: budgetUsd, targetMinutes',
    risk: 'low',
    handler: async (_ws, p) => {
      const { budgetAwareShotPlan } = await import('./ai-video-stretcher.js')
      return budgetAwareShotPlan(Number(p['budgetUsd'] ?? 50), Number(p['targetMinutes'] ?? 5))
    },
  },
  'aiVideo.selectByEfficiency': {
    description: 'Pick most-efficient provider for a beat by $/quality-point. Params: prompt',
    risk: 'low',
    handler: async (_ws, p) => {
      const { selectByEfficiency } = await import('./ai-video-stretcher.js')
      return selectByEfficiency(String(p['prompt'] ?? ''))
    },
  },
  'aiVideo.dedupShots': {
    description: 'Find near-identical shots that can be rendered once and reused. Params: shots (array), similarityThreshold? (0..1, default 0.85)',
    risk: 'low',
    handler: async (_ws, p) => {
      const { dedupShots } = await import('./ai-video-stretcher.js')
      return dedupShots(
        (p['shots'] as import('./ai-video-studio.js').Shot[]) ?? [],
        typeof p['similarityThreshold'] === 'number' ? p['similarityThreshold'] as number : 0.85,
      )
    },
  },

  'aiVideo.mixCharacterVoices': {
    description: 'Mix per-character voice tracks into single track with timing. Params: lines (array of {audioPath, startTimeSec}), outputPath',
    risk: 'low',
    handler: async (_ws, p) => {
      const { mixCharacterVoices } = await import('./ai-video-postprod.js')
      return mixCharacterVoices({
        lines:      (p['lines'] as Array<{ audioPath: string; startTimeSec: number }>) ?? [],
        outputPath: String(p['outputPath'] ?? ''),
      })
    },
  },

  'aiVideo.executeEpisode': {
    description: 'End-to-end execution: render every shot, generate music + voiceover, ffmpeg concat, optional captions + brand. Params: episode (object with characters/scenes/shots), concatOutputPath, parallelShots?, generateMusic?, generateVoiceover?, burnCaptions?, applyBrandKit?',
    risk: 'critical',         // can spend tens or hundreds of dollars; OPERATOR_APPROVED required
    handler: async (ws, p) => {
      const { executeEpisode } = await import('./ai-video-executor.js')
      return executeEpisode({
        workspaceId:      ws,
        episode:          p['episode']         as import('./ai-video-studio.js').Episode,
        concatOutputPath: String(p['concatOutputPath'] ?? '/srv/renders/episode.mp4'),
        ...(typeof p['parallelShots'] === 'number' ? { parallelShots: p['parallelShots'] as number } : {}),
        ...(p['generateMusic']     ? { generateMusic:     p['generateMusic']     as { prompt: string; durationSec?: number } } : {}),
        ...(p['generateVoiceover'] ? { generateVoiceover: p['generateVoiceover'] as { text: string; voice?: string; style?: 'neutral' | 'narrator' | 'energetic' | 'calm' | 'authoritative' } } : {}),
        ...(typeof p['burnCaptions']  === 'boolean' ? { burnCaptions:  p['burnCaptions']  as boolean } : {}),
        ...(typeof p['applyBrandKit'] === 'boolean' ? { applyBrandKit: p['applyBrandKit'] as boolean } : {}),
      })
    },
  },

  // ─── Media analyzer (R121/R122) — exposed via brain-task so MCP picks
  //     them up automatically from listAvailableOperations(). All locked
  //     refusals (facial-id, voice biometrics, generation, surveillance)
  //     are enforced inside media-analyzer.
  'media.image.analyze': {
    description: 'Multi-type image analysis (objects/scene/safety/alt_text/text_ocr/brand_compliance/quality). Params: imageHash, source (URL or base64), analysisTypes (array), intent (string for refusal checking).',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { analyzeImage } = await import('./media-analyzer.js')
      return analyzeImage({
        imageHash:     String(p['imageHash'] ?? ''),
        source:        String(p['source'] ?? ''),
        workspaceId,
        requestedBy:   String(p['requestedBy'] ?? 'agent'),
        analysisTypes: Array.isArray(p['analysisTypes']) ? p['analysisTypes'] as never : ['scene'],
        intent:        String(p['intent'] ?? 'analyze image'),
      })
    },
  },
  'media.video.estimate_cost': {
    description: 'Pre-flight video analysis cost estimate. Params: durationSec, mode (sparse/adaptive/dense), budgetUsd. Returns frames-to-analyze + estCostUsd + willExceedBudget.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { estimateVideoCost } = await import('./media-analyzer.js')
      return estimateVideoCost(
        Number(p['durationSec']) || 0,
        (p['mode'] as 'sparse' | 'adaptive' | 'dense') ?? 'sparse',
        Number(p['budgetUsd']) || 1,
      )
    },
  },
  'media.video.submit': {
    description: 'Submit a video analysis job. Params: videoUrl, mode (sparse/adaptive/dense), intent, budgetUsdCap. Async — returns jobId; result lands as media.video_analyzed event.',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { submitVideoAnalysis } = await import('./media-analyzer.js')
      return submitVideoAnalysis({
        videoUrl:     String(p['videoUrl'] ?? ''),
        workspaceId,
        requestedBy:  String(p['requestedBy'] ?? 'agent'),
        mode:         (p['mode'] as 'sparse' | 'adaptive' | 'dense') ?? 'sparse',
        intent:       String(p['intent'] ?? 'analyze video'),
        budgetUsdCap: Number(p['budgetUsdCap']) || 1,
      })
    },
  },
  'media.tools': {
    description: 'List the media-analyzer MCP tool catalog (image + video).',
    risk: 'low',
    handler: async () => {
      const { listMediaMcpTools } = await import('./media-analyzer.js')
      return { tools: listMediaMcpTools() }
    },
  },

  // ─── Kill-switch control — operator opts into autonomy stages ──────
  'kill_switch.list': {
    description: 'List autonomy kill switches for the workspace (autonomous_writes / autonomous_deploys / destructive_migrations / external_communications). Returns {switch_type, enabled, reason}.',
    risk: 'low',
    handler: async (workspaceId) => {
      const { db } = await import('../db/client.js')
      const { sql: _sql } = await import('drizzle-orm')
      const rows = await db.execute(_sql`SELECT switch_type, enabled, reason FROM kill_switches WHERE workspace_id = ${workspaceId} ORDER BY switch_type`)
      return (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
    },
  },
  'kill_switch.enable': {
    description: 'Enable an autonomy kill switch (operator opts in). Params: switch_type (autonomous_writes|autonomous_deploys|destructive_migrations|external_communications|ai_request)',
    risk: 'high',     // requires OPERATOR_APPROVED token
    handler: async (workspaceId, p) => {
      const { db } = await import('../db/client.js')
      const { sql: _sql } = await import('drizzle-orm')
      const sw = String(p['switch_type'] ?? '').trim()
      if (!sw) throw new Error('kill_switch.enable: switch_type required')
      // R146.60 — allowlist + row-count check. Pre-fix: an unknown
      // switch_type silently UPDATE'd 0 rows and returned ok:true,
      // telling the operator the switch was engaged when nothing
      // happened. Plus an LLM hallucination could pass arbitrary
      // switch_type and never get told it was wrong.
      const KNOWN_SWITCHES = new Set(['autonomous_writes', 'autonomous_deploys', 'destructive_migrations', 'external_communications', 'ai_request'])
      if (!KNOWN_SWITCHES.has(sw)) {
        throw new Error(`kill_switch.enable: unknown switch_type '${sw}' (known: ${[...KNOWN_SWITCHES].join('|')})`)
      }
      const res = await db.execute(_sql`UPDATE kill_switches SET enabled = true, reason = ${'Enabled by operator at ' + new Date().toISOString()} WHERE workspace_id = ${workspaceId} AND switch_type = ${sw} RETURNING switch_type`)
      const rows = (res as unknown as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res as unknown[] : [])
      if (rows.length === 0) {
        throw new Error(`kill_switch.enable: no row found for workspace+switch_type (run a kill_switch.list first)`)
      }
      return { ok: true, switch_type: sw, enabled: true }
    },
  },
  'kill_switch.disable': {
    description: 'Disable an autonomy kill switch (revoke opt-in). Params: switch_type',
    risk: 'high',     // asymmetric with enable (high) — disabling safety must be approved
    handler: async (workspaceId, p) => {
      const { db } = await import('../db/client.js')
      const { sql: _sql } = await import('drizzle-orm')
      const sw = String(p['switch_type'] ?? '').trim()
      if (!sw) throw new Error('kill_switch.disable: switch_type required')
      // R146.60 — same allowlist + row-count guard as enable.
      const KNOWN_SWITCHES = new Set(['autonomous_writes', 'autonomous_deploys', 'destructive_migrations', 'external_communications', 'ai_request'])
      if (!KNOWN_SWITCHES.has(sw)) {
        throw new Error(`kill_switch.disable: unknown switch_type '${sw}' (known: ${[...KNOWN_SWITCHES].join('|')})`)
      }
      const res = await db.execute(_sql`UPDATE kill_switches SET enabled = false, reason = ${'Disabled by operator at ' + new Date().toISOString()} WHERE workspace_id = ${workspaceId} AND switch_type = ${sw} RETURNING switch_type`)
      const rows = (res as unknown as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res as unknown[] : [])
      if (rows.length === 0) {
        throw new Error(`kill_switch.disable: no row found for workspace+switch_type`)
      }
      return { ok: true, switch_type: sw, enabled: false }
    },
  },

  // ─── Risk awareness + reality verification ─────────────────────
  'risk.classify':   { description: 'Classify a proposed action against the 30-category risk taxonomy. Params: action, context?', risk: 'low',
    handler: async (_w, p) => (await import('./risk-taxonomy.js')).classifyAction(String(p['action'] ?? ''), String(p['context'] ?? '')) },
  'risk.scan':       { description: 'Run all active failure detectors for the workspace.', risk: 'low',
    handler: async (workspaceId) => (await import('./failure-detector.js')).scanAll(workspaceId) },
  'risk.categories': { description: 'Return the full risk taxonomy.', risk: 'low',
    handler: async () => (await import('./risk-taxonomy.js')).RISK_CATEGORIES },
  'verify.opResult': { description: 'Verify an op result actually maps to real state (file exists, URL reachable, DB row present). Params: opResult', risk: 'low',
    handler: async (_w, p) => (await import('./realism-verifier.js')).verifyOpComplete((p['opResult'] as Record<string, unknown>) ?? {}) },
  'verify.fileExists': { description: 'Verify a file exists + is non-empty. Params: path', risk: 'low',
    handler: async (_w, p) => (await import('./realism-verifier.js')).verifyFileExists(String(p['path'] ?? '')) },
  'verify.urlReachable': { description: 'HEAD-check a URL. Params: url', risk: 'low',
    handler: async (_w, p) => (await import('./realism-verifier.js')).verifyUrlReachable(String(p['url'] ?? '')) },

  'gui.status': {
    description: 'GUI mutex status — shows which single-instance apps (capcut/mixcraft) are held and how many ops are queued.',
    risk: 'low',
    handler: async () => (await import('./gui-mutex.js')).guiLockStatus(),
  },
  'tts.status': {
    description: 'TTS daily budget usage (chars used today, remaining, daily cap).',
    risk: 'low',
    handler: async () => (await import('./voiceover-service.js')).ttsStatus(),
  },
  'video.knowledge': {
    description: 'Recall the brain\'s studied video-editing knowledge (retention, hooks, color, captions, CapCut workflow, etc). Params: query, limit? (default 8)',
    risk: 'low',
    handler: async (workspaceId, p) => {
      const { recallVideoKnowledge } = await import('./video-knowledge.js')
      const query = String(p['query'] ?? '').trim()
      if (!query) throw new Error('video.knowledge: query required')
      const limit = Math.max(1, Math.min(30, Number(p['limit'] ?? 8)))
      const items = await recallVideoKnowledge(workspaceId, query, limit)
      return { count: items.length, items }
    },
  },

  'mixcraft.compose': {
    description: 'High-level: render multi-stem song via ACE-Step master tier, import into Mixcraft, mix down to outPath. Params: prompt, lyrics?, duration?, bpm?, key?, outPath, stems? (drums|bass|harmony|lead|vocals[]). Produces a mastered file with no operator intervention.',
    risk: 'high',     // GUI automation; operator should know
    handler: async (workspaceId, p) => {
      const { compose } = await import('./mixcraft-controller.js')
      const prompt = String(p['prompt'] ?? '').trim()
      const outPath = String(p['outPath'] ?? '').trim()
      if (!prompt)  throw new Error('mixcraft.compose: prompt required')
      if (!outPath) throw new Error('mixcraft.compose: outPath required')
      const input: import('./mixcraft-controller.js').ComposeInput = { prompt, outPath, workspaceId }
      if (p['lyrics'])   input.lyrics   = String(p['lyrics'])
      if (p['duration']) input.duration = Number(p['duration'])
      if (p['bpm'])      input.bpm      = Number(p['bpm'])
      if (p['key'])      input.key      = String(p['key'])
      if (Array.isArray(p['stems'])) {
        const allowed = ['drums','bass','harmony','lead','vocals'] as const
        type Stem = typeof allowed[number]
        const filtered = (p['stems'] as string[]).filter((s): s is Stem => (allowed as readonly string[]).includes(s))
        if (filtered.length > 0) input.stems = filtered
      }
      return compose(input)
    },
  },

  // ─── Safety / governance ───────────────────────────────────────
  'safety.flags': {
    description: 'Read current safety flags (tonight mode, autonomous gates).',
    risk: 'low',
    handler: async (ws) => {
      const { getSafetyFlags } = await import('./safety-mode.js')
      return getSafetyFlags(ws)
    },
  },

  // ─── Browser control (session-based playwright) ────────────────
  'browser.open': {
    description: 'Open a URL in a headless browser session. Returns sessionId. Params: url',
    risk: 'medium',
    handler: browserOpen,
  },
  'browser.navigate': {
    description: 'Navigate an existing session to a new URL. Params: sessionId, url',
    risk: 'medium',
    handler: browserNavigate,
  },
  'browser.click': {
    description: 'Click a CSS selector in a session. Params: sessionId, selector',
    risk: 'medium',
    handler: browserClick,
  },
  'browser.fill': {
    description: 'Fill a form field. Params: sessionId, selector, value',
    risk: 'medium',
    handler: browserFill,
  },
  'browser.text': {
    description: 'Extract text by selector (or whole page if omitted). Params: sessionId, selector?',
    risk: 'low',
    handler: browserText,
  },
  'browser.screenshot': {
    description: 'PNG screenshot of the page (base64). Params: sessionId, fullPage?',
    risk: 'low',
    handler: browserScreenshot,
  },
  'browser.evaluate': {
    description: 'Run JS expression in the page. Params: sessionId, expression',
    risk: 'medium',
    handler: browserEvaluate,
  },
  'browser.wait_for': {
    description: 'Wait for selector or load-state. Params: sessionId, selector? OR state? (load|domcontentloaded|networkidle), timeoutMs?',
    risk: 'low',
    handler: browserWaitFor,
  },
  'browser.list': {
    description: 'List active browser sessions.',
    risk: 'low',
    handler: browserList,
  },
  'browser.close': {
    description: 'Close a browser session. Params: sessionId',
    risk: 'low',
    handler: browserClose,
  },

  // ─── Desktop control ────────────────────────────────────────────
  'desktop.exec': {
    description: 'Run a shell command (timeout-bounded, captures stdout/stderr). Params: command, timeoutMs?, cwd?',
    risk: 'high',
    handler: desktopExec,
  },
  'desktop.read_file': {
    description: 'Read a file from disk (5 MB cap). Params: path',
    risk: 'low',
    handler: desktopReadFile,
  },
  'desktop.write_file': {
    description: 'Write a file (refuses protected paths). Params: path, content',
    risk: 'high',
    handler: desktopWriteFile,
  },
  'desktop.list_dir': {
    description: 'List a directory. Params: path',
    risk: 'low',
    handler: desktopListDir,
  },
  'desktop.open_app': {
    description: 'Launch an application or open a file via shell associations. Params: target',
    risk: 'medium',
    handler: desktopOpenApp,
  },
  'desktop.screenshot': {
    description: 'Screenshot the full desktop (PNG, base64). Windows only.',
    risk: 'low',
    handler: desktopScreenshot,
  },
  'desktop.processes': {
    description: 'List running processes. Params: filter? (substring match on name)',
    risk: 'low',
    handler: desktopProcesses,
  },
  'desktop.kill': {
    description: 'Kill a process by pid (cannot kill the API itself). Params: pid',
    risk: 'high',
    handler: desktopKill,
  },

  // ─── Round 104-105 wiring: vertical ops + governance ───────────
  'pod.pricing.recommend': {
    description: 'POD pricing: recommended retail given provider+product+channel+target margin. Params: provider, productType, channel, targetMarginPct',
    risk: 'low',
    handler: async (_ws, p) => {
      const { recommendPricing } = await import('./pod-pricing.js')
      return recommendPricing({
        provider:        p['provider'] as 'printful' | 'printify' | 'gelato' | 'spod' | 'gooten',
        productType:     p['productType'] as never,
        channel:         p['channel'] as never,
        targetMarginPct: Number(p['targetMarginPct'] ?? 0.30),
      })
    },
  },
  'pod.pricing.compare': {
    description: 'Compare COGS across providers for one product. Params: productType',
    risk: 'low',
    handler: async (_ws, p) => {
      const { compareProviders } = await import('./pod-pricing.js')
      return compareProviders({ productType: p['productType'] as never })
    },
  },
  'pod.pricing.bundle': {
    description: 'Bundle math (multi-item one-ship). Params: provider, items, bundleRetailUsd, channel',
    risk: 'low',
    handler: async (_ws, p) => {
      const { bundleMath } = await import('./pod-pricing.js')
      return bundleMath({
        provider:         p['provider'] as never,
        items:            p['items'] as never,
        bundleRetailUsd:  Number(p['bundleRetailUsd'] ?? 0),
        channel:          p['channel'] as never,
      })
    },
  },
  'agent.dispatch': {
    description: 'Dispatch a single persona from the agent team. Params: persona, task, context?, think?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { dispatchPersona } = await import('./agent-team.js')
      return dispatchPersona({
        workspaceId: ws,
        persona:     p['persona'] as never,
        task:        String(p['task'] ?? ''),
        context:     p['context'] ? String(p['context']) : '',
        think:       Boolean(p['think']),
      })
    },
  },
  'agent.list_personas': {
    description: 'List available agent personas.',
    risk: 'low',
    handler: async () => {
      const { listPersonas } = await import('./agent-team.js')
      return listPersonas()
    },
  },
  'policy.evaluate': {
    description: 'Evaluate a proposed action against the governance policy engine. Params: op, risk, caller, agentPersona?, approvalToken?, telemetry?',
    risk: 'low',
    handler: async (ws, p) => {
      const { evaluate } = await import('./policy-engine.js')
      return evaluate({
        op:            String(p['op'] ?? ''),
        risk:          p['risk'] as never,
        workspaceId:   ws,
        caller:        p['caller'] as never,
        params:        (p['params'] as Record<string, unknown>) ?? {},
        ...(p['agentPersona']      ? { agentPersona:  String(p['agentPersona'])   } : {}),
        ...(p['approvalToken']     ? { approvalToken: String(p['approvalToken']) } : {}),
        ...(p['telemetry']         ? { telemetry:     p['telemetry'] as never    } : {}),
        ...(p['moneyPatternDetected'] !== undefined ? { moneyPatternDetected: Boolean(p['moneyPatternDetected']) } : {}),
      })
    },
  },
  'policy.list_rules': {
    description: 'List active policy rules. Read-only governance view.',
    risk: 'low',
    handler: async () => {
      const { listRules } = await import('./policy-engine.js')
      return listRules()
    },
  },
  'memory.decay_sweep': {
    description: 'Run decay+prune sweep across this workspace memories. Params: graceDays?, halfLifeDays?, pruneThreshold?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { decaySweep } = await import('./memory-tiers.js')
      const cfg = {
        graceDays:       Number(p['graceDays']      ?? 7),
        halfLifeDays:    Number(p['halfLifeDays']   ?? 30),
        pruneThreshold:  Number(p['pruneThreshold'] ?? 0.10),
        perWorkspaceCap: Number(p['perWorkspaceCap']?? 10_000),
      }
      return decaySweep(ws, cfg)
    },
  },
  'memory.promote': {
    description: 'Pin a memory so it bypasses decay forever. Param: memoryId',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { promote } = await import('./memory-tiers.js')
      const id = String(p['memoryId'] ?? '')
      if (!id) throw new Error('memory.promote: memoryId required')
      return { promoted: await promote(id), memoryId: id }
    },
  },
  'business.budget.check': {
    description: 'Check per-business AI budget. Params: businessId?, proposedCostUsd?',
    risk: 'low',
    handler: async (ws, p) => {
      const { checkBusinessBudget } = await import('./business-budget.js')
      return checkBusinessBudget({
        workspaceId:     ws,
        ...(p['businessId']      ? { businessId:      String(p['businessId']) } : {}),
        ...(p['proposedCostUsd'] !== undefined ? { proposedCostUsd: Number(p['proposedCostUsd']) } : {}),
      })
    },
  },
  'postmortem.generate': {
    description: 'Auto-generate a structured post-mortem from an incident. Params: incidentId',
    risk: 'low',
    handler: async (_ws, p) => {
      const { generatePostmortem } = await import('./postmortem.js')
      const id = String(p['incidentId'] ?? '')
      if (!id) throw new Error('postmortem.generate: incidentId required')
      return generatePostmortem(id)
    },
  },

  // ─── Round 107-110 wiring: holding-co + sim + product factory + connectors ─
  'holding.allocate_capital': {
    description: 'Propose capital allocation across businesses. Params: allocationPoolUsd',
    risk: 'low',
    handler: async (ws, p) => {
      const { allocateCapital } = await import('./holding-co.js')
      return allocateCapital({ workspaceId: ws, allocationPoolUsd: Number(p['allocationPoolUsd'] ?? 0) })
    },
  },
  'holding.shared_services': {
    description: 'Detect shared-service consolidation opportunities across the portfolio.',
    risk: 'low',
    handler: async (ws) => {
      const { detectSharedServiceOpportunities } = await import('./holding-co.js')
      return detectSharedServiceOpportunities(ws)
    },
  },
  'holding.synergies': {
    description: 'Detect cross-business synergy signals (cross-sell, talent, customer overlap).',
    risk: 'low',
    handler: async (ws) => {
      const { detectSynergies } = await import('./holding-co.js')
      return detectSynergies(ws)
    },
  },
  'holding.portfolio_strategy': {
    description: 'Propose double-down / maintain / sunset / pivot per business.',
    risk: 'medium',
    handler: async (ws) => {
      const { portfolioStrategy } = await import('./holding-co.js')
      return portfolioStrategy(ws)
    },
  },
  'sim.dry_run': {
    description: 'Execute a proposed plan in dry-run mode. Params: plan (array of {op, params, risk?}), caller?',
    risk: 'low',
    handler: async (ws, p) => {
      const { dryRun } = await import('./simulation.js')
      return dryRun({
        workspaceId: ws,
        caller:      (p['caller'] as 'operator' | 'agent' | 'cron' | 'mcp' | 'session') ?? 'operator',
        plan:        (p['plan'] as Array<{ op: string; params?: Record<string, unknown>; risk?: 'low' | 'medium' | 'high' | 'critical' }>) ?? [],
      })
    },
  },
  'sim.counterfactual': {
    description: 'Re-evaluate a past decision under an alternative branch. Params: chainId, alternative {op?, params?, persona?, risk?}, rerunPersona?',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { counterfactual } = await import('./simulation.js')
      return counterfactual({
        chainId:       String(p['chainId'] ?? ''),
        alternative:   (p['alternative'] as never) ?? {},
        caller:        (p['caller'] as 'operator' | 'agent' | 'cron' | 'mcp' | 'session') ?? 'operator',
        rerunPersona:  Boolean(p['rerunPersona']),
      })
    },
  },
  'product.idea.capture': {
    description: 'Capture a new product idea with provenance + initial scoring. Params: title, description, provenance, signalSourceRef?',
    risk: 'low',
    handler: async (ws, p) => {
      const { captureIdea } = await import('./product-factory.js')
      return captureIdea({
        workspaceId:     ws,
        title:           String(p['title'] ?? ''),
        description:     String(p['description'] ?? ''),
        provenance:      (p['provenance'] as never) ?? 'operator',
        ...(p['signalSourceRef'] ? { signalSourceRef: String(p['signalSourceRef']) } : {}),
      })
    },
  },
  'product.validation_gate': {
    description: 'Run the kill-or-proceed gate. Params: idea (object), evidence (object).',
    risk: 'low',
    handler: async (_ws, p) => {
      const { evaluateValidationGate } = await import('./product-factory.js')
      return evaluateValidationGate({
        idea:     p['idea']     as never,
        evidence: (p['evidence'] as never) ?? {},
      })
    },
  },
  'product.prd_generate': {
    description: 'Generate a PRD draft from a validated idea. Params: idea (object).',
    risk: 'low',
    handler: async (_ws, p) => {
      const { generatePRD } = await import('./product-factory.js')
      return generatePRD({ idea: p['idea'] as never })
    },
  },
  'product.launch_checklist': {
    description: 'Get the launch checklist for a product. Params: productTitle.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { launchChecklist } = await import('./product-factory.js')
      return launchChecklist(String(p['productTitle'] ?? 'untitled product'))
    },
  },
  'product.sunset_propose': {
    description: 'Build a sunset proposal. Params: productId, reasons, hasContracts?, hasUserData?',
    risk: 'high',
    handler: async (_ws, p) => {
      const { proposeSunset } = await import('./product-factory.js')
      return proposeSunset({
        productId:    String(p['productId']    ?? ''),
        reasons:      (p['reasons'] as string[]) ?? [],
        hasContracts: Boolean(p['hasContracts']),
        hasUserData:  Boolean(p['hasUserData']),
      })
    },
  },
  'connector.list': {
    description: 'List available platform connectors + which env vars they need.',
    risk: 'low',
    handler: async () => {
      const { listConnectorSpecs } = await import('./connector-base.js')
      return listConnectorSpecs()
    },
  },
  'connector.oauth_url': {
    description: 'Build the OAuth authorise URL for a connector. Params: connectorId, redirectUri, state, extraParams?',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { getConnectorSpec, buildOAuthAuthorizeUrl } = await import('./connector-base.js')
      const spec = getConnectorSpec(String(p['connectorId'] ?? ''))
      if (!spec) return { error: 'unknown connector' }
      return buildOAuthAuthorizeUrl({
        spec,
        redirectUri:  String(p['redirectUri'] ?? ''),
        state:        String(p['state'] ?? ''),
        ...(p['extraParams'] ? { extraParams: p['extraParams'] as Record<string, string> } : {}),
      })
    },
  },
  // R146.85 — operator-facing "pull up the right URL to connect this platform".
  // Returns the catalog metadata + an ordered checklist of URLs the operator
  // must visit in their browser. The chat UI consumes the response as a
  // `browser.open` action set: each step gets a click-to-open link rendered
  // inline in the operator's reply, so they tap once and land on the right
  // page (signup if they don't have an account, login then API-key page if
  // they do, OAuth-authorize if it's an OAuth connector). The brain MUST
  // NOT enter credentials itself — global CLAUDE.md rules forbid it.
  'connector.setup_links': {
    description: 'Get the ordered list of browser URLs an operator must visit to connect a platform (signup/login/api-key/oauth). Params: connectorId (e.g. "mailchimp", "x-twitter", "printful")',
    risk: 'low',
    handler: async (_ws, p) => {
      const id = String(p['connectorId'] ?? '').trim()
      if (!id) throw new Error('connector.setup_links: connectorId required')
      const { CATALOG } = await import('./connector-catalog/index.js')
      const def = CATALOG.find(d => d.id === id)
      if (!def) {
        return {
          ok: false,
          error: `unknown connector '${id}'`,
          available: CATALOG.map(d => d.id),
        }
      }
      const steps: Array<{ step: number; label: string; url: string; required: boolean; openInNewTab: boolean }> = []
      let step = 1
      // Step 1 — signup if needed (skip if operator likely already has account)
      if (def.signupUrl) {
        steps.push({
          step: step++,
          label: `Sign up for ${def.name} (skip if you already have an account)`,
          url: def.signupUrl,
          required: false,
          openInNewTab: true,
        })
      }
      // Step 2 — login
      if (def.loginUrl) {
        steps.push({
          step: step++,
          label: `Log in to ${def.name}`,
          url: def.loginUrl,
          required: true,
          openInNewTab: true,
        })
      }
      // Step 3 — auth-credential creation, branches on authType
      if (def.authType === 'api_key' && def.apiKeyCreationUrl) {
        steps.push({
          step: step++,
          label: `Generate a ${def.name} API key (copy it to your clipboard)`,
          url: def.apiKeyCreationUrl,
          required: true,
          openInNewTab: true,
        })
      } else if (def.authType === 'oauth' && def.apiKeyCreationUrl) {
        // For OAuth connectors apiKeyCreationUrl is usually the developer-
        // app registration page (operator creates an app to get client_id +
        // client_secret). The Novan-side OAuth flow handles the rest.
        steps.push({
          step: step++,
          label: `Register a developer app on ${def.name} to get client_id + client_secret`,
          url: def.apiKeyCreationUrl,
          required: true,
          openInNewTab: true,
        })
      }
      return {
        ok: true,
        connector: {
          id:                    def.id,
          name:                  def.name,
          category:              def.category,
          authType:              def.authType,
          permissionExplanation: def.permissionExplanation,
          freeTierAvailable:     def.freeTierAvailable,
          docsUrl:               def.docsUrl,
          pricingUrl:            def.pricingUrl,
        },
        steps,
        // Frontend hint: render each step's url as a clickable button that
        // calls window.open(url, '_blank'). The chat UI's action-renderer
        // already supports `browser.open` action; this op's response shape
        // is consumed by novan-chat's tool-result formatter.
        renderHint: 'browser-open-checklist',
      }
    },
  },

  // ─── Round 112-114 wiring: coding-topology + pipeline-adapters + cartographer + curator + ai-product-agents ─
  'coding.run_full_flow': {
    description: 'Run PM → TechLead → Specialists → Integration → Release on a signal. Params: signalSummary, rolloutPolicy?, codebaseSlice?',
    risk: 'high',
    handler: async (ws, p) => {
      const { runFullCodingFlow } = await import('./coding-topology.js')
      return runFullCodingFlow({
        workspaceId:    ws,
        signalSummary:  String(p['signalSummary'] ?? ''),
        ...(p['rolloutPolicy']  ? { rolloutPolicy:  p['rolloutPolicy'] as 'fast' | 'standard' | 'cautious' } : {}),
        ...(p['codebaseSlice']  ? { codebaseSlice:  String(p['codebaseSlice']) } : {}),
      })
    },
  },
  'coding.pm_spec': {
    description: 'Run the Product Manager Agent only. Params: signalSummary, quantifiedImpact?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { runProductManager } = await import('./coding-topology.js')
      return runProductManager({
        workspaceId:    ws,
        signalSummary:  String(p['signalSummary'] ?? ''),
        ...(p['quantifiedImpact'] ? { quantifiedImpact: p['quantifiedImpact'] as Record<string, unknown> } : {}),
      })
    },
  },
  'coding.tech_lead_plan': {
    description: 'Run the Tech Lead Agent (frontier reasoning). Params: spec, codebaseSlice?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { runTechLead } = await import('./coding-topology.js')
      return runTechLead({
        workspaceId: ws,
        spec:        p['spec'] as never,
        ...(p['codebaseSlice'] ? { codebaseSlice: String(p['codebaseSlice']) } : {}),
      })
    },
  },
  'coding.detect_rollout_incident': {
    description: 'SRE Agent: decide whether current rollout metrics constitute an incident. Params: rolloutStage, metrics',
    risk: 'low',
    handler: async (_ws, p) => {
      const { detectIncidentFromRollout } = await import('./coding-topology.js')
      return detectIncidentFromRollout({
        rolloutStage: String(p['rolloutStage'] ?? ''),
        metrics:      p['metrics'] as never,
      })
    },
  },
  'pipeline.adapter': {
    description: 'Get pipeline adapter (preMergeChecks, validationMatrix, rolloutStages, specialistAgents, criticalRisks) for a product type. Params: type',
    risk: 'low',
    handler: async (_ws, p) => {
      const { getPipelineAdapter } = await import('./pipeline-adapters.js')
      return getPipelineAdapter(p['type'] as never)
    },
  },
  'pipeline.list_adapters': {
    description: 'List all pipeline adapters (web / mobile_ios / mobile_android / mobile_rn / ai_product / embedded_firmware / browser_extension / desktop / api_sdk).',
    risk: 'low',
    handler: async () => {
      const { listPipelineAdapters } = await import('./pipeline-adapters.js')
      return listPipelineAdapters()
    },
  },
  'cartographer.snapshot': {
    description: 'Generate a fresh codebase map (roles, hot imports, fragile files, idioms). Params: rootPath?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { generateSnapshot } = await import('./codebase-cartographer.js')
      return generateSnapshot(p['rootPath'] ? String(p['rootPath']) : undefined)
    },
  },
  'cartographer.find_relevant': {
    description: 'Find files most relevant to a query. Params: query, rootPath?, maxFiles?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { findRelevantFiles } = await import('./codebase-cartographer.js')
      return findRelevantFiles({
        query:    String(p['query'] ?? ''),
        ...(p['rootPath'] ? { rootPath: String(p['rootPath']) } : {}),
        ...(p['maxFiles'] !== undefined ? { maxFiles: Number(p['maxFiles']) } : {}),
      })
    },
  },
  'knowledge.curate': {
    description: 'Surface proposed patterns extracted from recent prompt wins + postmortems + decisions. Params: days?',
    risk: 'low',
    handler: async (ws, p) => {
      const { curate } = await import('./knowledge-curator.js')
      return curate(ws, p['days'] !== undefined ? { days: Number(p['days']) } : undefined)
    },
  },
  'knowledge.approve_pattern': {
    description: 'Approve a curated pattern. Params: patternId, approvedBy, patternData',
    risk: 'medium',
    handler: async (ws, p) => {
      const { approvePattern } = await import('./knowledge-curator.js')
      await approvePattern({
        workspaceId: ws,
        patternId:   String(p['patternId'] ?? ''),
        approvedBy:  String(p['approvedBy'] ?? 'operator'),
        patternData: p['patternData'] as never,
      })
      return { ok: true }
    },
  },
  'ai_product.recommend_tier': {
    description: 'Cost Optimizer: pick cheapest passing model tier. Params: perTierPassRate, tolerancePct?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { recommendTier } = await import('./ai-product-agents.js')
      return recommendTier({
        perTierPassRate: p['perTierPassRate'] as never,
        tolerancePct:    Number(p['tolerancePct'] ?? 0.05),
      })
    },
  },
  'ai_product.detect_cost_drift': {
    description: 'Cost Optimizer: detect cost-per-request drift. Params: baselineCostPerRequest, recentCostPerRequest, driftTolerancePct?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { detectCostDrift } = await import('./ai-product-agents.js')
      return detectCostDrift({
        baselineCostPerRequest: Number(p['baselineCostPerRequest'] ?? 0),
        recentCostPerRequest:   Number(p['recentCostPerRequest'] ?? 0),
        ...(p['driftTolerancePct'] !== undefined ? { driftTolerancePct: Number(p['driftTolerancePct']) } : {}),
      })
    },
  },

  // ─── Round 120-122 wiring: eval-system + hil-orchestrator + curator-v2 ─
  'eval.ci_gate': {
    description: 'Run all relevant eval sets against a producer and return blocking/non-blocking verdict. Caller supplies a produce function via remote MCP only (here we exercise a placeholder fn).',
    risk: 'medium',
    handler: async (ws, p) => {
      const { ciGateEval } = await import('./eval-system.js')
      // The CI gate needs an actual producer; from brain.task we
      // exercise it against a no-op placeholder. Real CI integration
      // injects a producer via the test runner.
      return ciGateEval({
        workspaceId: ws,
        trigger:     String(p['trigger'] ?? 'manual'),
        produce:     async (input: string) => `(placeholder candidate for ${input.slice(0, 40)})`,
        ...(Array.isArray(p['evalSetIds']) ? { evalSetIds: p['evalSetIds'] as string[] } : {}),
      })
    },
  },
  'eval.production_sample': {
    description: 'Sample recent assistant messages and grade them. Params: hours?, sampleRate?, maxSamples?, rubric (object)',
    risk: 'low',
    handler: async (ws, p) => {
      const { sampleProductionTraffic } = await import('./eval-system.js')
      return sampleProductionTraffic({
        workspaceId: ws,
        ...(p['hours']      !== undefined ? { hours:      Number(p['hours']) } : {}),
        ...(p['sampleRate'] !== undefined ? { sampleRate: Number(p['sampleRate']) } : {}),
        ...(p['maxSamples'] !== undefined ? { maxSamples: Number(p['maxSamples']) } : {}),
        rubric: (p['rubric'] as never) ?? { expectedBehavior: 'helpful, grounded, and within Novan policy' },
      })
    },
  },
  'eval.detect_drift': {
    description: 'Compare recent output distribution to baseline. Params: recentWindowHours?, baselineWindowHours?, driftThresholdPct?',
    risk: 'low',
    handler: async (ws, p) => {
      const { detectDrift } = await import('./eval-system.js')
      return detectDrift({
        workspaceId: ws,
        ...(p['recentWindowHours']   !== undefined ? { recentWindowHours:   Number(p['recentWindowHours']) } : {}),
        ...(p['baselineWindowHours'] !== undefined ? { baselineWindowHours: Number(p['baselineWindowHours']) } : {}),
        ...(p['driftThresholdPct']   !== undefined ? { driftThresholdPct:   Number(p['driftThresholdPct']) } : {}),
      })
    },
  },
  // R139 — exposed for operator convenience: seed the 4 starter eval sets
  // (golden/regression/safety/honesty) when the workspace was created
  // before R5's auto-seed wired into POST /workspaces. Idempotent.
  'eval.seed': {
    description: 'Seed the 4 starter chat eval sets (golden / regression / safety / honesty). Idempotent — re-running skips already-present sets.',
    risk: 'low',
    handler: async (ws) => {
      const { seedChatEvals } = await import('./eval-seed-chat.js')
      return seedChatEvals(ws)
    },
  },
  // R139 — self-improvement health snapshot via brain-task.
  'self.health': {
    description: 'Run all 5 self-improvement pathology detectors (Goodhart, capability narrowing, coordination drift, compounding errors, reward hacking). Returns overall verdict + per-detector status.',
    risk: 'low',
    handler: async (ws) => {
      const { runAllImprovementHealthChecks } = await import('./self-improvement.js')
      return runAllImprovementHealthChecks(ws)
    },
  },
  'self.maturity': {
    description: 'Assess the platform maturity stage (0–5) for this workspace. Returns currentStage + per-stage signal reports.',
    risk: 'low',
    handler: async (ws) => {
      const { assessMaturity } = await import('./maturity-stage.js')
      return assessMaturity(ws)
    },
  },
  'hil.register_station': {
    description: 'Register a HIL station with its capabilities. Params: label, capabilities',
    risk: 'medium',
    handler: async (ws, p) => {
      const { registerStation } = await import('./hil-orchestrator.js')
      return registerStation({
        workspaceId:  ws,
        label:        String(p['label'] ?? ''),
        capabilities: p['capabilities'] as never,
      })
    },
  },
  'hil.list_stations': {
    description: 'List all registered HIL stations.',
    risk: 'low',
    handler: async () => {
      const { listStations } = await import('./hil-orchestrator.js')
      return listStations()
    },
  },
  'hil.submit_job': {
    description: 'Submit a HIL job. Params: firmwareRef, firmwareSha, testPlanRef, requirements, category, risk',
    risk: 'medium',
    handler: async (ws, p) => {
      const { submitJob } = await import('./hil-orchestrator.js')
      return submitJob({
        workspaceId:  ws,
        firmwareRef:  String(p['firmwareRef']  ?? ''),
        firmwareSha:  String(p['firmwareSha']  ?? ''),
        testPlanRef:  String(p['testPlanRef']  ?? ''),
        requirements: (p['requirements'] as never) ?? {},
        category:     (p['category']     as never) ?? 'capability',
        risk:         (p['risk']         as never) ?? 'medium',
      })
    },
  },
  'hil.traceability_matrix': {
    description: 'Generate a compliance traceability matrix for a firmware build. Params: firmwareSha, certifications?',
    risk: 'low',
    handler: async (ws, p) => {
      const { generateTraceabilityMatrix } = await import('./hil-orchestrator.js')
      return generateTraceabilityMatrix({
        workspaceId: ws,
        firmwareSha: String(p['firmwareSha'] ?? ''),
        ...(Array.isArray(p['certifications']) ? { certifications: p['certifications'] as string[] } : {}),
      })
    },
  },
  'hil.ota_staging': {
    description: 'Return the default OTA campaign staging plan for a policy. Params: policy=cautious|standard|fast',
    risk: 'low',
    handler: async (_ws, p) => {
      const { defaultOtaStaging } = await import('./hil-orchestrator.js')
      return defaultOtaStaging((p['policy'] as 'cautious' | 'standard' | 'fast') ?? 'standard')
    },
  },
  'knowledge.periodic_review': {
    description: 'Run the full curator cycle: detect triggers, validate, propose, deprecate low-trust, flag contradictions.',
    risk: 'low',
    handler: async (ws) => {
      const { runPeriodicReview } = await import('./knowledge-curator-v2.js')
      return runPeriodicReview(ws)
    },
  },
  'knowledge.detect_contradictions': {
    description: 'Surface contradictions in the approved-patterns library for operator resolution.',
    risk: 'low',
    handler: async (ws) => {
      const { detectContradictions } = await import('./knowledge-curator-v2.js')
      return detectContradictions({ workspaceId: ws })
    },
  },
  'knowledge.retrieve_for_task': {
    description: 'Retrieve the most-relevant approved patterns for a task. Params: persona, taskKeywords[], maxEntries?',
    risk: 'low',
    handler: async (ws, p) => {
      const { retrieveForTask } = await import('./knowledge-curator-v2.js')
      return retrieveForTask({
        workspaceId:  ws,
        persona:      String(p['persona'] ?? 'all'),
        taskKeywords: Array.isArray(p['taskKeywords']) ? (p['taskKeywords'] as string[]) : [],
        ...(p['maxEntries'] !== undefined ? { maxEntries: Number(p['maxEntries']) } : {}),
      })
    },
  },
  'knowledge.record_outcome': {
    description: 'Record an outcome for a knowledge entry so curator can adjust trust. Params: patternId, followed, good',
    risk: 'low',
    handler: async (ws, p) => {
      const { recordKnowledgeOutcome } = await import('./knowledge-curator-v2.js')
      await recordKnowledgeOutcome({
        workspaceId: ws,
        patternId:   String(p['patternId'] ?? ''),
        followed:    Boolean(p['followed']),
        good:        Boolean(p['good']),
      })
      return { ok: true }
    },
  },
  'knowledge.aggregate_trust': {
    description: 'Get current trust counts + score for a knowledge entry. Params: patternId',
    risk: 'low',
    handler: async (ws, p) => {
      const { aggregateTrust } = await import('./knowledge-curator-v2.js')
      return aggregateTrust({ workspaceId: ws, patternId: String(p['patternId'] ?? '') })
    },
  },
  'knowledge.propose_prompt_patch': {
    description: 'Propose a persona-prompt patch from a high-trust knowledge entry. Params: patternId, persona',
    risk: 'medium',
    handler: async (ws, p) => {
      const { proposePersonaPromptPatch } = await import('./knowledge-curator-v2.js')
      return proposePersonaPromptPatch({
        workspaceId: ws,
        patternId:   String(p['patternId'] ?? ''),
        persona:     String(p['persona']   ?? ''),
      })
    },
  },

  // ─── Round 124-125 wiring: agent-coordination + maturity tracker ─
  'coord.blackboard_write': {
    description: 'Append an entry to a shared blackboard. Params: boardKey, agentId, kind, content, confidence, conflictsWith?',
    risk: 'low',
    handler: async (ws, p) => {
      const { blackboardWrite } = await import('./agent-coordination.js')
      return blackboardWrite({
        workspaceId: ws,
        boardKey:    String(p['boardKey'] ?? ''),
        agentId:     String(p['agentId']  ?? ''),
        kind:        (p['kind'] as never) ?? 'claim',
        content:     String(p['content'] ?? ''),
        confidence:  Number(p['confidence'] ?? 0.7),
        ...(p['conflictsWith'] ? { conflictsWith: String(p['conflictsWith']) } : {}),
      })
    },
  },
  'coord.blackboard_read': {
    description: 'Read all entries on a shared blackboard (append-only). Params: boardKey, limit?',
    risk: 'low',
    handler: async (ws, p) => {
      const { blackboardRead } = await import('./agent-coordination.js')
      return blackboardRead({
        workspaceId: ws,
        boardKey:    String(p['boardKey'] ?? ''),
        ...(p['limit'] !== undefined ? { limit: Number(p['limit']) } : {}),
      })
    },
  },
  'coord.detect_inconsistencies': {
    description: 'Detect hallucination-cascade candidates on a blackboard. Params: boardKey',
    risk: 'low',
    handler: async (ws, p) => {
      const { blackboardDetectInconsistencies } = await import('./agent-coordination.js')
      return blackboardDetectInconsistencies({ workspaceId: ws, boardKey: String(p['boardKey'] ?? '') })
    },
  },
  'coord.should_escalate': {
    description: 'Check whether current spend triggers escalation. Params: budget, consumed',
    risk: 'low',
    handler: async (_ws, p) => {
      const { shouldEscalate } = await import('./agent-coordination.js')
      return shouldEscalate({ budget: p['budget'] as never, consumed: p['consumed'] as never })
    },
  },
  'coord.detect_loop': {
    description: 'Detect identical-call loop. Params: agentId, action, args',
    risk: 'low',
    handler: async (_ws, p) => {
      const { detectIdenticalLoop } = await import('./agent-coordination.js')
      return detectIdenticalLoop({
        agentId: String(p['agentId'] ?? ''),
        action:  String(p['action']  ?? ''),
        args:    (p['args'] as Record<string, unknown>) ?? {},
      })
    },
  },
  'coord.detect_stalled': {
    description: 'Check for stalled progress / diverging from baseline. Params: originalSpec, prevState, currentState',
    risk: 'low',
    handler: async (_ws, p) => {
      const { detectStalledProgress } = await import('./agent-coordination.js')
      return detectStalledProgress({
        originalSpec: String(p['originalSpec'] ?? ''),
        prevState:    String(p['prevState']    ?? ''),
        currentState: String(p['currentState'] ?? ''),
      })
    },
  },
  'coord.adversarial_review': {
    description: 'Run an adversarial reviewer (different-family model) on a producer output. Params: producerOutput, originalSpec, reviewerProvider?, checkCategories?',
    risk: 'medium',
    handler: async (ws, p) => {
      const { adversarialReview } = await import('./agent-coordination.js')
      return adversarialReview({
        workspaceId:    ws,
        producerOutput: String(p['producerOutput'] ?? ''),
        originalSpec:   String(p['originalSpec']   ?? ''),
        ...(p['reviewerProvider'] ? { reviewerProvider: String(p['reviewerProvider']) } : {}),
        ...(Array.isArray(p['checkCategories']) ? { checkCategories: p['checkCategories'] as never } : {}),
      })
    },
  },
  'coord.resolve_authority': {
    description: 'Resolve required authority tier for an action. Params: agentId, actionRisk, actionReversible, blastRadius',
    risk: 'low',
    handler: async (ws, p) => {
      const { resolveAuthority } = await import('./agent-coordination.js')
      return resolveAuthority({
        workspaceId:       ws,
        agentId:           String(p['agentId'] ?? ''),
        actionRisk:        (p['actionRisk'] as never) ?? 'low',
        actionReversible:  Boolean(p['actionReversible']),
        blastRadius:       (p['blastRadius'] as never) ?? 'isolated',
      })
    },
  },
  'maturity.assess': {
    description: 'Assess Novan maturity stage 0-5 against the operator-spec build sequence; returns current stage + per-stage signals + next actions.',
    risk: 'low',
    handler: async (ws) => {
      const { assessMaturity } = await import('./maturity-stage.js')
      return assessMaturity(ws)
    },
  },
  'maturity.business_capabilities': {
    description: 'Get capability map (brainExcelsAt / humansEssentialFor / stack / risks) for a business type. Params: type=ecommerce|saas|creator|pod|mixed',
    risk: 'low',
    handler: async (_ws, p) => {
      const { getBusinessCapabilityMap } = await import('./maturity-stage.js')
      return getBusinessCapabilityMap((p['type'] as never) ?? 'mixed')
    },
  },

  // ─── Round 126-127 wiring: self-improvement + staffing + financial ─
  'improve.check_locked_core': {
    description: 'Check whether a proposed change touches locked-core paths. Params: affectedFiles[], opName?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { checkLockedCore } = await import('./self-improvement.js')
      return checkLockedCore({
        affectedFiles: Array.isArray(p['affectedFiles']) ? (p['affectedFiles'] as string[]) : [],
        ...(p['opName'] ? { opName: String(p['opName']) } : {}),
      })
    },
  },
  'improve.propose': {
    description: 'Create an improvement proposal. Refuses locked-core paths. Params: dimension, hypothesis, affectedFiles[]',
    risk: 'medium',
    handler: async (ws, p) => {
      const { proposeImprovement } = await import('./self-improvement.js')
      return proposeImprovement({
        workspaceId:   ws,
        dimension:     (p['dimension'] as never) ?? 'knowledge',
        hypothesis:    String(p['hypothesis'] ?? ''),
        affectedFiles: Array.isArray(p['affectedFiles']) ? (p['affectedFiles'] as string[]) : [],
      })
    },
  },
  'improve.transition': {
    description: 'Transition a proposal to next lifecycle stage. Params: proposalId, toStage, approvedBy, note?',
    risk: 'high',
    handler: async (ws, p) => {
      const { transitionProposal } = await import('./self-improvement.js')
      return transitionProposal({
        workspaceId: ws,
        proposalId:  String(p['proposalId'] ?? ''),
        toStage:     (p['toStage'] as never) ?? 'abandoned',
        approvedBy:  String(p['approvedBy'] ?? 'operator'),
        ...(p['note'] ? { note: String(p['note']) } : {}),
      })
    },
  },
  'improve.health_check': {
    description: 'Run all 5 self-improvement pathology detectors. Returns verdict + per-detector findings.',
    risk: 'low',
    handler: async (ws) => {
      const { runAllImprovementHealthChecks } = await import('./self-improvement.js')
      return runAllImprovementHealthChecks(ws)
    },
  },
  'improve.detect_goodhart': {
    description: 'Compare an optimised metric to ground-truth metrics. Params: optimisedMetric, groundTruthMetrics[], divergenceThresholdPct?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { detectGoodhartDrift } = await import('./self-improvement.js')
      return detectGoodhartDrift({
        optimisedMetric:   p['optimisedMetric']   as never,
        groundTruthMetrics: (p['groundTruthMetrics'] as never) ?? [],
        ...(p['divergenceThresholdPct'] !== undefined ? { divergenceThresholdPct: Number(p['divergenceThresholdPct']) } : {}),
      })
    },
  },
  'staffing.plan': {
    description: 'Recommend team composition for a given maturity stage. Params: currentStage (0-5), businessCount?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { planStaffing } = await import('./staffing-planner.js')
      return planStaffing(Number(p['currentStage'] ?? 0) as never, Number(p['businessCount'] ?? 1))
    },
  },
  'financial.project': {
    description: 'Project burn / revenue / break-even / unit economics. Params: monthIndex, teamSize, averageTotalCompUsd, businessCount, monthlyInferenceUsd, monthlyInfraUsd, avgMonthlyRevenuePerBusinessUsd, configuration',
    risk: 'low',
    handler: async (_ws, p) => {
      const { projectFinancials } = await import('./financial-model.js')
      return projectFinancials({
        monthIndex:                       Number(p['monthIndex']                       ?? 1),
        teamSize:                         Number(p['teamSize']                         ?? 5),
        averageTotalCompUsd:              Number(p['averageTotalCompUsd']              ?? 220_000),
        businessCount:                    Number(p['businessCount']                    ?? 1),
        monthlyInferenceUsd:              Number(p['monthlyInferenceUsd']              ?? 5_000),
        monthlyInfraUsd:                  Number(p['monthlyInfraUsd']                  ?? 12_000),
        avgMonthlyRevenuePerBusinessUsd:  Number(p['avgMonthlyRevenuePerBusinessUsd']  ?? 10_000),
        configuration:                    (p['configuration'] as never) ?? 'many_small_businesses',
      })
    },
  },
  'financial.cost_destroyers': {
    description: 'List the 5 common cost-destruction patterns the spec calls out.',
    risk: 'low',
    handler: async () => {
      const { COST_DESTROYERS } = await import('./financial-model.js')
      return COST_DESTROYERS
    },
  },
  'financial.viable_configurations': {
    description: 'List configurations the spec identifies as where the math actually works + ones where it doesn\'t.',
    risk: 'low',
    handler: async () => {
      const { VIABLE_CONFIGURATIONS, NON_VIABLE_CONFIGURATIONS, PAYBACK_ACCELERATORS } = await import('./financial-model.js')
      return { viable: VIABLE_CONFIGURATIONS, nonViable: NON_VIABLE_CONFIGURATIONS, accelerators: PAYBACK_ACCELERATORS }
    },
  },

  // ─── Round 129 wiring: Etsy connector ops ───────────────────────
  'etsy.list_listings': {
    description: 'List Etsy listings on a shop. Params: accessToken, shopId, filters?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listListings } = await import('./connector-etsy.js')
      return listListings({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        shopId:      String(p['shopId'] ?? ''),
        ...(p['filters'] ? { filters: p['filters'] as never } : {}),
      })
    },
  },
  'etsy.create_listing': {
    description: 'Create an Etsy draft listing. Requires approval. Params: accessToken, shopId, title, description, priceUsd, whoMade, whenMade, taxonomyId, tags?, materials?, etc., approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { createDraftListing } = await import('./connector-etsy.js')
      return createDraftListing({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        shopId:         String(p['shopId'] ?? ''),
        title:          String(p['title'] ?? ''),
        description:    String(p['description'] ?? ''),
        priceUsd:       Number(p['priceUsd'] ?? 0),
        whoMade:        (p['whoMade'] as never) ?? 'i_did',
        whenMade:       String(p['whenMade'] ?? '2020_2025'),
        taxonomyId:     Number(p['taxonomyId'] ?? 0),
        ...(Array.isArray(p['tags'])      ? { tags:      p['tags']      as string[] } : {}),
        ...(Array.isArray(p['materials']) ? { materials: p['materials'] as string[] } : {}),
        ...(p['shippingProfileId'] !== undefined ? { shippingProfileId: Number(p['shippingProfileId']) } : {}),
        ...(p['quantity']          !== undefined ? { quantity:          Number(p['quantity'])          } : {}),
        ...(p['isSupply']          !== undefined ? { isSupply:          Boolean(p['isSupply'])         } : {}),
        ...(p['isCustomizable']    !== undefined ? { isCustomizable:    Boolean(p['isCustomizable'])   } : {}),
        ...(p['isPersonalizable']  !== undefined ? { isPersonalizable:  Boolean(p['isPersonalizable']) } : {}),
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },
  'etsy.update_listing': {
    description: 'Update an Etsy listing. Requires approval. Params: accessToken, shopId, listingId, title?, description?, priceUsd?, quantity?, tags?, materials?, state?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { updateListing } = await import('./connector-etsy.js')
      return updateListing({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        shopId:         String(p['shopId'] ?? ''),
        listingId:      String(p['listingId'] ?? ''),
        ...(p['title']       !== undefined ? { title:       String(p['title'])       } : {}),
        ...(p['description'] !== undefined ? { description: String(p['description']) } : {}),
        ...(p['priceUsd']    !== undefined ? { priceUsd:    Number(p['priceUsd'])    } : {}),
        ...(p['quantity']    !== undefined ? { quantity:    Number(p['quantity'])    } : {}),
        ...(Array.isArray(p['tags'])      ? { tags:      p['tags']      as string[] } : {}),
        ...(Array.isArray(p['materials']) ? { materials: p['materials'] as string[] } : {}),
        ...(p['state']       !== undefined ? { state:       p['state'] as never     } : {}),
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },
  'etsy.list_orders': {
    description: 'List Etsy orders. Params: accessToken, shopId, state?, limit?, offset?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listOrders } = await import('./connector-etsy.js')
      return listOrders({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        shopId:      String(p['shopId'] ?? ''),
        ...(p['state']  !== undefined ? { state:  p['state'] as never } : {}),
        ...(p['limit']  !== undefined ? { limit:  Number(p['limit'])  } : {}),
        ...(p['offset'] !== undefined ? { offset: Number(p['offset']) } : {}),
      })
    },
  },
  'etsy.list_reviews': {
    description: 'List Etsy reviews on a shop or listing. Params: accessToken, shopId, listingId?, limit?, offset?, minCreated?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listReviews } = await import('./connector-etsy.js')
      return listReviews({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        shopId:      String(p['shopId'] ?? ''),
        ...(p['listingId']  ? { listingId:  String(p['listingId']) }  : {}),
        ...(p['limit']      !== undefined ? { limit:      Number(p['limit'])      } : {}),
        ...(p['offset']     !== undefined ? { offset:     Number(p['offset'])     } : {}),
        ...(p['minCreated'] !== undefined ? { minCreated: Number(p['minCreated']) } : {}),
      })
    },
  },

  // ─── Round 131-133 wiring: shortform + acquisition + compliance ─
  'shortform.hook_patterns': {
    description: 'List the catalog of short-form hook patterns.',
    risk: 'low',
    handler: async () => {
      const { listHookPatterns } = await import('./shortform-engine.js')
      return listHookPatterns()
    },
  },
  'shortform.score_hook': {
    description: 'Score a proposed hook. Params: hookText, platform, niche',
    risk: 'low',
    handler: async (_ws, p) => {
      const { scoreHook } = await import('./shortform-engine.js')
      return scoreHook({
        hookText: String(p['hookText'] ?? ''),
        platform: (p['platform'] as never) ?? 'tiktok',
        niche:    String(p['niche']    ?? ''),
      })
    },
  },
  'shortform.evaluate_trend': {
    description: 'Evaluate whether a trend signal is worth riding. Params: trend, channelNiche, productionLeadHours',
    risk: 'low',
    handler: async (_ws, p) => {
      const { evaluateTrend } = await import('./shortform-engine.js')
      return evaluateTrend({
        trend:               p['trend'] as never,
        channelNiche:        String(p['channelNiche'] ?? ''),
        productionLeadHours: Number(p['productionLeadHours'] ?? 24),
      })
    },
  },
  'shortform.mine_clips': {
    description: 'Mine high-engagement clips from a long-form transcript. Params: transcript[], maxClips?, targetDurationSec?',
    risk: 'low',
    handler: async (_ws, p) => {
      const { mineClips } = await import('./shortform-engine.js')
      return mineClips({
        transcript: (p['transcript'] as never) ?? [],
        ...(p['maxClips']           !== undefined ? { maxClips:          Number(p['maxClips']) } : {}),
        ...(p['targetDurationSec']  !== undefined ? { targetDurationSec: Number(p['targetDurationSec']) } : {}),
      })
    },
  },
  'shortform.triage_performance': {
    description: 'Triage early-performance signal. Params: perf, platform, channelBaseline',
    risk: 'low',
    handler: async (_ws, p) => {
      const { triagePerformance } = await import('./shortform-engine.js')
      return triagePerformance({
        perf:             p['perf'] as never,
        platform:         (p['platform'] as never) ?? 'tiktok',
        channelBaseline:  p['channelBaseline'] as never,
      })
    },
  },
  'shortform.platform_guidance': {
    description: 'Per-platform native-aesthetic guidance. Params: platform',
    risk: 'low',
    handler: async (_ws, p) => {
      const { getPlatformGuidance } = await import('./shortform-engine.js')
      return getPlatformGuidance((p['platform'] as never) ?? 'tiktok')
    },
  },
  'shortform.plan_tier_distribution': {
    description: 'Plan Tier 1 → Tier 2 → Tier 3 → Tier 4 content distribution. Params: tier1, activeShortformPlatforms, hasNewsletter, hasPodcast, hasLinkedinPresence',
    risk: 'low',
    handler: async (_ws, p) => {
      const { planTierDistribution } = await import('./shortform-engine.js')
      return planTierDistribution({
        tier1:                       p['tier1'] as never,
        activeShortformPlatforms:    (p['activeShortformPlatforms'] as never) ?? [],
        hasNewsletter:               Boolean(p['hasNewsletter']),
        hasPodcast:                  Boolean(p['hasPodcast']),
        hasLinkedinPresence:         Boolean(p['hasLinkedinPresence']),
      })
    },
  },
  'shortform.check_multi_account_plan': {
    description: 'Check a multi-account plan against platform ToS. Refuses engagement-manipulation tactics. Params: accountCount, contentDistinct, purposeDistinct, creativeDirection, crossEngagement',
    risk: 'low',
    handler: async (_ws, p) => {
      const { checkMultiAccountPlan } = await import('./shortform-engine.js')
      return checkMultiAccountPlan({
        accountCount:      Number(p['accountCount'] ?? 1),
        contentDistinct:   Boolean(p['contentDistinct']),
        purposeDistinct:   Boolean(p['purposeDistinct']),
        creativeDirection: (p['creativeDirection'] as never) ?? 'distinct_per_account',
        crossEngagement:   (p['crossEngagement']   as never) ?? 'none',
      })
    },
  },
  'acquisition.valuate_channel': {
    description: 'Estimate channel valuation. Params: financials, operations',
    risk: 'low',
    handler: async (_ws, p) => {
      const { valuateChannel } = await import('./channel-acquisition.js')
      return valuateChannel({
        financials: p['financials'] as never,
        operations: p['operations'] as never,
      })
    },
  },
  'acquisition.diligence_checklist': {
    description: 'Get the standard due-diligence checklist for channel acquisition.',
    risk: 'low',
    handler: async () => {
      const { dueDiligenceChecklist } = await import('./channel-acquisition.js')
      return dueDiligenceChecklist()
    },
  },
  'acquisition.summarise_diligence': {
    description: 'Aggregate diligence findings into a verdict. Params: items',
    risk: 'low',
    handler: async (_ws, p) => {
      const { summariseDiligence } = await import('./channel-acquisition.js')
      return summariseDiligence((p['items'] as never) ?? [])
    },
  },
  'acquisition.build_vs_buy': {
    description: 'Build-vs-buy framework. Params: capitalAvailableUsd, targetTimeToRevenueMonths, creativeControlImportance, nicheMaturity, existingOperationalCapacity, hasAdjacentOperations',
    risk: 'low',
    handler: async (_ws, p) => {
      const { buildVsBuy } = await import('./channel-acquisition.js')
      return buildVsBuy({
        capitalAvailableUsd:         Number(p['capitalAvailableUsd']         ?? 100_000),
        targetTimeToRevenueMonths:   Number(p['targetTimeToRevenueMonths']   ?? 24),
        creativeControlImportance:   Number(p['creativeControlImportance']   ?? 0.5),
        nicheMaturity:               (p['nicheMaturity'] as never)              ?? 'established',
        existingOperationalCapacity: Boolean(p['existingOperationalCapacity']),
        hasAdjacentOperations:       Boolean(p['hasAdjacentOperations']),
      })
    },
  },
  'acquisition.score_target': {
    description: 'Score an acquisition target as good / acceptable / avoid. Params: financials, operations',
    risk: 'low',
    handler: async (_ws, p) => {
      const { scoreAcquisitionTarget } = await import('./channel-acquisition.js')
      return scoreAcquisitionTarget({
        financials: p['financials'] as never,
        operations: p['operations'] as never,
      })
    },
  },
  'compliance.recommend_entity': {
    description: 'Recommend entity structure. Params: annualNetIncomeUsd, jurisdiction, multiOwner, seekingVentureCapital, planningExit',
    risk: 'low',
    handler: async (_ws, p) => {
      const { recommendEntity } = await import('./compliance-tracker.js')
      return recommendEntity({
        annualNetIncomeUsd:    Number(p['annualNetIncomeUsd']    ?? 0),
        jurisdiction:          (p['jurisdiction'] as never)        ?? 'US',
        multiOwner:            Boolean(p['multiOwner']),
        seekingVentureCapital: Boolean(p['seekingVentureCapital']),
        planningExit:          Boolean(p['planningExit']),
      })
    },
  },
  'compliance.check_ftc_disclosure': {
    description: 'Check FTC disclosure compliance for a sponsored post. Params: descriptionText, inVideoDisclosureSec, hasAdHashtag, hasVerbalDisclosure, disclosureBeforeSegment, hasAffiliateLinks, targetingMinors',
    risk: 'low',
    handler: async (_ws, p) => {
      const { checkFtcDisclosure } = await import('./compliance-tracker.js')
      return checkFtcDisclosure({
        descriptionText:         String(p['descriptionText'] ?? ''),
        inVideoDisclosureSec:    p['inVideoDisclosureSec'] === null || p['inVideoDisclosureSec'] === undefined ? null : Number(p['inVideoDisclosureSec']),
        hasAdHashtag:            Boolean(p['hasAdHashtag']),
        hasVerbalDisclosure:     Boolean(p['hasVerbalDisclosure']),
        disclosureBeforeSegment: Boolean(p['disclosureBeforeSegment']),
        hasAffiliateLinks:       Boolean(p['hasAffiliateLinks']),
        targetingMinors:         Boolean(p['targetingMinors']),
      })
    },
  },
  'compliance.audit_rights': {
    description: 'Audit content rights (music / footage / images / AI-gen). Params: items[]',
    risk: 'low',
    handler: async (_ws, p) => {
      const { auditContentRights } = await import('./compliance-tracker.js')
      return auditContentRights((p['items'] as never) ?? [])
    },
  },
  'compliance.compute_tax_obligations': {
    description: 'Compute quarterly + sales-tax + 1099 + retirement obligations. Params: annualNetIncomeUsd, state, effectiveTaxRate, revenueByState, transactionsByState?, expected1099s?, retirementCurrentContributions?, year',
    risk: 'low',
    handler: async (_ws, p) => {
      const { computeTaxObligations } = await import('./compliance-tracker.js')
      return computeTaxObligations({
        annualNetIncomeUsd:                Number(p['annualNetIncomeUsd'] ?? 0),
        state:                             String(p['state'] ?? 'CA'),
        effectiveTaxRate:                  Number(p['effectiveTaxRate'] ?? 0.35),
        revenueByState:                    (p['revenueByState'] as Record<string, number>) ?? {},
        ...(p['transactionsByState']                ? { transactionsByState:                p['transactionsByState'] as Record<string, number> } : {}),
        ...(p['expected1099s']                      ? { expected1099s:                      p['expected1099s'] as never } : {}),
        ...(p['retirementCurrentContributions']     ? { retirementCurrentContributions:     p['retirementCurrentContributions'] as never } : {}),
        year:                              Number(p['year'] ?? new Date().getFullYear()),
      })
    },
  },
  'compliance.check_international_tax': {
    description: 'Check international tax flags. Params: operatorJurisdiction, earnsFromUsPlatforms, hasUsBusinessEntity, hasIntlContractors, intlAudiencePct',
    risk: 'low',
    handler: async (_ws, p) => {
      const { checkInternationalTax } = await import('./compliance-tracker.js')
      return checkInternationalTax({
        operatorJurisdiction:  (p['operatorJurisdiction'] as never) ?? 'US',
        earnsFromUsPlatforms:  Boolean(p['earnsFromUsPlatforms']),
        hasUsBusinessEntity:   Boolean(p['hasUsBusinessEntity']),
        hasIntlContractors:    Boolean(p['hasIntlContractors']),
        intlAudiencePct:       Number(p['intlAudiencePct'] ?? 0),
      })
    },
  },
  'compliance.recommend_ip_actions': {
    description: 'Recommend IP register actions. Params: annualRevenueUsd, channelName, hasFlagshipBrand, usesMusic, usesStockFootage, currentRegister',
    risk: 'low',
    handler: async (_ws, p) => {
      const { recommendIpActions } = await import('./compliance-tracker.js')
      return recommendIpActions({
        annualRevenueUsd: Number(p['annualRevenueUsd'] ?? 0),
        channelName:      String(p['channelName'] ?? ''),
        hasFlagshipBrand: Boolean(p['hasFlagshipBrand']),
        usesMusic:        Boolean(p['usesMusic']),
        usesStockFootage: Boolean(p['usesStockFootage']),
        currentRegister:  (p['currentRegister'] as never) ?? [],
      })
    },
  },

  // ─── Round 117 wiring: TikTok connector ops ──────────────────────
  'tiktok.list_videos': {
    description: 'List TikTok videos on the authenticated account. Params: accessToken, cursor?, maxCount?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listVideos } = await import('./connector-tiktok.js')
      return listVideos({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        ...(p['cursor']   !== undefined ? { cursor:   Number(p['cursor']) }   : {}),
        ...(p['maxCount'] !== undefined ? { maxCount: Number(p['maxCount']) } : {}),
      })
    },
  },
  'tiktok.get_video_stats': {
    description: 'Get analytics for specific TikTok videos. Params: accessToken, videoIds[]',
    risk: 'low',
    handler: async (ws, p) => {
      const { getVideoStats } = await import('./connector-tiktok.js')
      return getVideoStats({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        videoIds:    (p['videoIds'] as string[]) ?? [],
      })
    },
  },
  'tiktok.init_video_publish': {
    description: 'Start a TikTok video publish. Requires approval. Params: accessToken, caption, privacyLevel, videoSizeBytes, videoMimeType, disableComment?, disableDuet?, disableStitch?, autoAddMusic?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { initVideoPublish } = await import('./connector-tiktok.js')
      return initVideoPublish({
        workspaceId:        ws,
        accessToken:        String(p['accessToken'] ?? ''),
        caption:            String(p['caption'] ?? ''),
        privacyLevel:       (p['privacyLevel'] as never) ?? 'SELF_ONLY',
        videoSizeBytes:     Number(p['videoSizeBytes'] ?? 0),
        videoMimeType:      String(p['videoMimeType'] ?? 'video/mp4'),
        ...(p['disableComment'] !== undefined ? { disableComment: Boolean(p['disableComment']) } : {}),
        ...(p['disableDuet']    !== undefined ? { disableDuet:    Boolean(p['disableDuet'])    } : {}),
        ...(p['disableStitch']  !== undefined ? { disableStitch:  Boolean(p['disableStitch'])  } : {}),
        ...(p['autoAddMusic']   !== undefined ? { autoAddMusic:   Boolean(p['autoAddMusic'])   } : {}),
        approvalToken:      String(p['approvalToken'] ?? ''),
      })
    },
  },
  'tiktok.get_publish_status': {
    description: 'Poll a TikTok publish job. Params: accessToken, publishId',
    risk: 'low',
    handler: async (ws, p) => {
      const { getPublishStatus } = await import('./connector-tiktok.js')
      return getPublishStatus({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        publishId:   String(p['publishId'] ?? ''),
      })
    },
  },
  'tiktok.publish_photo_carousel': {
    description: 'Publish a TikTok photo carousel. Requires approval. Params: accessToken, caption, photoUrls[], privacyLevel, disableComment?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { publishPhotoCarousel } = await import('./connector-tiktok.js')
      return publishPhotoCarousel({
        workspaceId:  ws,
        accessToken:  String(p['accessToken'] ?? ''),
        caption:      String(p['caption'] ?? ''),
        photoUrls:    (p['photoUrls'] as string[]) ?? [],
        privacyLevel: (p['privacyLevel'] as never) ?? 'SELF_ONLY',
        ...(p['disableComment'] !== undefined ? { disableComment: Boolean(p['disableComment']) } : {}),
        approvalToken: String(p['approvalToken'] ?? ''),
      })
    },
  },
  'tiktok.list_comments': {
    description: 'List TikTok comments on a video. Params: accessToken, videoId, cursor?, maxCount?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listComments } = await import('./connector-tiktok.js')
      return listComments({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        videoId:     String(p['videoId'] ?? ''),
        ...(p['cursor']   !== undefined ? { cursor:   Number(p['cursor']) }   : {}),
        ...(p['maxCount'] !== undefined ? { maxCount: Number(p['maxCount']) } : {}),
      })
    },
  },
  'tiktok.reply_to_comment': {
    description: 'Reply to a TikTok comment. Requires approval. Params: accessToken, videoId, parentCommentId, text, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { replyToComment } = await import('./connector-tiktok.js')
      return replyToComment({
        workspaceId:      ws,
        accessToken:      String(p['accessToken'] ?? ''),
        videoId:          String(p['videoId'] ?? ''),
        parentCommentId:  String(p['parentCommentId'] ?? ''),
        text:             String(p['text'] ?? ''),
        approvalToken:    String(p['approvalToken'] ?? ''),
      })
    },
  },
  'tiktok.analytics_summary': {
    description: 'Channel-level TikTok analytics summary (totals + medians). Params: accessToken, days?',
    risk: 'low',
    handler: async (ws, p) => {
      const { analyticsSummary } = await import('./connector-tiktok.js')
      return analyticsSummary({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        ...(p['days'] !== undefined ? { days: Number(p['days']) } : {}),
      })
    },
  },

  // ─── Round 119 wiring: Instagram connector ops ───────────────────
  'instagram.list_media': {
    description: 'List Instagram media (posts + Reels + carousels). Params: accessToken, igUserId, limit?, afterCursor?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listMedia } = await import('./connector-instagram.js')
      return listMedia({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        igUserId:    String(p['igUserId'] ?? ''),
        ...(p['limit']       !== undefined ? { limit:       Number(p['limit']) }       : {}),
        ...(p['afterCursor'] !== undefined ? { afterCursor: String(p['afterCursor']) } : {}),
      })
    },
  },
  'instagram.get_media_insights': {
    description: 'Per-post Instagram analytics. Params: accessToken, igUserId, mediaId, metrics?',
    risk: 'low',
    handler: async (ws, p) => {
      const { getMediaInsights } = await import('./connector-instagram.js')
      return getMediaInsights({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        igUserId:    String(p['igUserId'] ?? ''),
        mediaId:     String(p['mediaId'] ?? ''),
        ...(p['metrics'] ? { metrics: String(p['metrics']) } : {}),
      })
    },
  },
  'instagram.create_media': {
    description: 'Create a media container (image/video/Reel/Story). Requires approval. Params: accessToken, igUserId, mediaType, url, caption?, coverUrl?, shareToFeed?, linkUrl?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { createMediaContainer } = await import('./connector-instagram.js')
      return createMediaContainer({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        igUserId:       String(p['igUserId'] ?? ''),
        mediaType:      (p['mediaType'] as never) ?? 'IMAGE',
        url:            String(p['url'] ?? ''),
        ...(p['caption']     ? { caption:     String(p['caption']) }    : {}),
        ...(p['coverUrl']    ? { coverUrl:    String(p['coverUrl']) }   : {}),
        ...(p['shareToFeed'] !== undefined ? { shareToFeed: Boolean(p['shareToFeed']) } : {}),
        ...(p['linkUrl']     ? { linkUrl:     String(p['linkUrl']) }    : {}),
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },
  'instagram.publish_container': {
    description: 'Publish a previously created container. Requires approval. Params: accessToken, igUserId, containerId, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { publishMediaContainer } = await import('./connector-instagram.js')
      return publishMediaContainer({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        igUserId:       String(p['igUserId'] ?? ''),
        containerId:    String(p['containerId'] ?? ''),
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },
  'instagram.publish_carousel': {
    description: 'Publish 2-10 image carousel. Requires approval. Params: accessToken, igUserId, caption?, imageUrls[], approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { publishCarousel } = await import('./connector-instagram.js')
      return publishCarousel({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        igUserId:       String(p['igUserId'] ?? ''),
        ...(p['caption'] ? { caption: String(p['caption']) } : {}),
        imageUrls:      (p['imageUrls'] as string[]) ?? [],
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },
  'instagram.list_comments': {
    description: 'List comments on an Instagram post. Params: accessToken, igUserId, mediaId, limit?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listComments } = await import('./connector-instagram.js')
      return listComments({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        igUserId:    String(p['igUserId'] ?? ''),
        mediaId:     String(p['mediaId'] ?? ''),
        ...(p['limit'] !== undefined ? { limit: Number(p['limit']) } : {}),
      })
    },
  },
  'instagram.reply_to_comment': {
    description: 'Reply to an Instagram comment. Requires approval. Params: accessToken, igUserId, commentId, text, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { replyToComment } = await import('./connector-instagram.js')
      return replyToComment({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        igUserId:       String(p['igUserId'] ?? ''),
        commentId:      String(p['commentId'] ?? ''),
        text:           String(p['text'] ?? ''),
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },
  'instagram.hide_comment': {
    description: 'Hide an Instagram comment without deleting. Requires approval. Params: accessToken, igUserId, commentId, hide, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { hideComment } = await import('./connector-instagram.js')
      return hideComment({
        workspaceId:    ws,
        accessToken:    String(p['accessToken'] ?? ''),
        igUserId:       String(p['igUserId'] ?? ''),
        commentId:      String(p['commentId'] ?? ''),
        hide:           Boolean(p['hide']),
        approvalToken:  String(p['approvalToken'] ?? ''),
      })
    },
  },

  // ─── Round 120 wiring: Shopify connector ops ────────────────────
  'shopify.list_products': {
    description: 'List Shopify products. Params: accessToken, shop, limit?, status?, vendor?, sinceId?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listProducts } = await import('./connector-shopify.js')
      return listProducts({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        shop:        String(p['shop'] ?? ''),
        ...(p['limit']   !== undefined ? { limit:   Number(p['limit']) }       : {}),
        ...(p['status']  !== undefined ? { status:  p['status'] as never }     : {}),
        ...(p['vendor']  !== undefined ? { vendor:  String(p['vendor']) }      : {}),
        ...(p['sinceId'] !== undefined ? { sinceId: String(p['sinceId']) }     : {}),
      })
    },
  },
  'shopify.create_product': {
    description: 'Create a Shopify product. Requires approval. Params: accessToken, shop, title, bodyHtml?, vendor?, productType?, tags?, status, variants[], imageUrls?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { createProduct } = await import('./connector-shopify.js')
      return createProduct({
        workspaceId:   ws,
        accessToken:   String(p['accessToken'] ?? ''),
        shop:          String(p['shop'] ?? ''),
        title:         String(p['title'] ?? ''),
        ...(p['bodyHtml']    ? { bodyHtml:    String(p['bodyHtml']) }    : {}),
        ...(p['vendor']      ? { vendor:      String(p['vendor']) }      : {}),
        ...(p['productType'] ? { productType: String(p['productType']) } : {}),
        ...(Array.isArray(p['tags'])      ? { tags:      p['tags']      as string[] } : {}),
        status:        (p['status'] as never) ?? 'draft',
        variants:      (p['variants'] as never) ?? [],
        ...(Array.isArray(p['imageUrls']) ? { imageUrls: p['imageUrls'] as string[] } : {}),
        approvalToken: String(p['approvalToken'] ?? ''),
      })
    },
  },
  'shopify.update_product': {
    description: 'Update a Shopify product. Requires approval. Params: accessToken, shop, productId, title?, bodyHtml?, vendor?, tags?, status?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { updateProduct } = await import('./connector-shopify.js')
      return updateProduct({
        workspaceId:   ws,
        accessToken:   String(p['accessToken'] ?? ''),
        shop:          String(p['shop'] ?? ''),
        productId:     String(p['productId'] ?? ''),
        ...(p['title']    !== undefined ? { title:    String(p['title']) }    : {}),
        ...(p['bodyHtml'] !== undefined ? { bodyHtml: String(p['bodyHtml']) } : {}),
        ...(p['vendor']   !== undefined ? { vendor:   String(p['vendor']) }   : {}),
        ...(Array.isArray(p['tags']) ? { tags: p['tags'] as string[] } : {}),
        ...(p['status']   !== undefined ? { status: p['status'] as never }    : {}),
        approvalToken: String(p['approvalToken'] ?? ''),
      })
    },
  },
  'shopify.update_inventory': {
    description: 'Set Shopify inventory level. Requires approval. Params: accessToken, shop, inventoryItemId, locationId, available, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { updateInventory } = await import('./connector-shopify.js')
      return updateInventory({
        workspaceId:     ws,
        accessToken:     String(p['accessToken'] ?? ''),
        shop:            String(p['shop'] ?? ''),
        inventoryItemId: String(p['inventoryItemId'] ?? ''),
        locationId:      String(p['locationId'] ?? ''),
        available:       Number(p['available'] ?? 0),
        approvalToken:   String(p['approvalToken'] ?? ''),
      })
    },
  },
  'shopify.list_orders': {
    description: 'List Shopify orders. Params: accessToken, shop, status?, fulfillmentStatus?, limit?, sinceId?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listOrders } = await import('./connector-shopify.js')
      return listOrders({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        shop:        String(p['shop'] ?? ''),
        ...(p['status']             !== undefined ? { status:             p['status']             as never } : {}),
        ...(p['fulfillmentStatus']  !== undefined ? { fulfillmentStatus:  p['fulfillmentStatus']  as never } : {}),
        ...(p['limit']              !== undefined ? { limit:              Number(p['limit']) }              : {}),
        ...(p['sinceId']            !== undefined ? { sinceId:            String(p['sinceId']) }            : {}),
      })
    },
  },
  'shopify.fulfill_order': {
    description: 'Fulfill a Shopify order. Requires approval. Params: accessToken, shop, orderId, fulfillmentOrderId, trackingNumber?, trackingCompany?, trackingUrl?, notifyCustomer?, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { fulfillOrder } = await import('./connector-shopify.js')
      return fulfillOrder({
        workspaceId:        ws,
        accessToken:        String(p['accessToken'] ?? ''),
        shop:               String(p['shop'] ?? ''),
        orderId:            String(p['orderId'] ?? ''),
        fulfillmentOrderId: String(p['fulfillmentOrderId'] ?? ''),
        ...(p['trackingNumber']  ? { trackingNumber:  String(p['trackingNumber']) }  : {}),
        ...(p['trackingCompany'] ? { trackingCompany: String(p['trackingCompany']) } : {}),
        ...(p['trackingUrl']     ? { trackingUrl:     String(p['trackingUrl']) }     : {}),
        ...(p['notifyCustomer']  !== undefined ? { notifyCustomer: Boolean(p['notifyCustomer']) } : {}),
        approvalToken:      String(p['approvalToken'] ?? ''),
      })
    },
  },
  'shopify.analytics_summary': {
    description: 'Shop-level analytics summary (orders / revenue / AOV). Params: accessToken, shop, days?',
    risk: 'low',
    handler: async (ws, p) => {
      const { getAnalyticsSummary } = await import('./connector-shopify.js')
      return getAnalyticsSummary({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        shop:        String(p['shop'] ?? ''),
        ...(p['days'] !== undefined ? { days: Number(p['days']) } : {}),
      })
    },
  },

  // ─── Round 124 wiring: Printful connector ops ────────────────────
  'printful.get_store': {
    description: 'Verify Printful auth + identify connected store. Params: accessToken',
    risk: 'low',
    handler: async (ws, p) => {
      const { getStore } = await import('./connector-printful.js')
      return getStore({ workspaceId: ws, accessToken: String(p['accessToken'] ?? '') })
    },
  },
  'printful.list_sync_products': {
    description: 'List Printful sync products. Params: accessToken, limit?, offset?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listSyncProducts } = await import('./connector-printful.js')
      return listSyncProducts({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        ...(p['limit']  !== undefined ? { limit:  Number(p['limit']) }  : {}),
        ...(p['offset'] !== undefined ? { offset: Number(p['offset']) } : {}),
      })
    },
  },
  'printful.create_sync_product': {
    description: 'Create a Printful sync product. Requires approval. Params: accessToken, name, thumbnailUrl?, variants[], approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { createSyncProduct } = await import('./connector-printful.js')
      return createSyncProduct({
        workspaceId:   ws,
        accessToken:   String(p['accessToken'] ?? ''),
        name:          String(p['name'] ?? ''),
        ...(p['thumbnailUrl'] ? { thumbnailUrl: String(p['thumbnailUrl']) } : {}),
        variants:      (p['variants'] as never) ?? [],
        approvalToken: String(p['approvalToken'] ?? ''),
      })
    },
  },
  'printful.list_orders': {
    description: 'List Printful orders. Params: accessToken, status?, limit?, offset?',
    risk: 'low',
    handler: async (ws, p) => {
      const { listOrders } = await import('./connector-printful.js')
      return listOrders({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        ...(p['status'] !== undefined ? { status: p['status'] as never } : {}),
        ...(p['limit']  !== undefined ? { limit:  Number(p['limit']) }   : {}),
        ...(p['offset'] !== undefined ? { offset: Number(p['offset']) }  : {}),
      })
    },
  },
  'printful.get_order': {
    description: 'Get Printful order detail. Params: accessToken, orderId',
    risk: 'low',
    handler: async (ws, p) => {
      const { getOrder } = await import('./connector-printful.js')
      return getOrder({ workspaceId: ws, accessToken: String(p['accessToken'] ?? ''), orderId: String(p['orderId'] ?? '') })
    },
  },
  'printful.confirm_order': {
    description: 'Confirm a Printful order (MONEY-FLOW — triggers production + charge). Requires approval + caller=operator. Params: accessToken, orderId, approvalToken',
    risk: 'critical',
    handler: async (ws, p) => {
      const { confirmOrder } = await import('./connector-printful.js')
      return confirmOrder({
        workspaceId:   ws,
        accessToken:   String(p['accessToken'] ?? ''),
        orderId:       String(p['orderId'] ?? ''),
        approvalToken: String(p['approvalToken'] ?? ''),
      })
    },
  },
  'printful.cancel_order': {
    description: 'Cancel a pending Printful order. Requires approval. Params: accessToken, orderId, approvalToken',
    risk: 'high',
    handler: async (ws, p) => {
      const { cancelOrder } = await import('./connector-printful.js')
      return cancelOrder({
        workspaceId:   ws,
        accessToken:   String(p['accessToken'] ?? ''),
        orderId:       String(p['orderId'] ?? ''),
        approvalToken: String(p['approvalToken'] ?? ''),
      })
    },
  },
  'printful.get_product_prices': {
    description: 'Get Printful wholesale prices for a catalog product. Feeds pod-pricing COGS updates. Params: accessToken, catalogProductId, currency?, region?',
    risk: 'low',
    handler: async (ws, p) => {
      const { getProductPrices } = await import('./connector-printful.js')
      return getProductPrices({
        workspaceId:      ws,
        accessToken:      String(p['accessToken'] ?? ''),
        catalogProductId: Number(p['catalogProductId'] ?? 0),
        ...(p['currency'] ? { currency: String(p['currency']) } : {}),
        ...(p['region']   ? { region:   String(p['region']) }   : {}),
      })
    },
  },
  'printful.get_shipping_rates': {
    description: 'Calc Printful shipping rates for a destination + items. Params: accessToken, recipient, items[], currency?',
    risk: 'low',
    handler: async (ws, p) => {
      const { getShippingRates } = await import('./connector-printful.js')
      return getShippingRates({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        recipient:   (p['recipient'] as never) ?? { countryCode: 'US' },
        items:       (p['items'] as never) ?? [],
        ...(p['currency'] ? { currency: String(p['currency']) } : {}),
      })
    },
  },
  'printful.analytics_summary': {
    description: 'Printful order activity rollup. Params: accessToken, days?',
    risk: 'low',
    handler: async (ws, p) => {
      const { getAnalyticsSummary } = await import('./connector-printful.js')
      return getAnalyticsSummary({
        workspaceId: ws,
        accessToken: String(p['accessToken'] ?? ''),
        ...(p['days'] !== undefined ? { days: Number(p['days']) } : {}),
      })
    },
  },

  // ─── Round 124 wiring: chat eval seeding ────────────────────────
  'evals.seed_chat': {
    description: 'Seed Novan chat eval sets (golden + regression + safety + honesty) for this workspace. Idempotent — skips existing sets.',
    risk: 'medium',
    handler: async (ws) => {
      const { seedChatEvals } = await import('./eval-seed-chat.js')
      return seedChatEvals(ws)
    },
  },
  'evals.list_chat_seeds': {
    description: 'Preview the chat eval seed sets without persisting.',
    risk: 'low',
    handler: async () => {
      const { listChatEvalSeeds } = await import('./eval-seed-chat.js')
      return listChatEvalSeeds()
    },
  },
}

// ─── Public surface ────────────────────────────────────────────────────

export interface TaskOperation {
  op:     string
  params: Record<string, unknown>
  /**
   * R146.73 — provenance of this plan step:
   *   operator  — operator-typed (REPL, /task with explicit plan)
   *   planner   — LLM planner converted operator text → plan
   *   page      — derived from page-scrape / browser content
   *   rollup    — derived from LLM-generated rollup / summary
   * Anything other than 'operator' is treated as untrusted-input
   * provenance: ops outside the page-derived allowlist require
   * OPERATOR_APPROVED, regardless of declared risk tier.
   */
  provenance?: 'operator' | 'planner' | 'page' | 'rollup'
}

// R146.73 — page-derived provenance allowlist. Low-blast-radius
// read/diagnostic ops only. Anything that writes external state,
// spends money, modifies credentials, or drives GUI/desktop is
// excluded. A non-operator plan step calling an op NOT in this set
// auto-requires OPERATOR_APPROVED, even if the op's declared risk
// is 'low'. Pairs with R146.72 <untrusted_content> tagging: every
// boundary input the LLM consumes is marked, and any plan step it
// emits from those inputs is implicitly non-operator provenance.
const PAGE_DERIVED_ALLOWLIST: ReadonlySet<string> = new Set([
  'db.query',
  'code.search',
  'platform.smoke',
  'providers.validate',
  'mind.cycle',
  'web.fetch',
  'video.analyze',
  'browser.open', 'browser.text', 'browser.screenshot', 'browser.list', 'browser.waitFor',
  'governance.check', 'governance.listRules',
  'trust.score', 'trust.topBroken',
  'wisdom.check', 'dna.get',
  'world.neighbors', 'world.causalChain', 'world.listNodes',
  'economic.scoreVideo', 'economic.health', 'economic.simulatePricing',
  'production.log', 'production.activeCancelTokens',
  'cache.stats',
  'music.knowledge', 'music.status', 'system.ffmpegAvailable',
  'mixcraft.status', 'capcut.status',
  'bridge.status', 'bridge.listJobs',
  'channel.list', 'schedule.list',
  'analytics.snapshot', 'analytics.snapshotMany',
])

/** R146.73 — recursive scan for <untrusted_content tag in any param
 *  value. The presence of the marker means at least one input crossed
 *  the trust boundary (page text, LLM rollup, operator-typed label
 *  summarized by the brain), and the plan step must be gated. */
function paramsContainUntrustedMarker(val: unknown, depth = 0): boolean {
  if (depth > 6) return false
  if (typeof val === 'string') return val.includes('<untrusted_content')
  if (Array.isArray(val)) {
    for (const v of val) if (paramsContainUntrustedMarker(v, depth + 1)) return true
    return false
  }
  if (val && typeof val === 'object') {
    for (const v of Object.values(val as Record<string, unknown>)) {
      if (paramsContainUntrustedMarker(v, depth + 1)) return true
    }
    return false
  }
  return false
}

export interface TaskRunResult {
  taskId:     string
  workspaceId: string
  task:       string
  startedAt:  number
  completedAt: number
  plan:       TaskOperation[]
  results:    Array<{ op: string; ok: boolean; data?: unknown; error?: string; durationMs: number }>
  summary:    string
}

/** Strip likely-sensitive content from an error message before it lands
 *  in persisted events / chains / trust logs / SSE streams. Patterns
 *  covered: API keys (Bearer …, sk-…, key=…, password=…), file paths
 *  beyond the repo root, postgres SQL fragments with bound parameters,
 *  and oversize bodies. Bounded at 500 chars after redaction. */
function sanitizeErrorMessage(raw: string): string {
  if (!raw) return ''
  let s = String(raw)
  // Bearer tokens + sk- prefix keys + bare 32+ hex strings
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
  s = s.replace(/\b(sk|pk|api[_-]?key|apikey|token|password|secret|client_secret|refresh_token|access_token)["'\s:=]+[A-Za-z0-9._-]{8,}/gi, '[REDACTED-credential]')
  s = s.replace(/[A-Fa-f0-9]{32,}/g, '[REDACTED-hash]')
  // Cap length
  if (s.length > 500) s = s.slice(0, 500) + '…'
  return s
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'brain-task', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[brain-task]', e.message); return null })
}

export function listAvailableOperations(): Array<{ op: string; description: string; risk: OpRisk }> {
  return Object.entries(OPERATIONS).map(([op, spec]) => ({ op, description: spec.description, risk: spec.risk }))
}

/**
 * Execute an explicit ordered list of operations. Used when the operator
 * (or the LLM planner) hands in a structured plan directly.
 */
export async function executePlan(workspaceId: string, task: string, plan: TaskOperation[], approvalToken?: string, plannerReason?: string): Promise<TaskRunResult> {
  const taskId = uuidv7()
  const startedAt = Date.now()
  await emit(workspaceId, 'brain_task.started', { taskId, task, planLength: plan.length })

  // Record the planner's decision as a reasoning chain so brain-task
  // intent shows up alongside autonomous-mind decisions in chain views.
  if (task && plan.length > 0) {
    void import('./reasoning-chains.js').then(m => m.record({
      workspaceId, kind: 'decision',
      subjectId: `brain-task:${taskId}`,
      decision: `Brain task: "${task.slice(0, 200)}" → plan [${plan.map(s => s.op).join(', ')}]${plannerReason ? ` (${plannerReason})` : ''}`,
      evidence: plan.map(s => ({ type: 'operation', id: s.op, extract: JSON.stringify(s.params).slice(0, 120) })),
      confidence: 0.8,
      source: 'brain-task',
    })).catch((e: Error) => { console.error('[brain-task]', e.message); return null })
  }

  const results: TaskRunResult['results'] = []
  for (const step of plan) {
    const spec = OPERATIONS[step.op]
    if (!spec) {
      results.push({ op: step.op, ok: false, error: `unknown operation: ${step.op}`, durationMs: 0 })
      continue
    }

    // Money guard — runs before every op, blocks anything that touches
    // payments/banking/crypto/etc. Operator can opt-out per-call with
    // params.non_financial=true after reviewing the params.
    const guard = guardOperation(step.op, step.params ?? {})
    if (!guard.ok) {
      const reason = `money-guard blocked: matched "${guard.matched}" at ${guard.source}. If this is legitimate non-financial use, set params.non_financial=true.`
      results.push({ op: step.op, ok: false, error: reason, durationMs: 0 })
      await emit(workspaceId, 'brain_task.money_blocked', {
        taskId, op: step.op, matched: guard.matched, source: guard.source,
      })
      continue
    }

    // R146.73 — provenance + untrusted-input gate. Runs BEFORE the
    // risk-based approval gate so it can elevate even risk=low ops
    // when the input crossed an <untrusted_content> boundary or the
    // step did not originate from operator-typed text.
    const provenance = step.provenance ?? 'operator'
    const untrustedInput = paramsContainUntrustedMarker(step.params ?? {})
    const nonOperatorPath = provenance !== 'operator' || untrustedInput
    if (nonOperatorPath && !PAGE_DERIVED_ALLOWLIST.has(step.op) && approvalToken !== 'OPERATOR_APPROVED') {
      const cause = untrustedInput
        ? `untrusted_content marker in params (provenance=${provenance})`
        : `provenance=${provenance}`
      results.push({
        op: step.op, ok: false,
        error: `${cause}: op '${step.op}' is not in the page-derived allowlist; requires approvalToken=OPERATOR_APPROVED`,
        durationMs: 0,
      })
      await emit(workspaceId, 'brain_task.provenance_blocked', {
        taskId, op: step.op, provenance, untrustedInput, risk: spec.risk,
      })
      continue
    }

    // R146.74 — independent tool-call classifier. Separate LLM (fed
    // ONLY the structured op+params+provenance, never the operator's
    // text or page content) judges allow/deny before the handler runs.
    // Skipped for the trivial path (operator-typed, no untrusted input,
    // allowlisted low-blast op) to avoid burning tokens on db.query
    // and friends. Cache-hit verdicts are free.
    const classifierTrivialSkip =
      provenance === 'operator' &&
      !untrustedInput &&
      PAGE_DERIVED_ALLOWLIST.has(step.op) &&
      spec.risk === 'low'
    if (!classifierTrivialSkip && approvalToken !== 'OPERATOR_APPROVED') {
      try {
        const { classifyToolCall } = await import('./tool-call-classifier.js')
        const verdict = await classifyToolCall({
          op: step.op,
          params: step.params ?? {},
          provenance,
          declaredRisk: spec.risk,
          untrustedInput,
          ...(task ? { taskSummary: task } : {}),
        })
        await emit(workspaceId, 'brain_task.classifier_verdict', {
          taskId, op: step.op, allow: verdict.allow, confidence: verdict.confidence,
          reason: verdict.reason.slice(0, 200), cached: verdict.cached,
          unavailable: verdict.unavailable === true,
        })
        if (verdict.unavailable) {
          // Fail-closed for risky non-operator paths; fail-open for
          // operator-typed low/medium. We never want a classifier
          // outage to silently break operator workflows nor silently
          // let page-derived plans escape.
          const failClosed =
            provenance !== 'operator' ||
            untrustedInput ||
            spec.risk === 'high' ||
            spec.risk === 'critical'
          if (failClosed) {
            results.push({
              op: step.op, ok: false,
              error: `classifier unavailable (fail-closed): provenance=${provenance} risk=${spec.risk} untrusted=${untrustedInput}`,
              durationMs: 0,
            })
            continue
          }
        } else if (!verdict.allow) {
          results.push({
            op: step.op, ok: false,
            error: `classifier denied: ${verdict.reason} (confidence=${verdict.confidence.toFixed(2)})`,
            durationMs: 0,
          })
          await emit(workspaceId, 'brain_task.classifier_blocked', {
            taskId, op: step.op, reason: verdict.reason.slice(0, 200), confidence: verdict.confidence,
          })
          continue
        }
      } catch (e) {
        // Classifier import or unexpected throw — same fail-closed
        // logic as `unavailable`. Operator-typed low/medium proceeds.
        const msg = (e as Error).message
        const failClosed =
          provenance !== 'operator' ||
          untrustedInput ||
          spec.risk === 'high' ||
          spec.risk === 'critical'
        if (failClosed) {
          results.push({ op: step.op, ok: false, error: `classifier error (fail-closed): ${msg}`, durationMs: 0 })
          continue
        }
      }
    }

    if ((spec.risk === 'high' || spec.risk === 'critical') && approvalToken !== 'OPERATOR_APPROVED') {
      results.push({ op: step.op, ok: false, error: `risk=${spec.risk} requires approvalToken=OPERATOR_APPROVED`, durationMs: 0 })
      continue
    }

    // ─── Loop detection — refuse if the same op+args has been called
    // identically twice in the recent window. Coordination guard from
    // round 124. Operator-initiated calls pass through (the operator
    // may legitimately want to re-run the same op manually); the guard
    // is for agent/cron callers stuck in a tool-call loop. The caller
    // identity isn't tracked yet so we apply uniformly — false positives
    // here would surface as op-refused, which the operator can override
    // by varying params slightly. Acceptable failure mode.
    try {
      const { detectIdenticalLoop } = await import('./agent-coordination.js')
      const loop = detectIdenticalLoop({
        agentId: `brain-task:${taskId}`,
        action:  step.op,
        args:    step.params ?? {},
      })
      if (loop.inLoop) {
        results.push({ op: step.op, ok: false, error: `loop-detector refused: ${loop.reason}`, durationMs: 0 })
        await emit(workspaceId, 'brain_task.loop_detected', {
          taskId, op: step.op, identicalCount: loop.identicalCount, reason: loop.reason,
        })
        continue
      }
    } catch { /* tolerated — loop check is best-effort */ }

    // ─── Governance gate — was wired as a brain-task op but never
    //     auto-called. Now every op passes through governance.check
    //     before the handler runs. Verdicts:
    //       allow    → proceed silently
    //       approve  → require OPERATOR_APPROVED token (already gated above
    //                  for risk:high/critical; we add the gate for any
    //                  governance-matched op regardless of risk tier)
    //       escalate → record + surface; don't auto-execute
    //       block    → hard refuse
    let governanceVerdict = 'allow' as 'allow' | 'approve' | 'escalate' | 'block'
    try {
      const { check } = await import('./governance-engine.js')
      const gc = await check(workspaceId, step.op, JSON.stringify(step.params ?? {}).slice(0, 1000))
      governanceVerdict = gc.verdict
      // Helper — record trust on every governance-rejected outcome so
      // the EWMA reflects "op rejected" as low-trust signal.
      const recordRejection = async (reason: string) => {
        try {
          const { record: tr } = await import('./trust-reputation.js')
          await tr(workspaceId, `op:${step.op}`, false, 0, reason)
        } catch { /* */ }
      }
      if (gc.verdict === 'block') {
        results.push({ op: step.op, ok: false, error: `governance blocked: ${gc.explanation}`, durationMs: 0 })
        await emit(workspaceId, 'brain_task.governance_blocked', { taskId, op: step.op, verdict: gc.verdict, rules: gc.matchedRules })
        await recordRejection('governance:block')
        continue
      }
      if (gc.verdict === 'escalate') {
        results.push({ op: step.op, ok: false, error: `governance escalated to operator: ${gc.explanation}`, durationMs: 0 })
        await emit(workspaceId, 'brain_task.governance_escalated', { taskId, op: step.op, verdict: gc.verdict, rules: gc.matchedRules })
        await recordRejection('governance:escalate')
        continue
      }
      if (gc.verdict === 'approve' && approvalToken !== 'OPERATOR_APPROVED') {
        results.push({ op: step.op, ok: false, error: `governance requires approval: ${gc.explanation}`, durationMs: 0 })
        await recordRejection('governance:approval-missing')
        continue
      }
    } catch (e) {
      // Governance check is a control plane — fail CLOSED, not open.
      // Previously: any exception was swallowed and the op proceeded with
      // verdict='allow'. If governance-engine throws (DB down, rule parse
      // error), we must NOT allow the op through silently.
      const msg = (e as Error).message
      results.push({ op: step.op, ok: false, error: `governance unavailable (fail-closed): ${msg}`, durationMs: 0 })
      await emit(workspaceId, 'brain_task.governance_unavailable', { taskId, op: step.op, error: msg })
      continue
    }

    // Heartbeat the matching agent BEFORE the op so the brain sees
    // activity even if the op takes a while. Fire-and-forget.
    recordAgentActivityAsync(workspaceId, step.op, { status: 'running' })

    const t0 = Date.now()
    try {
      const data = await spec.handler(workspaceId, step.params ?? {})

      // Output guard — if the operation result itself contains financial
      // content (e.g. browser.text scraped a banking page), redact + flag.
      // Info-only ops (video metadata, web scrape) skip output guard since
      // their job is to surface what's on the page; the input URL guard
      // already prevents pointing them at financial hosts.
      const INFO_OPS_NO_OUTPUT_GUARD = new Set([
        // R138 — financial-data ops whose CORE PURPOSE is to surface money
        // figures to the operator. The money-guard's input check already
        // blocks money-pattern *commands* (e.g. "pay $500"); the output
        // check just needs to not block legitimate financial views.
        'portfolio.list', 'portfolio.improve', 'portfolio.report',
        'business.list', 'business.detail', 'business.feasibility', 'business.realityCheck',
        'business.create', 'business.sunset',
        'revenue.list', 'revenue.rollup', 'revenue.byBusiness',
        'budget.list', 'budget.detail', 'budget.alerts',
        'cost.summary', 'cost.byBusiness', 'cost.byProvider',
        'video.analyze', 'web.fetch', 'browser.text',
        'music.generate', 'music.replicate', 'music.status', 'music.master', 'music.knowledge',
        'music.vocalEnhance', 'music.scoreNaturalness', 'system.ffmpegAvailable',
        'music.fromImage', 'music.fromVideo', 'music.fromAudio',
        'mixcraft.status', 'mixcraft.compose',
        'capcut.status', 'video.scrapeAssets', 'video.editorAgent',
        'video.massProduce', 'video.knowledge',
        'tts.synthesize', 'captions.transcribe', 'captions.burn',
        'brand.saveKit', 'brand.loadKit', 'brand.apply',
        'video.repurpose',
        'broll.generate', 'broll.generateBatch',
        'cache.stats', 'cache.clear',
        'color.autoCorrect', 'color.applyGrade', 'color.applyLut',
        'audio.duckMix',
        // channel.save / channel.delete REMOVED from skip list —
        // saving a channel writes OAuth tokens + revenue metadata; the
        // output-guard scan must run so money-shaped fields in the
        // returned row (RPM caps, payout schedules) are redacted before
        // the brain echoes the result back to the operator.
        'channel.list',
        // analytics.snapshot/snapshotMany REMOVED from skip list —
        // they scrape revenue numbers (RPM/CTR/views) and the money-guard
        // output scan should redact financial content from results.
        'thumbnail.generate',
        'schedule.save', 'schedule.list', 'schedule.delete',
        'production.log', 'production.cancel', 'production.activeCancelTokens',
        'tts.status', 'gui.status',
        'bridge.claim', 'bridge.complete', 'bridge.status', 'bridge.listJobs', 'bridge.heartbeat',
        'risk.classify', 'risk.scan', 'risk.categories',
        'verify.opResult', 'verify.fileExists', 'verify.urlReachable',
        // world.upsertNode / world.upsertEdge REMOVED from skip list —
        // both write to the world graph; node attrs can carry cost_usd,
        // revenue_estimate, etc. that money-guard needs to scan.
        'world.neighbors', 'world.causalChain', 'world.listNodes',
        'twin.snapshotAll', 'twin.list',
        'economic.scoreVideo', 'economic.health', 'economic.simulatePricing',
        'governance.check', 'governance.listRules', 'governance.saveRule',
        'trust.record', 'trust.score', 'trust.topBroken',
        'wisdom.check', 'dna.get', 'dna.observe', 'physics.state',
        'evolve.discoverWeaknesses', 'wargame.simulate',
        'emergent.patterns', 'recap.generate',
        'kill_switch.list', 'kill_switch.enable', 'kill_switch.disable',
        // R139 — self-introspection ops. Their descriptions and signal
        // payloads legitimately reference financial concepts ("transfer",
        // "revenue", "$") because that IS the maturity/health signal.
        // Input guard still protects against money-pattern commands.
        'self.maturity', 'self.health', 'eval.seed',
        // R146.84 — playbook content legitimately discusses paid ads,
        // pricing, conversion economics, etc. Slugs like "paid-ads-
        // fundamentals" tripped the output redactor on the substring
        // "paid". Input guard remains active; this just exempts the
        // operator-authored knowledge surface from output scanning.
        'playbook.list', 'playbook.consult', 'playbook.reload',
        // R146.86 — experiment/hypothesis ops legitimately reference revenue,
        // CAC, LTV, costs etc. as their measured metrics. Input guard active.
        'experiment.create', 'experiment.list', 'experiment.conclude', 'experiment.abandon',
        'hypothesis.create', 'hypothesis.evidence', 'hypothesis.review', 'hypothesis.list',
        'calibration.curve',
        // R146.87 — CEO strategic ops legitimately reference revenue, budget,
        // and other financial metrics as their input/output domain.
        'ceo.prioritize', 'ceo.proposeReallocation', 'ceo.diversificationCheck',
        'ceo.setOkrs', 'ceo.readOkrs', 'ceo.retireAgents',
        'ceo.adversarialReview', 'ceo.operatorUnavailability',
        // R146.88-94 — brain / business-arch / learning / video / social / image / video-studio
        // ops all legitimately reference financial concepts (revenue, CAC, LTV,
        // budget, ad spend, runway, payouts) as their measured domain.
        'brain.classifySituation', 'brain.explainPlan', 'brain.bridgeMemories',
        'brain.detectStuckLoop',   'brain.captureCorrection',
        'productline.add', 'productline.list', 'business.runway',
        'competitor.add',  'competitor.list',
        'segment.define',  'segment.list',
        'business.suggestStageTransition', 'business.autoPostmortem',
        'prompt_ab.create', 'prompt_ab.pick', 'prompt_ab.outcome', 'prompt_ab.results',
        'memory.tagDurability', 'memory.deprecateStale',
        'knowledge.ingestExternal', 'models.compare',
        'video.matchBroll', 'video.analyzeRetention', 'video.platformHook',
        'video.recordTrend', 'video.listTrends',
        'video.thumbnailExposure', 'video.thumbnailWinner',
        'video.planRelocalization', 'video.planContinuity',
        'social.planRepurposing', 'social.queueResponse', 'social.listPendingResponses',
        'social.recommendCadence', 'social.audienceOverlap', 'social.triageCrisis',
        'influencer.add', 'influencer.outreachTemplate',
        'image.route', 'image.planCharacter', 'image.planUpscale',
        'image.defineStylePack', 'image.variationExposure', 'image.variationWinner',
        'image.planMockup',
        'aiVideo.planEpisode', 'aiVideo.generateShotList', 'aiVideo.routeShot',
        'aiVideo.buildContinuityPlan', 'aiVideo.planAssembly',
        'aiVideo.createSeries', 'aiVideo.listEpisodesInSeries',
        'aiVideo.planFeatureFilm',
        // R146.95-96 — real-money rendering + full execution; outputs include
        // cost figures the operator needs to see un-redacted.
        'aiVideo.renderShot', 'aiVideo.renderShotWithFallback',
        'aiVideo.executeEpisode',
        // R146.102 — postprod ops legitimately report $ projections + take costs.
        'aiVideo.projectCost', 'aiVideo.extractLastFrame',
        'aiVideo.renderMultipleTakes', 'aiVideo.selectBestTake',
        'aiVideo.synthesizeCharacterVoices', 'aiVideo.mixCharacterVoices',
        // R146.103 — stretching ops return savings + efficiency metrics.
        'aiVideo.stretchShotList', 'aiVideo.compressPrompt',
        'aiVideo.budgetAwarePlan', 'aiVideo.selectByEfficiency',
        'aiVideo.dedupShots',
        // R146.97 — autonomy budget ops legitimately return $ ceilings + spend.
        'autonomy.setBudget', 'autonomy.listBudgets', 'autonomy.disableBudget',
        'autonomy.checkSpend', 'autonomy.logSpend', 'autonomy.spendSummary',
        // R146.99 — image render ops return cost figures the operator needs.
        'image.render', 'image.renderWithFallback', 'image.renderRouted',
      ])
      const outGuard = INFO_OPS_NO_OUTPUT_GUARD.has(step.op)
        ? { ok: true as const }
        : guardOperation(step.op, { __result: data })
      if (!outGuard.ok) {
        results.push({
          op: step.op, ok: false,
          error: `money-guard redacted output: matched "${outGuard.matched}". Result contained financial content.`,
          durationMs: Date.now() - t0,
        })
        await emit(workspaceId, 'brain_task.money_blocked_output', {
          taskId, op: step.op, matched: outGuard.matched,
        })
        continue
      }

      const opDur = Date.now() - t0
      // ─── Realism gate — for ops that produce concrete artifacts
      //     (video files, audio files, thumbnails, published videos),
      //     verify the claimed output actually exists before reporting
      //     ok:true. Previously verifyOpComplete was exported but never
      //     auto-called → silent false-completion was possible.
      const ARTIFACT_OPS = new Set([
        'music.generate', 'music.replicate', 'music.master', 'music.fromImage',
        'music.fromVideo', 'music.fromAudio',
        'video.editorAgent', 'video.massProduce', 'video.repurpose',
        'video.scrapeAssets',
        'tts.synthesize',
        'captions.transcribe', 'captions.burn',
        'thumbnail.generate', 'broll.generate', 'broll.generateBatch',
        'color.autoCorrect', 'color.applyGrade', 'color.applyLut',
        'audio.duckMix', 'brand.apply',
        'mixcraft.compose', 'capcut.assemble', 'capcut.export',
      ])
      if (ARTIFACT_OPS.has(step.op) && data && typeof data === 'object') {
        try {
          const { verifyOpComplete } = await import('./realism-verifier.js')
          const check = await verifyOpComplete(data as Record<string, unknown>)
          if (!check.real) {
            // Silently degrade ok:true to ok:false with realism_gaps;
            // operator + LLM see the gaps so they can act.
            results.push({
              op: step.op, ok: false,
              error: `realism-gate: ${check.gaps.join('; ')}`,
              durationMs: opDur,
            })
            recordAgentActivityAsync(workspaceId, step.op, { status: 'error' })
            void emit(workspaceId, 'brain_task.realism_gate_failed', {
              taskId, op: step.op, gaps: check.gaps.slice(0, 5),
            })
            continue
          }
        } catch { /* realism check is best-effort */ }
      }
      results.push({ op: step.op, ok: true, data, durationMs: opDur })
      recordAgentActivityAsync(workspaceId, step.op, { status: 'idle' })
      // Fire-and-forget side effects — trust EWMA + governance-verdict
      // event MUST NOT block the response. Each adds 5-50ms of DB write
      // latency; multiply across mass-produce or schedule.tick and the
      // p95 doubles. Background-promise them instead.
      void (async () => {
        try {
          const { record: trustRecord } = await import('./trust-reputation.js')
          await trustRecord(workspaceId, `op:${step.op}`, true, opDur)
        } catch { /* */ }
      })()
      void emit(workspaceId, 'brain_task.op_completed', {
        taskId, op: step.op, durationMs: opDur,
        governance_verdict: governanceVerdict,
      })
    } catch (e) {
      const opDur = Date.now() - t0
      // Sanitize error message before persisting / emitting: handlers can
      // throw errors containing API keys (postgres-js dumps SQL +
      // parameters), file paths, or user input. Redact known patterns +
      // cap length so secrets don't leak into events / chains / trust
      // logs / SSE streams downstream consumers see.
      const rawMsg = (e as Error).message
      const errMsg = sanitizeErrorMessage(rawMsg)
      results.push({ op: step.op, ok: false, error: errMsg, durationMs: opDur })
      recordAgentActivityAsync(workspaceId, step.op, { status: 'error' })
      void (async () => {
        try {
          const { record: trustRecord } = await import('./trust-reputation.js')
          await trustRecord(workspaceId, `op:${step.op}`, false, opDur, errMsg.slice(0, 200))
        } catch { /* */ }
      })()
      void emit(workspaceId, 'brain_task.op_failed', {
        taskId, op: step.op, error: errMsg,
        governance_verdict: governanceVerdict,
      })
    }
  }

  const summary = composeSummary(task, results)
  const completedAt = Date.now()
  await emit(workspaceId, 'brain_task.completed', {
    taskId, task, durationMs: completedAt - startedAt,
    okCount:  results.filter(r => r.ok).length,
    errCount: results.filter(r => !r.ok).length,
  })
  return { taskId, workspaceId, task, startedAt, completedAt, plan, results, summary }
}

function composeSummary(task: string, results: TaskRunResult['results']): string {
  const ok = results.filter(r => r.ok).length
  const err = results.filter(r => !r.ok).length
  const ops = results.map(r => `${r.ok ? '✓' : '✗'} ${r.op}${r.error ? ` (${r.error})` : ''}`).join('\n  ')
  return `Task: ${task}\n  Result: ${ok} ok / ${err} failed\n  ${ops}`
}

// Avoid unused-import warnings — the explicit imports document the
// service surface this module touches at compile-time.
void codeProposals; void issues; void and; void eq
