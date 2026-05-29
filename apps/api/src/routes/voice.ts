/**
 * voice routes — /api/v1/voice/*
 *
 * Provider-agnostic speech layer endpoints.
 *
 *  GET  /providers/catalogue       — static catalogue of supported providers
 *  GET  /providers?workspace_id    — configured providers for a workspace
 *  POST /providers                 — upsert a provider config (vault keyRef only)
 *  POST /providers/:id/toggle      — enable/disable
 *  POST /route                     — request a routing decision (no side effects)
 *  POST /sessions                  — start a session (records voice_sessions row)
 *  POST /sessions/:id/event        — append a voice_events row (transcript, cost, failover, block, etc.)
 *  POST /sessions/:id/end          — close a session
 *  GET  /sessions?workspace_id     — recent sessions (war room)
 *  GET  /sessions/:id/events       — full event timeline for a session
 *  POST /classify                  — classify a spoken command (allow | confirm | block)
 *  GET  /presets                   — voice personality presets
 */
import type { FastifyPluginAsync } from 'fastify'
import { db } from '../db/client.js'
import { voiceSessions, voiceEvents, voiceDryRuns } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  PROVIDER_CATALOGUE, configureSpeechProvider, listProviders,
  setProviderEnabled, recordProviderHealth, getProviderDefinition,
} from '../services/speech-providers.js'
import {
  decideForWorkspace, VOICE_PRESETS, getPreset,
  type VoiceMode, type RoutingPreferences,
} from '../services/speech-router.js'
import { classifyCommand, preflightVoiceSession, isVoiceKilled, hasVoiceRole } from '../services/voice-safety.js'
import { parseIntent, VOICE_INTENT_CATALOGUE } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'
import { resolveTurn, deriveContextPatch } from '../services/voice-conversation.js'
import { getContext, patchContext, resetContext, recordQualityFeedback, providerQualityRollup, recentFeedback, summarizeSession } from '../services/voice-context-store.js'
import { getVoicePrefs, patchVoicePrefs, type WorkspaceVoicePrefs } from '../services/voice-preferences.js'
import { getHandler, supportedRealtimeProviders } from '../services/speech-provider-handlers.js'
import { gateTranscript } from '../services/voice-wake.js'
import { classifyForHandsFree } from '../services/voice-handsfree-policy.js'
import { refreshAmbientBriefings, pendingBriefings, markDelivered, ackBriefing } from '../services/voice-ambient.js'
import { getOperatorPrefs, patchOperatorPrefs, resetOperatorPrefs } from '../services/voice-operator-prefs.js'
import { listShortcuts, upsertShortcut, deleteShortcut, expandTranscript, recordShortcutUse } from '../services/voice-shortcuts.js'
import { recordObservation, rollupSkillMemory, eraseSkillMemory } from '../services/voice-skill-memory.js'
import { rollupVoiceMetrics } from '../services/voice-metrics.js'
import { naturalize, type NaturalizeMode } from '../services/voice-conversation.js'
import { recordDryRun, approveDryRun, executeDryRun, listDryRuns, getDryRun, shouldDryRun, type DryRunExecutor } from '../services/voice-dry-run.js'
import { events } from '../db/schema.js'

const voiceRoutes: FastifyPluginAsync = async (fastify) => {

  // ─── Server-side executor for approved dry-runs ──────────────────────
  // Uses fastify.inject so the dispatched call passes through the same
  // auth + rate-limit + audit chain as a real HTTP request. Headers are
  // forwarded from the inbound /execute request so per-user permissions
  // are preserved even when the executor is invoked server-side.
  const makeExecutor = (headers: Record<string, string | undefined>): DryRunExecutor => async (hook) => {
    const passHeaders: Record<string, string> = {}
    for (const k of ['authorization', 'x-user-id', 'x-workspace-id']) {
      const v = headers[k]
      if (typeof v === 'string') passHeaders[k] = v
    }
    const res = await fastify.inject({
      method:  hook.method,
      url:     hook.path,
      headers: { 'content-type': 'application/json', ...passHeaders },
      ...(hook.body ? { payload: hook.body } : {}),
    })
    let body: unknown = res.body
    try { body = JSON.parse(res.body) } catch { /* keep raw */ }
    return { status: res.statusCode, body }
  }

  // ─── Provider catalogue ────────────────────────────────────────────────
  fastify.get('/providers/catalogue', async () => {
    return { success: true, data: PROVIDER_CATALOGUE }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/providers', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listProviders(ws) }
  })

  fastify.post<{ Body: {
    workspace_id?: string; provider_id?: string; display_name?: string;
    endpoint?: string; key_ref?: string; enabled?: boolean;
    priority?: number; preferred_voice?: string; preferred_locale?: string;
    max_cost_per_min_usd?: number; max_latency_ms?: number;
  } }>('/providers', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.provider_id) return reply.code(400).send({ success: false, error: 'workspace_id, provider_id required' })
    try {
      const r = await configureSpeechProvider({
        workspaceId:      b.workspace_id,
        providerId:       b.provider_id,
        ...(b.display_name !== undefined ? { displayName: b.display_name } : {}),
        ...(b.endpoint !== undefined ? { endpoint: b.endpoint } : {}),
        ...(b.key_ref !== undefined ? { keyRef: b.key_ref } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.priority !== undefined ? { priority: b.priority } : {}),
        ...(b.preferred_voice !== undefined ? { preferredVoice: b.preferred_voice } : {}),
        ...(b.preferred_locale !== undefined ? { preferredLocale: b.preferred_locale } : {}),
        ...(b.max_cost_per_min_usd !== undefined ? { maxCostPerMinUsd: b.max_cost_per_min_usd } : {}),
        ...(b.max_latency_ms !== undefined ? { maxLatencyMs: b.max_latency_ms } : {}),
      })
      return reply.code(201).send({ success: true, data: r })
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.post<{ Params: { id: string }, Body: { workspace_id?: string; enabled?: boolean } }>('/providers/:id/toggle', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const enabled = !!req.body.enabled
    await setProviderEnabled(ws, req.params.id, enabled)
    return { success: true, data: { provider_id: req.params.id, enabled } }
  })

  // ─── Routing decision (read-only) ─────────────────────────────────────
  fastify.post<{ Body: {
    workspace_id?: string; mode?: VoiceMode; locale?: string; preset?: string;
    max_latency_ms?: number; max_cost_per_min_usd?: number; require_interruption?: boolean;
  } }>('/route', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const prefs: RoutingPreferences = {
      mode: b.mode ?? 'realtime',
      ...(b.locale !== undefined ? { locale: b.locale } : {}),
      ...(b.preset !== undefined ? { preset: b.preset } : {}),
      ...(b.max_latency_ms !== undefined ? { maxLatencyMs: b.max_latency_ms } : {}),
      ...(b.max_cost_per_min_usd !== undefined ? { maxCostPerMinUsd: b.max_cost_per_min_usd } : {}),
      ...(b.require_interruption !== undefined ? { requireInterruption: b.require_interruption } : {}),
    }
    const decision = await decideForWorkspace(b.workspace_id, prefs)
    return { success: true, data: { ...decision, killSwitch: isVoiceKilled() } }
  })

  // ─── Sessions ──────────────────────────────────────────────────────────
  fastify.post<{ Body: {
    workspace_id?: string; user_id?: string; mode?: VoiceMode; preset?: string;
    locale?: string; max_latency_ms?: number; max_cost_per_min_usd?: number;
    require_interruption?: boolean; transcript_retained?: boolean;
    estimated_cost_usd?: number;
  } }>('/sessions', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const mode: VoiceMode = b.mode ?? 'realtime'
    const prefs: RoutingPreferences = {
      mode,
      ...(b.locale !== undefined ? { locale: b.locale } : {}),
      ...(b.preset !== undefined ? { preset: b.preset } : {}),
      ...(b.max_latency_ms !== undefined ? { maxLatencyMs: b.max_latency_ms } : {}),
      ...(b.max_cost_per_min_usd !== undefined ? { maxCostPerMinUsd: b.max_cost_per_min_usd } : {}),
      ...(b.require_interruption !== undefined ? { requireInterruption: b.require_interruption } : {}),
    }
    const decision = await decideForWorkspace(b.workspace_id, prefs)
    if (!decision.ok || !decision.primary) {
      return reply.code(409).send({ success: false, error: decision.reason ?? 'no provider available', decision })
    }

    const sessionId = uuidv7()
    const pre = await preflightVoiceSession({
      workspaceId:      b.workspace_id,
      ...(b.user_id !== undefined ? { userId: b.user_id } : {}),
      providerId:       decision.primary,
      estimatedCostUsd: b.estimated_cost_usd ?? 0.05,
      executionId:      sessionId,
    })
    if (!pre.ok) return reply.code(403).send({ success: false, error: pre.reason })

    await db.insert(voiceSessions).values({
      id: sessionId,
      workspaceId:        b.workspace_id,
      userId:             b.user_id ?? null,
      mode,
      preset:             b.preset ?? 'calm_operator',
      selectedProvider:   decision.primary,
      fallbackChain:      decision.fallbackChain,
      startedAt:          Date.now(),
      transcriptRetained: b.transcript_retained ?? true,
      status:             'active',
    })
    return reply.code(201).send({
      success: true,
      data: {
        session_id: sessionId,
        selected_provider: decision.primary,
        fallback_chain: decision.fallbackChain,
        mode, decision,
      },
    })
  })

  fastify.post<{ Params: { id: string }, Body: {
    workspace_id?: string; kind?: string; role?: string; text?: string;
    provider?: string; latency_ms?: number; cost_usd?: number; meta?: Record<string, unknown>;
  } }>('/sessions/:id/event', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.kind) return reply.code(400).send({ success: false, error: 'workspace_id, kind required' })
    await db.insert(voiceEvents).values({
      id: uuidv7(),
      sessionId:    req.params.id,
      workspaceId:  b.workspace_id,
      kind:         b.kind,
      role:         b.role ?? null,
      text:         b.text ?? null,
      provider:     b.provider ?? null,
      latencyMs:    b.latency_ms ?? null,
      costUsd:      b.cost_usd ?? null,
      meta:         b.meta ?? null,
      createdAt:    Date.now(),
    })
    // Side effects: failover/block counters + provider health
    if (b.kind === 'failover') {
      await db.update(voiceSessions)
        .set({ failoverCount: (await db.select().from(voiceSessions).where(eq(voiceSessions.id, req.params.id)).limit(1).then(r => r[0]?.failoverCount ?? 0) ?? 0) + 1 })
        .where(eq(voiceSessions.id, req.params.id)).catch(() => null)
      if (b.provider) await recordProviderHealth(b.workspace_id, b.provider, false, b.latency_ms ?? 0, 'failover').catch(() => null)
    }
    if (b.kind === 'block') {
      const cur = await db.select().from(voiceSessions).where(eq(voiceSessions.id, req.params.id)).limit(1).then(r => r[0]?.blockedCommands ?? 0) ?? 0
      await db.update(voiceSessions).set({ blockedCommands: cur + 1 })
        .where(eq(voiceSessions.id, req.params.id)).catch(() => null)
    }
    if (b.kind === 'tts' && b.provider && typeof b.latency_ms === 'number') {
      await recordProviderHealth(b.workspace_id, b.provider, true, b.latency_ms).catch(() => null)
    }
    return reply.code(201).send({ success: true })
  })

  fastify.post<{ Params: { id: string }, Body: { workspace_id?: string; total_cost_usd?: number; avg_latency_ms?: number; first_audio_ms?: number } }>('/sessions/:id/end', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.update(voiceSessions).set({
      endedAt: Date.now(),
      status: 'ended',
      totalCostUsd: req.body.total_cost_usd ?? 0,
      avgLatencyMs: req.body.avg_latency_ms ?? null,
      firstAudioMs: req.body.first_audio_ms ?? null,
    }).where(and(eq(voiceSessions.id, req.params.id), eq(voiceSessions.workspaceId, ws)))
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string; limit?: string } }>('/sessions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const lim = req.query.limit ? Math.min(200, Number(req.query.limit)) : 50
    const where = req.query.status
      ? and(eq(voiceSessions.workspaceId, ws), eq(voiceSessions.status, req.query.status))
      : eq(voiceSessions.workspaceId, ws)
    const rows = await db.select().from(voiceSessions).where(where).orderBy(desc(voiceSessions.startedAt)).limit(lim).catch(() => [])
    return { success: true, data: rows }
  })

  fastify.get<{ Params: { id: string }, Querystring: { workspace_id?: string } }>('/sessions/:id/events', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(voiceEvents)
      .where(and(eq(voiceEvents.sessionId, req.params.id), eq(voiceEvents.workspaceId, ws)))
      .orderBy(voiceEvents.createdAt).limit(500).catch(() => [])
    return { success: true, data: rows }
  })

  // ─── Command classification (allow | confirm | block) ────────────────
  fastify.post<{ Body: { text?: string } }>('/classify', async (req, reply) => {
    const text = (req.body.text ?? '').toString()
    if (!text.trim()) return reply.code(400).send({ success: false, error: 'text required' })
    return { success: true, data: classifyCommand(text) }
  })

  // ─── Voice presets ────────────────────────────────────────────────────
  fastify.get('/presets', async () => {
    return { success: true, data: VOICE_PRESETS }
  })
  fastify.get<{ Params: { id: string } }>('/presets/:id', async (req) => {
    return { success: true, data: getPreset(req.params.id) }
  })

  // ─── Health snapshot (war room) ───────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/health', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const providers = await listProviders(ws)
    const active = await db.select().from(voiceSessions)
      .where(and(eq(voiceSessions.workspaceId, ws), eq(voiceSessions.status, 'active')))
      .limit(50).catch(() => [])
    return {
      success: true,
      data: {
        killSwitch:        isVoiceKilled(),
        enabledProviders:  providers.filter(p => p.enabled).length,
        totalProviders:    providers.length,
        activeSessions:    active.length,
        catalogueSize:     PROVIDER_CATALOGUE.length,
      },
    }
  })

  // ─── Intent parsing (read-only) ───────────────────────────────────────
  fastify.post<{ Body: { text?: string } }>('/intent', async (req, reply) => {
    const text = (req.body.text ?? '').toString()
    if (!text.trim()) return reply.code(400).send({ success: false, error: 'text required' })
    return { success: true, data: parseIntent(text) }
  })

  fastify.get('/intent/catalogue', async () => {
    return { success: true, data: VOICE_INTENT_CATALOGUE }
  })

  // ─── Command (parse + route + log) ────────────────────────────────────
  fastify.post<{ Body: {
    text?: string; workspace_id?: string; session_id?: string; roles?: string[];
  } }>('/command', async (req, reply) => {
    const text = (req.body.text ?? '').toString()
    const ws   = req.body.workspace_id
    if (!text.trim() || !ws) return reply.code(400).send({ success: false, error: 'text, workspace_id required' })
    if (isVoiceKilled()) return reply.code(403).send({ success: false, error: 'voice kill switch is engaged' })
    if (!hasVoiceRole(req.body.roles)) return reply.code(403).send({ success: false, error: 'caller lacks voice.use role' })

    // Wake-phrase gating (applied to the raw transcript before any other
    // processing). When the workspace requires wake AND the request says
    // `apply_wake: true`, drop transcripts that do not contain a phrase.
    const prefs = await getVoicePrefs(ws).catch(() => null)
    const userId = (req.body as { user_id?: string }).user_id ?? null
    const operatorPrefs = userId ? await getOperatorPrefs(ws, userId).catch(() => null) : null
    const applyWake = (req.body as { apply_wake?: boolean }).apply_wake === true
    let effectiveText = text

    // ── Shortcut expansion (runs BEFORE wake so a configured shortcut
    //    like "daily scan" doesn't need a wake prefix). The matched
    //    shortcut's `useCount` is incremented for analytics.
    let appliedShortcut: { id: string; phrase: string } | null = null
    const shortcuts = await listShortcuts(ws, userId ?? undefined).catch(() => [])
    const expanded = expandTranscript(text, shortcuts)
    if (expanded) {
      effectiveText  = expanded.expansion
      appliedShortcut = { id: expanded.id, phrase: expanded.phrase }
      await recordShortcutUse(expanded.id).catch(() => null)
    }
    let wakeMatched: { matched: boolean; phrase: string | null } | null = null
    if (applyWake && prefs?.wakeEnabled) {
      // A shortcut already implies operator intent; skip wake when a
      // shortcut was matched so the expansion is honored directly.
      const gate = appliedShortcut
        ? { ok: true, remainder: effectiveText, wake: { matched: true, phrase: null, remainder: effectiveText, cutAt: -1 } as { matched: boolean; phrase: string | null } }
        : gateTranscript(text, { wakeRequired: true, phrases: prefs.wakePhrases })
      if (!gate.ok) {
        return reply.code(200).send({ success: true, data: { skipped: true, reason: 'no wake phrase detected' } })
      }
      effectiveText = (gate.remainder || effectiveText) as string
      wakeMatched = gate.wake ? { matched: gate.wake.matched, phrase: gate.wake.phrase } : null
      if (wakeMatched) {
        await db.insert(events).values({
          id: uuidv7(), type: 'voice.wake_detected', workspaceId: ws,
          payload: { phrase: wakeMatched.phrase, remainder: effectiveText },
          traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
          source: 'api/voice-command', version: 1, createdAt: Date.now(),
        }).catch(() => null)
      }
    }

    // When a session_id is provided we resolve the turn against persistent
    // context (carryover, meta-commands, naturalized speech). Without one
    // we fall back to a stateless intent+route.
    let intent, plan, meta: string | null = null, naturalSpeak = '', clarification: string | undefined, carryover: unknown = null
    let handsFree: { verdict: string; reason: string; category: string } | null = null
    if (req.body.session_id) {
      const ctx = await getContext(req.body.session_id, ws)
      const turn = resolveTurn(effectiveText, ctx)
      intent = turn.intent
      plan   = turn.plan
      meta   = turn.meta
      naturalSpeak = turn.naturalSpeak
      clarification = turn.clarification
      carryover = turn.carryover ?? null
      // Persist context patch (best-effort)
      await patchContext(req.body.session_id, ws, deriveContextPatch(turn, ctx)).catch(() => null)
      // Append voice_events row
      await db.insert(voiceEvents).values({
        id: uuidv7(),
        sessionId:   req.body.session_id,
        workspaceId: ws,
        kind:        plan.verdict === 'reject' ? 'block' : meta === 'clarify' ? 'clarify' : plan.verdict === 'confirm' ? 'confirm' : 'command',
        role:        'user',
        text,
        meta:        { intent: intent.kind, target: intent.target ?? null, confidence: intent.confidence, verdict: plan.verdict, risk: plan.risk, matched: intent.matched ?? null, conversationMeta: meta, carryover },
        createdAt:   Date.now(),
      }).catch(() => null)
    } else {
      intent = parseIntent(effectiveText)
      plan   = routeIntent(intent, effectiveText)
      naturalSpeak = plan.speak
    }

    // ── Adaptive naturalization driven by operator response mode +
    //    "known workflow" heuristic. Risky actions still get detailed
    //    speech so the operator hears the full reason.
    if (operatorPrefs) {
      let mode: NaturalizeMode =
        operatorPrefs.responseMode === 'engineer' ? 'engineer' :
        operatorPrefs.responseMode === 'executive' ? 'executive' :
        operatorPrefs.responseMode === 'brain_ui' ? 'brain_ui' :
        operatorPrefs.preferredLength === 'detailed' ? 'detailed' :
        operatorPrefs.preferredLength === 'short' ? 'fast' : 'normal'
      // Risky/confirm plans get more detail regardless of preference.
      if (plan.verdict === 'confirm' && plan.risk !== 'low') mode = 'detailed'
      naturalSpeak = naturalize(plan.speak, mode)
    }

    // ── Skill memory writes — corrections, brain-node usage,
    //    low-confidence misunderstanding records.
    if (intent.kind !== 'unknown') {
      if (intent.kind.startsWith('brain.') && intent.target) {
        await recordObservation({
          workspaceId: ws, userId, sessionId: req.body.session_id ?? null,
          kind: 'brain_node', phrase: effectiveText, intentKind: intent.kind, nodeId: String(intent.target),
          confidence: intent.confidence,
        }).catch(() => null)
      }
      if (plan.verdict !== 'reject') {
        await recordObservation({
          workspaceId: ws, userId, sessionId: req.body.session_id ?? null,
          kind: 'preferred_action', phrase: effectiveText, intentKind: intent.kind, confidence: intent.confidence,
        }).catch(() => null)
      }
    }
    if (meta === 'correction') {
      // The previous turn's lastPlan tells us what we initially routed
      const fromIntent = (await (req.body.session_id ? getContext(req.body.session_id, ws) : Promise.resolve(null)).catch(() => null))?.lastPlan?.intent.kind ?? null
      await recordObservation({
        workspaceId: ws, userId, sessionId: req.body.session_id ?? null,
        kind: 'corrected', phrase: effectiveText,
        ...(fromIntent ? { fromIntent } : {}),
        toIntent: intent.kind, confidence: intent.confidence,
      }).catch(() => null)
    }
    if (meta === 'clarify' || (intent.kind === 'unknown' && effectiveText.length > 2)) {
      await recordObservation({
        workspaceId: ws, userId, sessionId: req.body.session_id ?? null,
        kind: 'misunderstood', phrase: effectiveText,
        ...(intent.kind === 'unknown' ? {} : { intentKind: intent.kind }),
        confidence: intent.confidence,
      }).catch(() => null)
    }

    // Hands-free policy: when the operator enabled hands-free, downgrade
    // safe intents from confirm→execute and surface require_approval for
    // mutating ones. Never override a hard-block.
    if (prefs?.handsFreeEnabled) {
      const decision = classifyForHandsFree({
        enabled: true,
        allowedIntents: prefs.handsFreeAllowedIntents,
        plan,
      })
      handsFree = { verdict: decision.verdict, reason: decision.reason, category: decision.category }
      if (decision.verdict === 'allow' && plan.verdict === 'confirm') {
        // Promote: confirm → execute (still emits the audit trail)
        plan = { ...plan, verdict: 'execute' as const }
      }
      if (decision.verdict === 'block' && plan.verdict !== 'reject') {
        plan = { ...plan, verdict: 'reject' as const, speak: 'Refusing — hands-free policy blocks this action.', reason: decision.reason }
      }
    }

    // Dry-run interception: for any risky/mutating plan we create a
    // dry-run row instead of letting the frontend run the executor
    // directly. The frontend renders the preview drawer and must call
    // /dry-run/:id/approve twice (spoken + UI) followed by /execute.
    let dryRun: { id: string; report: unknown } | null = null
    if (shouldDryRun(plan)) {
      dryRun = await recordDryRun({
        workspaceId: ws,
        userId, sessionId: req.body.session_id ?? null,
        command: effectiveText, plan,
      })
      const report = dryRun.report as { spokenPreview: string }
      naturalSpeak = report.spokenPreview
      // Stash the dry-run id in conversation context so spoken approval
      // ("approve dry run") on a later turn can find it.
      if (req.body.session_id) {
        await patchContext(req.body.session_id, ws, { pendingDryRunId: dryRun.id }).catch(() => null)
      }
    }

    // ── Spoken approval / rejection via voice ──────────────────────────
    // When the conversation resolver detected an approve_dry_run meta
    // and the session has a pendingDryRunId, run the dual-channel
    // approval AND execute it server-side. The frontend's UI approval
    // path is still available; this just adds a hands-free path.
    let spokenExec: { ok: boolean; reason?: string; result?: unknown; dryRunId?: string } | null = null
    if (meta === 'approve_dry_run') {
      const targetId = (intent.args['dry_run_id'] as string | undefined) ?? null
      if (targetId) {
        const ap = await approveDryRun({ id: targetId, workspaceId: ws, source: 'spoken' })
        if (!ap.ok) {
          spokenExec = { ok: false, ...(ap.reason ? { reason: ap.reason } : {}), dryRunId: targetId }
        } else {
          // UI hasn't approved yet — surface that to the operator
          if (!ap.fullyApproved) {
            spokenExec = { ok: false, reason: 'spoken approval recorded — still waiting for UI approval', dryRunId: targetId }
          } else {
            const ex = await executeDryRun({
              id: targetId, workspaceId: ws, via: 'spoken',
              executor: makeExecutor(req.headers as Record<string, string | undefined>),
            })
            spokenExec = { ok: ex.ok, ...(ex.reason ? { reason: ex.reason } : {}), result: ex.result, dryRunId: targetId }
          }
        }
        naturalSpeak = spokenExec?.ok ? 'Done.' : `Could not execute: ${spokenExec?.reason ?? 'unknown'}`
      }
    }
    if (meta === 'reject_dry_run') {
      const targetId = (intent.args['dry_run_id'] as string | null | undefined) ?? null
      if (targetId) {
        await db.update(voiceDryRuns)
          .set({ status: 'rejected', rejectedReason: 'spoken_reject' })
          .where(and(eq(voiceDryRuns.id, targetId), eq(voiceDryRuns.workspaceId, ws)))
          .catch(() => null)
        spokenExec = { ok: true, dryRunId: targetId, reason: 'rejected' }
      }
    }

    // Emit an audit event regardless of session presence — every voice action is observable
    await db.insert(events).values({
      id: uuidv7(),
      type: `voice.${intent.kind}`,
      workspaceId: ws,
      payload: {
        text: effectiveText, intent, meta,
        plan: { verdict: plan.verdict, risk: plan.risk, navigate: plan.navigate, execute: plan.execute },
        ...(wakeMatched ? { wake: wakeMatched } : {}),
        ...(handsFree ? { handsFree } : {}),
        ...(dryRun ? { dryRunId: dryRun.id } : {}),
      },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'api/voice-command', version: 1, createdAt: Date.now(),
    }).catch(() => null)

    return { success: true, data: { ...plan, meta, naturalSpeak, clarification, carryover, wake: wakeMatched, handsFree, shortcut: appliedShortcut, dryRun, spokenExec } }
  })

  // ─── Dry-run lifecycle ────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; status?: string; limit?: string } }>('/dry-runs', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const status = req.query.status as 'pending' | 'approved' | 'executed' | 'rejected' | 'expired' | undefined
    return { success: true, data: await listDryRuns(ws, { ...(status ? { status } : {}), limit: req.query.limit ? Number(req.query.limit) : 50 }) }
  })
  fastify.get<{ Params: { id: string }, Querystring: { workspace_id?: string } }>('/dry-runs/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await getDryRun(req.params.id, ws)
    if (!row) return reply.code(404).send({ success: false, error: 'not found' })
    return { success: true, data: row }
  })
  fastify.post<{ Params: { id: string }, Body: { workspace_id?: string; source?: 'spoken' | 'ui' } }>('/dry-runs/:id/approve', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    if (req.body.source !== 'spoken' && req.body.source !== 'ui') return reply.code(400).send({ success: false, error: 'source must be "spoken" or "ui"' })
    const r = await approveDryRun({ id: req.params.id, workspaceId: ws, source: req.body.source })
    if (!r.ok) return reply.code(409).send({ success: false, error: r.reason })
    return { success: true, data: r }
  })
  fastify.post<{ Params: { id: string }, Body: { workspace_id?: string; via?: 'spoken' | 'ui' | 'server' } }>('/dry-runs/:id/execute', {
    // Dry-run execution triggers real platform actions — tight 30/min cap.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await executeDryRun({
      id: req.params.id, workspaceId: ws,
      via: req.body.via ?? 'ui',
      executor: makeExecutor(req.headers as Record<string, string | undefined>),
    })
    if (!r.ok) return reply.code(409).send({ success: false, error: r.reason, status: r.status, result: r.result })
    return { success: true, data: r }
  })

  // ─── Conversation context ─────────────────────────────────────────────
  fastify.get<{ Params: { id: string }, Querystring: { workspace_id?: string } }>('/sessions/:id/context', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getContext(req.params.id, ws) }
  })
  fastify.patch<{ Params: { id: string }, Body: { workspace_id?: string; patch?: Record<string, unknown> } }>('/sessions/:id/context', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await patchContext(req.params.id, ws, (req.body.patch ?? {}) as Record<string, never>)
    return { success: true }
  })
  fastify.delete<{ Params: { id: string } }>('/sessions/:id/context', async (req) => {
    await resetContext(req.params.id)
    return { success: true }
  })

  // ─── Voice quality feedback ───────────────────────────────────────────
  fastify.post<{ Body: {
    workspace_id?: string; session_id?: string; provider?: string;
    ratings?: { naturalness?: number; speed?: number; clarity?: number; tone?: number; usefulness?: number };
    comment?: string;
  } }>('/feedback', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.session_id || !b.ratings) {
      return reply.code(400).send({ success: false, error: 'workspace_id, session_id, ratings required' })
    }
    const r = await recordQualityFeedback({
      sessionId: b.session_id, workspaceId: b.workspace_id,
      ...(b.provider !== undefined ? { provider: b.provider } : {}),
      ratings: b.ratings,
      ...(b.comment !== undefined ? { comment: b.comment } : {}),
    })
    return reply.code(201).send({ success: true, data: r })
  })

  fastify.get<{ Querystring: { workspace_id?: string; since_days?: string } }>('/feedback/rollup', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const since = req.query.since_days ? Number(req.query.since_days) * 86_400_000 : 30 * 86_400_000
    return { success: true, data: await providerQualityRollup(ws, since) }
  })
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/feedback', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentFeedback(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })

  // ─── Realtime session minting (server reads vault key → browser gets ephemeral token) ───
  fastify.post<{ Body: { workspace_id?: string; provider_id?: string; locale?: string; voice?: string; session_id?: string } }>('/realtime/session', {
    // Realtime voice session opens an outbound stream to a TTS/STT
    // provider — expensive, cap at 10/min/IP.
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.provider_id) return reply.code(400).send({ success: false, error: 'workspace_id, provider_id required' })
    if (isVoiceKilled()) return reply.code(403).send({ success: false, error: 'voice kill switch engaged' })

    const providers = await listProviders(b.workspace_id)
    const cfg = providers.find(p => p.providerId === b.provider_id && p.enabled)
    if (!cfg) return reply.code(404).send({ success: false, error: `provider ${b.provider_id} not configured or disabled` })

    const handler = getHandler(b.provider_id)
    const result = await handler.mintSession({
      workspaceId: b.workspace_id,
      cfg:         cfg as unknown as Parameters<typeof handler.mintSession>[0]['cfg'],
      locale:      b.locale ?? cfg.preferredLocale ?? 'en-US',
      ...(b.voice !== undefined ? { voice: b.voice } : (cfg.preferredVoice ? { voice: cfg.preferredVoice } : {})),
    })

    // Audit (success + failure) — raw token never leaves this response
    await db.insert(events).values({
      id: uuidv7(),
      type: result.ok ? 'voice.realtime.minted' : 'voice.realtime.mint_failed',
      workspaceId: b.workspace_id,
      payload: {
        provider: b.provider_id,
        session_id: b.session_id ?? null,
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        provider_session_id: result.ok ? result.session.providerSessionId : null,
      },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'api/voice-realtime', version: 1, createdAt: Date.now(),
    }).catch(() => null)

    // Health rollup: a mint failure decays provider health so the router
    // will route around it on the next /route call.
    if (!result.ok) {
      const { recordProviderHealth } = await import('../services/speech-providers.js')
      await recordProviderHealth(b.workspace_id, b.provider_id, false, 0, result.reason).catch(() => null)
      return reply.code(502).send({ success: false, error: result.reason })
    }
    return reply.code(201).send({ success: true, data: result.session })
  })

  // Server-side barge-in propagation. For WebRTC providers the browser
  // also sends the cancel frame on its data channel — this endpoint is
  // the authoritative audit trail and the path for providers where the
  // server proxies the WS.
  fastify.post<{ Params: { provider_id: string }, Body: { workspace_id?: string; provider_session_id?: string; voice_session_id?: string } }>('/realtime/:provider_id/barge', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const handler = getHandler(req.params.provider_id)
    const providers = await listProviders(ws)
    const cfg = providers.find(p => p.providerId === req.params.provider_id)
    if (!cfg) return reply.code(404).send({ success: false, error: 'provider not configured' })
    const r = handler.bargeIn
      ? await handler.bargeIn({ workspaceId: ws, cfg: cfg as Parameters<typeof handler.bargeIn>[0]['cfg'], locale: cfg.preferredLocale ?? 'en-US' }, req.body.provider_session_id ?? '')
      : { ok: true, reason: 'no-op (handler has no bargeIn)' }
    // Append to voice_events when a voice session is associated
    if (req.body.voice_session_id) {
      await db.insert(voiceEvents).values({
        id: uuidv7(),
        sessionId:   req.body.voice_session_id,
        workspaceId: ws,
        kind:        'barge_in',
        role:        'user',
        provider:    req.params.provider_id,
        meta:        { ok: r.ok, reason: r.reason ?? null, provider_session_id: req.body.provider_session_id ?? null },
        createdAt:   Date.now(),
      }).catch(() => null)
    }
    await db.insert(events).values({
      id: uuidv7(),
      type: 'voice.realtime.barge_in',
      workspaceId: ws,
      payload: { provider: req.params.provider_id, ...r },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'api/voice-realtime', version: 1, createdAt: Date.now(),
    }).catch(() => null)
    return { success: true, data: r }
  })

  fastify.get('/realtime/providers', async () => {
    return { success: true, data: supportedRealtimeProviders() }
  })

  // ─── Ambient briefings ───────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; window_ms?: number; floor?: 'normal' | 'high' | 'critical' } }>('/ambient/refresh', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const prefs = await getVoicePrefs(ws).catch(() => null)
    if (prefs && !prefs.ambientAlertsEnabled) return reply.code(200).send({ success: true, data: { skipped: true, reason: 'ambient_alerts_enabled is off' } })
    const floor = req.body.floor ?? prefs?.ambientSeverityFloor ?? 'critical'
    const r = await refreshAmbientBriefings(ws, { floor, windowMs: req.body.window_ms ?? 30 * 60_000 })
    return { success: true, data: r }
  })
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/ambient/pending', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await pendingBriefings(ws, req.query.limit ? Number(req.query.limit) : 5) }
  })
  fastify.post<{ Body: { id?: string } }>('/ambient/delivered', async (req, reply) => {
    if (!req.body.id) return reply.code(400).send({ success: false, error: 'id required' })
    await markDelivered(req.body.id)
    return { success: true }
  })
  fastify.post<{ Body: { id?: string } }>('/ambient/ack', async (req, reply) => {
    if (!req.body.id) return reply.code(400).send({ success: false, error: 'id required' })
    await ackBriefing(req.body.id)
    return { success: true }
  })

  // ─── Session summary ──────────────────────────────────────────────────
  fastify.get<{ Params: { id: string }, Querystring: { workspace_id?: string } }>('/sessions/:id/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const s = await summarizeSession(req.params.id, ws)
    if (!s) return reply.code(404).send({ success: false, error: 'session not found' })
    return { success: true, data: s }
  })

  // ─── Operator preferences (per-user) ──────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; user_id?: string } }>('/operator-prefs', async (req, reply) => {
    const { workspace_id, user_id } = req.query
    if (!workspace_id || !user_id) return reply.code(400).send({ success: false, error: 'workspace_id, user_id required' })
    return { success: true, data: await getOperatorPrefs(workspace_id, user_id) }
  })
  fastify.patch<{ Body: { workspace_id?: string; user_id?: string; patch?: Record<string, unknown> } }>('/operator-prefs', async (req, reply) => {
    const { workspace_id, user_id } = req.body
    if (!workspace_id || !user_id) return reply.code(400).send({ success: false, error: 'workspace_id, user_id required' })
    return { success: true, data: await patchOperatorPrefs(workspace_id, user_id, (req.body.patch ?? {}) as Record<string, never>) }
  })
  fastify.delete<{ Querystring: { workspace_id?: string; user_id?: string } }>('/operator-prefs', async (req, reply) => {
    const { workspace_id, user_id } = req.query
    if (!workspace_id || !user_id) return reply.code(400).send({ success: false, error: 'workspace_id, user_id required' })
    await resetOperatorPrefs(workspace_id, user_id)
    return { success: true }
  })

  // ─── Custom voice shortcuts ───────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; user_id?: string } }>('/shortcuts', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listShortcuts(ws, req.query.user_id) }
  })
  fastify.post<{ Body: { workspace_id?: string; user_id?: string; phrase?: string; expansion?: string; description?: string; enabled?: boolean } }>('/shortcuts', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.phrase || !b.expansion) return reply.code(400).send({ success: false, error: 'workspace_id, phrase, expansion required' })
    try {
      const r = await upsertShortcut({
        workspaceId: b.workspace_id,
        userId:      b.user_id ?? null,
        phrase:      b.phrase, expansion: b.expansion,
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      })
      return reply.code(201).send({ success: true, data: r })
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })
  fastify.delete<{ Params: { id: string }, Querystring: { workspace_id?: string } }>('/shortcuts/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await deleteShortcut(req.params.id, ws)
    return { success: true }
  })

  // ─── Skill memory rollup + erasure ────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; user_id?: string; window_days?: string } }>('/skill-memory', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 30 * 86_400_000
    return { success: true, data: await rollupSkillMemory(ws, { ...(req.query.user_id ? { userId: req.query.user_id } : {}), windowMs }) }
  })
  fastify.delete<{ Querystring: { workspace_id?: string; user_id?: string } }>('/skill-memory', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await eraseSkillMemory(ws, req.query.user_id)
    return { success: true }
  })

  // ─── Voice performance metrics ────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/metrics', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 7 * 86_400_000
    return { success: true, data: await rollupVoiceMetrics(ws, { windowMs }) }
  })

  // ─── Workspace preferences ────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/preferences', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getVoicePrefs(ws) }
  })
  fastify.patch<{ Body: { workspace_id?: string; patch?: Partial<WorkspaceVoicePrefs> } }>('/preferences', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await patchVoicePrefs(ws, req.body.patch ?? {}) }
  })

  // Stub: surface a provider catalogue entry for the UI tooltip
  fastify.get<{ Params: { id: string } }>('/providers/catalogue/:id', async (req, reply) => {
    const def = getProviderDefinition(req.params.id)
    if (!def) return reply.code(404).send({ success: false, error: 'unknown provider' })
    return { success: true, data: def }
  })
}

export default voiceRoutes
