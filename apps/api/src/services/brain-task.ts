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

export const OPERATIONS: Record<string, OpSpec> = {
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

  // ─── R333 Operator Capability Mirror ───────────────────────────
  'provider.health.probe_all': {
    description: 'R333: Probe every wired provider for liveness; classify failures (auth_revoked/billing_exhausted/rate_limited/network); persist for routers to skip dead providers.',
    risk: 'low',
    handler: async () => {
      const { probeAll } = await import('./r333-provider-health-monitor.js')
      return probeAll()
    },
  },
  'provider.health.snapshot': {
    description: 'R333: Read the latest health snapshot (no probe).',
    risk: 'low',
    handler: async () => {
      const { getHealthSnapshot, canGenerateImagesNow } = await import('./r333-provider-health-monitor.js')
      return { snapshot: await getHealthSnapshot(), imageGen: await canGenerateImagesNow() }
    },
  },
  'capability.list': {
    description: 'R333: List every operator capability + whether Novan does it autonomously yet.',
    risk: 'low',
    handler: async () => {
      const { CAPABILITIES, capabilityReport } = await import('./r333-operator-capability-mirror.js')
      return { all: CAPABILITIES, report: capabilityReport() }
    },
  },
  'capability.gaps': {
    description: 'R333: Just the gaps — capabilities not yet implemented at Novan-autonomous level.',
    risk: 'low',
    handler: async () => {
      const { capabilityReport } = await import('./r333-operator-capability-mirror.js')
      const r = capabilityReport()
      return { gaps: r.gaps, summary: `${r.planned} planned + ${r.partial} partial of ${r.total} total` }
    },
  },

  // ─── R334 Claude Parity Registry ───────────────────────────────────
  'capability.parity_report': {
    description: 'R334: Score Novan vs Claude across every capability category. Honest evidence-based scoring 0-10 per capability.',
    risk: 'low',
    handler: async () => {
      const { parityReport, CLAUDE_PARITY } = await import('./r334-claude-parity-registry.js')
      return { report: parityReport(), totalCapabilities: CLAUDE_PARITY.length }
    },
  },
  'capability.next_target': {
    description: 'R334: Pick the highest-leverage Claude-parity gap to attack next (gap-size × tractability).',
    risk: 'low',
    handler: async () => {
      const { nextTarget, parityReport } = await import('./r334-claude-parity-registry.js')
      const t = nextTarget()
      const r = parityReport()
      return {
        nextTarget: t,
        leverageRationale: `score ${t.novanScore}/10, cost ${t.closureCost}, category ${t.category}`,
        currentAvg: r.averageScore,
        totalGapPoints: r.totalGapPoints,
      }
    },
  },
  'privacy.check_submit': {
    description: 'R334: Test the privacy runtime gate. Pass {channel, fieldName, value} to see if it would block.',
    risk: 'low',
    handler: async (ws, params) => {
      const { checkBeforeSubmit } = await import('./r334-privacy-runtime-gate.js')
      const p = params as { channel?: string; fieldName?: string; value?: string }
      return checkBeforeSubmit({
        workspaceId: ws,
        channel:     p.channel ?? 'tiktok_shop',
        fieldName:   p.fieldName ?? 'return_address',
        value:       p.value ?? '',
      })
    },
  },
  'brand.dba_propagation_plan': {
    description: 'R334: Generate the plan to propagate DBA across every connected platform.',
    risk: 'low',
    handler: async (ws) => {
      const { planPropagation } = await import('./r334-brand-propagator.js')
      return planPropagation(ws)
    },
  },

  // ─── R335 closures ─────────────────────────────────────────────────
  'art.public_domain_fetch': {
    description: 'R335: Fetch CC0/public-domain art from Met/LoC/Smithsonian. Params: query, limit?, niche?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { fetchAcrossSources, fetchForNiche } = await import('./r335-public-domain-art-fetchers.js')
      const p = params as { query?: string; limit?: number; niche?: string }
      if (p.niche) return { source: 'niche', niche: p.niche, assets: await fetchForNiche(p.niche as 'botanical', p.limit ?? 10) }
      return fetchAcrossSources({ query: p.query ?? 'botanical illustration', limit: p.limit ?? 5 })
    },
  },
  'decide.image_gen_fallback': {
    description: 'R335: When image-gen providers are down, score paths (public domain / topup / fresh key / cap raise / midjourney) against operator constraints.',
    risk: 'low',
    handler: async (ws) => {
      const { decide, imageGenFallbackPaths } = await import('./r335-free-first-decision-compiler.js')
      return decide({
        workspaceId: ws,
        question:    'All image-gen providers are down. Which path?',
        paths:       imageGenFallbackPaths(),
        persist:     true,
      })
    },
  },
  'decide.return_address': {
    description: 'R335: Return-address strategy decision (phase 1 case-by-case / virtual mailbox / PO box / home).',
    risk: 'low',
    handler: async (ws) => {
      const { decide, returnAddressPaths } = await import('./r335-free-first-decision-compiler.js')
      return decide({
        workspaceId: ws,
        question:    'What return address strategy fits current MRR + privacy constraints?',
        paths:       returnAddressPaths(),
        persist:     true,
      })
    },
  },
  'lesson.applicable_for': {
    description: 'R335: Pre-flight hook — return lessons applicable to an upcoming op. Params: op, tags?',
    risk: 'low',
    handler: async (ws, params) => {
      const { applicableLessonsFor } = await import('./r335-lesson-auto-capture.js')
      const p = params as { op?: string; tags?: string[] }
      return applicableLessonsFor(ws, p.op ?? '', p.tags ?? [])
    },
  },

  // ─── R336-R339 closures ─────────────────────────────────────────────
  'clarify.score_ambiguity': {
    description: 'R336: Score ambiguity in a request 0-1 + propose clarify chips.',
    risk: 'low',
    handler: async (_ws, params) => {
      const { scoreAmbiguity, buildClarifyDecision } = await import('./r336-clarify-orchestrator.js')
      const p = params as { request?: string }
      const text = p.request ?? ''
      const score = scoreAmbiguity(text)
      return { score, decision: score.needsClarify ? buildClarifyDecision(text) : null }
    },
  },
  'report.revenue_by_business': {
    description: 'R336: Generate revenue-by-business report. Params: format?, daysBack?',
    risk: 'low',
    handler: async (ws, params) => {
      const { revenueByBusinessReport } = await import('./r336-operator-reports.js')
      const p = params as { format?: 'csv' | 'tsv' | 'markdown'; daysBack?: number }
      return revenueByBusinessReport(ws, p.format ?? 'csv', p.daysBack ?? 30)
    },
  },
  'report.capability_parity': {
    description: 'R336: Generate Claude-parity report as markdown/csv table.',
    risk: 'low',
    handler: async (_ws, params) => {
      const { capabilityParityReport } = await import('./r336-operator-reports.js')
      const p = params as { format?: 'csv' | 'markdown' }
      return capabilityParityReport(p.format ?? 'markdown')
    },
  },
  'memory.recall': {
    description: 'R337: Hybrid recall over workspace_memory. Params: query, limit?, scopes?',
    risk: 'low',
    handler: async (ws, params) => {
      const { recall, recallByTopic } = await import('./r337-semantic-recall.js')
      const p = params as { query?: string; topic?: string; limit?: number; scopes?: string[] }
      if (p.topic) return recallByTopic({ workspaceId: ws, topic: p.topic as 'lessons' })
      return recall({ workspaceId: ws, query: p.query ?? '', limit: p.limit, ...(p.scopes ? { scopes: p.scopes } : {}) })
    },
  },
  'policy.check_action': {
    description: 'R337: Check a proposed action against hard-policy registry. Params: type, channel, fieldOrLabel, value?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { checkAction } = await import('./r337-hard-policy-registry.js')
      const p = params as { type?: string; channel?: string; fieldOrLabel?: string; value?: string }
      return checkAction({
        type:         (p.type ?? 'submit_form_field') as 'submit_form_field' | 'click_button' | 'api_write' | 'browser_action',
        channel:      p.channel ?? 'unknown',
        fieldOrLabel: p.fieldOrLabel ?? '',
        ...(p.value !== undefined ? { value: p.value } : {}),
      })
    },
  },
  'confidence.score_op': {
    description: 'R338: Score Novan confidence to attempt a given op (0-1 + recommendation).',
    risk: 'low',
    handler: async (ws, params) => {
      const { scoreConfidence } = await import('./r338-confidence-scoring.js')
      const p = params as { op?: string }
      return scoreConfidence({ workspaceId: ws, op: p.op ?? 'unknown' })
    },
  },
  'platform.state_probe': {
    description: 'R338: Probe platform state before running onboarding workflow (plot-twist detector). Params: platform.',
    risk: 'low',
    handler: async (ws, params) => {
      const { gateOnboarding, probeAll } = await import('./r338-platform-state-prober.js')
      const p = params as { platform?: string; platforms?: string[] }
      if (p.platforms) return probeAll(ws, p.platforms)
      return gateOnboarding(ws, p.platform ?? 'tiktok_shop')
    },
  },
  'closer.tick': {
    description: 'R339: Continuous-closer tick — pick next parity gap, draft closure proposal, persist.',
    risk: 'low',
    handler: async (ws) => {
      const { closerTick } = await import('./r339-capability-closer-cron.js')
      return closerTick(ws)
    },
  },
  'platform.poll_all': {
    description: 'R339: Poll every connected platform for state + alerts.',
    risk: 'low',
    handler: async (ws) => {
      const { pollAllPlatforms } = await import('./r339-platform-monitor.js')
      return pollAllPlatforms(ws)
    },
  },

  // ─── R340 + R341 closures ──────────────────────────────────────────
  'verify.claim': {
    description: 'R340: Adversarial verification of a claim across 6 lenses (correctness/security/cost/privacy/regression/evidence).',
    risk: 'low',
    handler: async (_ws, params) => {
      const { verify } = await import('./r340-adversarial-verifier.js')
      const p = params as { statement?: string; evidence?: string; impactTier?: 'low' | 'medium' | 'high' }
      return verify({
        statement:  p.statement ?? '',
        evidence:   p.evidence ?? '',
        impactTier: p.impactTier ?? 'medium',
      })
    },
  },
  'review.source': {
    description: 'R340: Static review of source content. Params: fileHint, content.',
    risk: 'low',
    handler: async (_ws, params) => {
      const { reviewSource } = await import('./r340-code-review.js')
      const p = params as { fileHint?: string; content?: string }
      return reviewSource(p.fileHint ?? 'unknown', p.content ?? '')
    },
  },
  'skill.list': {
    description: 'R341: List domain-specialized Novan skills. Params: category?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { listSkills } = await import('./r341-domain-skill-registry.js')
      const p = params as { category?: 'pod' | 'social' | 'seo' | 'analytics' | 'compliance' }
      return listSkills(p.category)
    },
  },
  'skill.rank_for_request': {
    description: 'R341: Rank skills against a request given current op availability. Params: request, availableOps[].',
    risk: 'low',
    handler: async (_ws, params) => {
      const { rankForRequest } = await import('./r341-domain-skill-registry.js')
      const p = params as { request?: string; availableOps?: string[] }
      return rankForRequest(p.request ?? '', p.availableOps ?? [])
    },
  },
  'mcp.plan_invocation': {
    description: 'R341: Pick best MCP/op chain for a capability. Params: capability, preferCost?, excludeProviders?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { planInvocation } = await import('./r341-mcp-fallback-chains.js')
      const p = params as { capability?: 'video_analyze' | 'image_generate' | 'web_search' | 'browser_drive'; preferCost?: 'free' | 'cheap' | 'any'; excludeProviders?: string[] }
      return planInvocation({
        capability: p.capability ?? 'image_generate',
        ...(p.preferCost ? { preferCost: p.preferCost } : {}),
        ...(p.excludeProviders ? { excludeProviders: p.excludeProviders } : {}),
      })
    },
  },

  // ─── R342 prestaged retrieval ───────────────────────────────────────
  'prestaged.list': {
    description: 'R342: List all pre-staged operator deliverables (portfolio, application, listings, policies).',
    risk: 'low',
    handler: async (ws) => {
      const { recall } = await import('./r337-semantic-recall.js')
      return recall({ workspaceId: ws, query: 'prestaged', scopes: ['prestaged'], minImportance: 80, limit: 20 })
    },
  },

  // ── R344 POD account kit ──────────────────────────────────────────
  'pod.account_kit': {
    description: 'R344: List all POD platforms with cost/margin/ban-risk + sequenced rollout plan.',
    risk: 'low',
    handler: async (_ws, params) => {
      const { POD_PLATFORMS, planSequencedRollout } = await import('./r344-pod-account-kit.js')
      const p = params as { currentMrrUsd?: number }
      return { catalog: POD_PLATFORMS, plan: planSequencedRollout(p.currentMrrUsd ?? 0) }
    },
  },
  'pod.revenue_projection': {
    description: 'R345: Items-to-list math per platform for a target MRR. Params: targetMrrPerStoreUsd?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { projectItemsForTarget } = await import('./r345-pod-revenue-projection.js')
      const p = params as { targetMrrPerStoreUsd?: number }
      return projectItemsForTarget(p.targetMrrPerStoreUsd ?? 5000)
    },
  },
  'pod.portfolio_plan': {
    description: 'R345: Optimal multi-store allocation to hit a TOTAL MRR target across all platforms. Params: totalTargetMrrUsd?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { planPortfolio } = await import('./r345-pod-revenue-projection.js')
      const p = params as { totalTargetMrrUsd?: number }
      return planPortfolio(p.totalTargetMrrUsd ?? 35000)
    },
  },

  // ── R346 Gumroad autonomous publisher ─────────────────────────────
  'gumroad.whoami': {
    description: 'R346: Verify GUMROAD_ACCESS_TOKEN is configured and active.',
    risk: 'low',
    handler: async () => {
      const { whoami } = await import('./r346-gumroad-api.js')
      return whoami()
    },
  },
  'gumroad.list_products': {
    description: 'R346: List all existing Gumroad products.',
    risk: 'low',
    handler: async () => {
      const { listProducts } = await import('./r346-gumroad-api.js')
      return listProducts()
    },
  },
  'gumroad.publish_first_three': {
    description: 'R346: Autonomously publish the 3 prestaged first-listings (woodpecker, iris, vintage map) via Gumroad API. Params: dryRun?, skipIfNamedExists?',
    risk: 'medium',
    handler: async (ws, params) => {
      const { publishFirstThree } = await import('./r346-gumroad-product-publisher.js')
      const p = params as { dryRun?: boolean; skipIfNamedExists?: boolean }
      return publishFirstThree({
        workspaceId:        ws,
        dryRun:             p.dryRun ?? false,
        skipIfNamedExists:  p.skipIfNamedExists ?? true,
      })
    },
  },

  // ── R347 publish mechanism routing ───────────────────────────────
  'publish.mechanism_report': {
    description: 'R347: Report which platforms publish via API (Novan autonomous) vs manual (operator). Codifies the no-browser-automation rule.',
    risk: 'low',
    handler: async () => {
      const { publishMechanismReport, PUBLISH_PROFILES } = await import('./r347-publish-mechanism-registry.js')
      return { report: publishMechanismReport(), profiles: PUBLISH_PROFILES }
    },
  },
  'publish.route_for_platform': {
    description: 'R347: Plan publish route for a single platform. Returns mechanism + ready/blocked + next action. Params: platformId',
    risk: 'low',
    handler: async (_ws, params) => {
      const { planPublishRoute } = await import('./r347-publish-mechanism-registry.js')
      const p = params as { platformId?: string }
      return planPublishRoute(p.platformId ?? 'gumroad')
    },
  },
  'publish.list_ready': {
    description: 'R347: List all platforms where Novan can publish autonomously right now.',
    risk: 'low',
    handler: async () => {
      const { listReady, listBlockedNeedingOperator } = await import('./r347-publish-mechanism-registry.js')
      return { ready: listReady(), blockedNeedingOperator: listBlockedNeedingOperator() }
    },
  },

  // ── R349 Design factory + upload queue + daily briefing ──────────
  'design.generate_batch': {
    description: 'R349: Generate N designs in a niche. Params: niche, subjects[], styleOverride?, promptTemplateIndex?',
    risk: 'medium',
    handler: async (ws, params) => {
      const { generateBatch } = await import('./r349-design-factory.js')
      const p = params as { niche?: string; subjects?: string[]; styleOverride?: string; promptTemplateIndex?: number }
      return generateBatch({
        workspaceId:           ws,
        niche:                 (p.niche ?? 'botanical') as 'botanical',
        subjects:              p.subjects ?? ['iris flower'],
        ...(p.styleOverride ? { styleOverride: p.styleOverride as 'watercolor' } : {}),
        ...(p.promptTemplateIndex !== undefined ? { promptTemplateIndex: p.promptTemplateIndex } : {}),
      })
    },
  },
  'design.suggest_subjects': {
    description: 'R349: List curated subject ideas per niche, drawn from POD bestseller patterns.',
    risk: 'low',
    handler: async (_ws, params) => {
      const { NICHE_SUBJECTS } = await import('./r349-design-factory.js')
      const p = params as { niche?: string }
      if (p.niche) return { niche: p.niche, subjects: NICHE_SUBJECTS[p.niche as 'botanical'] ?? [] }
      return NICHE_SUBJECTS
    },
  },
  'design.list': {
    description: 'R349: List recent designs from the catalog. Params: niche?, limit?',
    risk: 'low',
    handler: async (ws, params) => {
      const { listDesigns } = await import('./r349-design-factory.js')
      const p = params as { niche?: string; limit?: number }
      return listDesigns({
        workspaceId: ws,
        ...(p.niche ? { niche: p.niche as 'botanical' } : {}),
        ...(p.limit !== undefined ? { limit: p.limit } : {}),
      })
    },
  },
  'design.get': {
    description: 'R357: Fetch ONE design by id with the FULL image_url (not truncated). Used by the local-agent design cache. Params: designId',
    risk: 'low',
    handler: async (ws, params) => {
      const { sql } = await import('drizzle-orm')
      const { db } = await import('../db/client.js')
      const p = params as { designId?: string }
      if (!p.designId) return { ok: false, reason: 'designId required' }
      const rows = await db.execute(sql`
        SELECT id, niche, style, prompt, image_url, source_provider, created_at
        FROM design_catalog
        WHERE workspace_id = ${ws} AND id = ${p.designId}
        LIMIT 1
      `)
      const r = (rows as unknown as Array<Record<string, unknown>>)[0]
      if (!r) return { ok: false, reason: 'not found' }
      return {
        id:              String(r['id']),
        niche:           String(r['niche']),
        style:           String(r['style']),
        prompt:          String(r['prompt']),
        image_url:       String(r['image_url']),
        source_provider: r['source_provider'] ? String(r['source_provider']) : null,
        created_at:      Number(r['created_at']),
      }
    },
  },
  'listing.generate': {
    description: 'R349: Generate platform-tuned listing content (title/desc/tags/price/file-hint). Params: platform, subject, niche, style, designId?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { generateListing } = await import('./r349-listing-content-rotator.js')
      const p = params as { platform?: string; subject?: string; niche?: string; style?: string; designId?: string }
      return generateListing({
        platform: (p.platform ?? 'gumroad') as 'gumroad',
        subject:  p.subject  ?? 'iris',
        niche:    (p.niche    ?? 'botanical') as 'botanical',
        style:    (p.style    ?? 'watercolor') as 'watercolor',
        ...(p.designId ? { designId: p.designId } : {}),
      })
    },
  },
  'listing.generate_multi': {
    description: 'R349: Generate listing content for ONE design across MULTIPLE platforms. Params: platforms[], subject, niche, style, designId?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { generateMultiPlatform } = await import('./r349-listing-content-rotator.js')
      const p = params as { platforms?: string[]; subject?: string; niche?: string; style?: string; designId?: string }
      return generateMultiPlatform({
        platforms: (p.platforms ?? ['gumroad', 'fine_art_america', 'inprnt']) as Array<'gumroad'>,
        subject:   p.subject  ?? 'iris',
        niche:     (p.niche    ?? 'botanical') as 'botanical',
        style:     (p.style    ?? 'watercolor') as 'watercolor',
        ...(p.designId ? { designId: p.designId } : {}),
      })
    },
  },
  'upload_queue.add': {
    description: 'R349: Add a design to the upload queue for a platform. Params: designId, platform, title, description, tags[], priceUsd?, category?, priority?',
    risk: 'low',
    handler: async (ws, params) => {
      const { enqueue } = await import('./r349-upload-queue.js')
      const p = params as { designId?: string; platform?: string; title?: string; description?: string; tags?: string[]; priceUsd?: number; category?: string; priority?: number }
      return enqueue({
        workspaceId: ws,
        designId:    p.designId ?? '',
        platform:    (p.platform ?? 'gumroad') as 'gumroad',
        title:       p.title       ?? '',
        description: p.description ?? '',
        tags:        p.tags        ?? [],
        ...(p.priceUsd !== undefined ? { priceUsd: p.priceUsd } : {}),
        ...(p.category               ? { category: p.category } : {}),
        ...(p.priority !== undefined ? { priority: p.priority } : {}),
      })
    },
  },
  'agent.heartbeat': {
    description: 'R358: Local-agent posts a heartbeat per tick. Params: agentId, platforms[], uploads, failures, versionTag?',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordHeartbeat } = await import('./r358-agent-telemetry.js')
      const p = params as { agentId?: string; platforms?: string[]; uploads?: number; failures?: number; versionTag?: string }
      return recordHeartbeat({
        workspaceId: ws,
        agentId:     p.agentId   ?? 'unknown',
        platforms:   p.platforms ?? [],
        uploads:     p.uploads   ?? 0,
        failures:    p.failures  ?? 0,
        ...(p.versionTag ? { versionTag: p.versionTag } : {}),
      })
    },
  },
  'agent.report_event': {
    description: 'R358: Local-agent posts an upload outcome. Params: agentId, platform, queueItemId, status (success|skipped|failed), externalUrl?, reason?, durationMs?',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordUploadEvent } = await import('./r358-agent-telemetry.js')
      const p = params as { agentId?: string; platform?: string; queueItemId?: string; status?: string; externalUrl?: string; reason?: string; durationMs?: number }
      return recordUploadEvent({
        workspaceId: ws,
        agentId:     p.agentId     ?? 'unknown',
        platform:    p.platform    ?? 'unknown',
        queueItemId: p.queueItemId ?? 'unknown',
        status:      (p.status     ?? 'failed') as 'success' | 'skipped' | 'failed',
        ...(p.externalUrl ? { externalUrl: p.externalUrl } : {}),
        ...(p.reason      ? { reason:      p.reason } : {}),
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      })
    },
  },
  'agent.report_failure': {
    description: 'R358: Local-agent reports a driver crash with screenshot + error context. Params: agentId, platform, queueItemId?, errorMessage, errorStack?, screenshotBase64?, pageUrl?',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordFailureReport } = await import('./r358-agent-telemetry.js')
      const p = params as { agentId?: string; platform?: string; queueItemId?: string; errorMessage?: string; errorStack?: string; screenshotBase64?: string; pageUrl?: string }
      return recordFailureReport({
        workspaceId:  ws,
        agentId:      p.agentId  ?? 'unknown',
        platform:     p.platform ?? 'unknown',
        ...(p.queueItemId ? { queueItemId: p.queueItemId } : {}),
        errorMessage: p.errorMessage ?? '(no message)',
        ...(p.errorStack       ? { errorStack:       p.errorStack       } : {}),
        ...(p.screenshotBase64 ? { screenshotBase64: p.screenshotBase64 } : {}),
        ...(p.pageUrl          ? { pageUrl:          p.pageUrl          } : {}),
      })
    },
  },
  'pinterest.enqueue': {
    description: 'R368: Add a pin to the Pinterest queue. Params: title, description, tags[], linkUrl, boardName?, designFile?, priority?',
    risk: 'low',
    handler: async (ws, params) => {
      const { enqueuePin } = await import('./r368-pinterest-pin-queue.js')
      const p = params as Record<string, unknown>
      return enqueuePin({
        workspaceId: ws,
        title:       String(p['title'] ?? ''),
        description: String(p['description'] ?? ''),
        tags:        Array.isArray(p['tags']) ? (p['tags'] as string[]) : [],
        linkUrl:     String(p['linkUrl'] ?? ''),
        boardName:   String(p['boardName'] ?? 'Vintage Botanical Prints | CYZOR CREATIONS'),
        ...(p['designFile'] ? { designFile: String(p['designFile']) } : {}),
        ...(p['priority']   !== undefined ? { priority:   Number(p['priority']) } : {}),
      })
    },
  },
  'pinterest.next': {
    description: 'R368: Pull the next pin to post (respects 5/day cap).',
    risk: 'low',
    handler: async (ws) => {
      const { nextPin } = await import('./r368-pinterest-pin-queue.js')
      return nextPin(ws)
    },
  },
  'pinterest.mark_posted': {
    description: 'R368: Mark a pin as live. Params: pinQueueId, externalUrl',
    risk: 'low',
    handler: async (ws, params) => {
      const { markPinPosted } = await import('./r368-pinterest-pin-queue.js')
      const p = params as { pinQueueId?: string; externalUrl?: string }
      await markPinPosted(ws, p.pinQueueId ?? '', p.externalUrl ?? '')
      return { ok: true }
    },
  },
  'pinterest.mark_failed': {
    description: 'R368: Mark a pin as failed. Params: pinQueueId, reason',
    risk: 'low',
    handler: async (ws, params) => {
      const { markPinFailed } = await import('./r368-pinterest-pin-queue.js')
      const p = params as { pinQueueId?: string; reason?: string }
      await markPinFailed(ws, p.pinQueueId ?? '', p.reason ?? 'unknown')
      return { ok: true }
    },
  },
  'pinterest.stats': {
    description: 'R368: Pin queue stats (queued / posted / today / remaining).',
    risk: 'low',
    handler: async (ws) => {
      const { pinStats } = await import('./r368-pinterest-pin-queue.js')
      return pinStats(ws)
    },
  },
  'pinterest.bulk_load': {
    description: 'R368: Bulk-load pins (idempotent on workspace+title). Params: pins[]',
    risk: 'low',
    handler: async (ws, params) => {
      const { bulkLoadPins } = await import('./r368-pinterest-pin-queue.js')
      const p = params as { pins?: Array<{ title: string; description: string; tags: string[]; linkUrl: string; boardName?: string; designFile?: string; priority?: number }> }
      return bulkLoadPins({ workspaceId: ws, pins: p.pins ?? [] })
    },
  },
  'next_actions.push': {
    description: 'R386: For each workspace, if top action changed and score ≥ 60, send web-push to subscribed devices (4h dedup).',
    risk: 'low',
    handler: async () => {
      const { pushNextActions } = await import('./r386-next-action-pusher.js')
      return pushNextActions()
    },
  },
  'variants.generate_for_design': {
    description: 'R390: Force-generate winner variants for any designId (operator override; sale-triggered path also calls this). Params: design_id, count?',
    risk: 'low',
    handler: async (ws, params) => {
      const p = params as { design_id?: string; count?: number }
      if (!p.design_id) return { ok: false, reason: 'design_id required' }
      const { generateWinnerVariants } = await import('./r374-winner-variant-generator.js')
      return generateWinnerVariants({ workspaceId: ws, parentDesignId: p.design_id, count: p.count ?? 3 })
    },
  },
  'queue.stuck': {
    description: 'R391: Items queued >48h with no attempt. Operator may want to reprioritize, switch platform, or kill.',
    risk: 'low',
    handler: async (ws) => {
      const { detectStuckQueueItems } = await import('./r391-stuck-queue-detector.js')
      return detectStuckQueueItems(ws)
    },
  },
  'failures.cluster': {
    description: 'R388: Top recurring agent failures in last 7d, with normalized signature + suggested fix per cluster.',
    risk: 'low',
    handler: async (ws) => {
      const { detectFailureClusters } = await import('./r388-failure-clusters.js')
      return detectFailureClusters(ws)
    },
  },
  'next_actions.list': {
    description: 'R385: Highest-impact actions the operator should take, sorted by score. Reads all signals (queue, pacing, pins, capability, sales, agent heartbeat).',
    risk: 'low',
    handler: async (ws) => {
      const { nextActions } = await import('./r385-next-action-recommender.js')
      return nextActions(ws)
    },
  },
  'daily_cron.run': {
    description: 'R382: Headless half of the daily routine — sales sync + trend pipeline + self-test. Idempotent per UTC day. Params: force?',
    risk: 'low',
    handler: async (ws, params) => {
      const { runDailyCron } = await import('./r382-droplet-daily-cron.js')
      const p = params as { force?: boolean }
      return runDailyCron(ws, { force: p.force === true })
    },
  },
  'pacing.auto_loosen': {
    description: 'R387: For each (workspace, platform), if 50+ uploads + 0 failures in 14d, shrink interval 30% (cap 3 tiers, floor 3min / 10min tiktok_shop).',
    risk: 'low',
    handler: async () => {
      const { autoLoosenPacing } = await import('./r387-pacing-auto-loosen.js')
      return autoLoosenPacing()
    },
  },
  'pacing.check_or_acquire': {
    description: 'R378: Check if a platform upload is allowed right now (per anti-flag inter-upload min). If yes, acquires the slot. Params: platform, acquire?',
    risk: 'low',
    handler: async (ws, params) => {
      const { checkOrAcquire } = await import('./r378-upload-pacing.js')
      const p = params as { platform?: string; acquire?: boolean }
      return checkOrAcquire({ workspaceId: ws, platform: p.platform ?? 'unknown', acquire: p.acquire !== false })
    },
  },
  'pacing.snapshot': {
    description: 'R378: Per-platform last-upload-ago + next-ok-in (minutes).',
    risk: 'low',
    handler: async (ws) => {
      const { pacingSnapshot } = await import('./r378-upload-pacing.js')
      return pacingSnapshot(ws)
    },
  },
  'listing.record_upload': {
    description: 'R377: Record which (titleIdx, descIdx) the rotator picked. Called from upload_queue.add. Params: platform, niche, titleIdx, descIdx?',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordTemplateUpload } = await import('./r377-listing-outcome-tracker.js')
      const p = params as { platform?: string; niche?: string; titleIdx?: number; descIdx?: number }
      await recordTemplateUpload({
        workspaceId: ws,
        platform:    p.platform ?? 'gumroad',
        niche:       p.niche    ?? 'botanical',
        titleIdx:    Number(p.titleIdx) || 0,
        ...(p.descIdx !== undefined ? { descIdx: Number(p.descIdx) } : {}),
      })
      return { ok: true }
    },
  },
  'listing.record_sale': {
    description: 'R377: Attribute a sale to its (platform, niche, titleIdx, descIdx). Called from sales sync. Params: platform, niche, titleIdx, descIdx?, revenueUsd',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordTemplateSale } = await import('./r377-listing-outcome-tracker.js')
      const p = params as { platform?: string; niche?: string; titleIdx?: number; descIdx?: number; revenueUsd?: number }
      await recordTemplateSale({
        workspaceId: ws,
        platform:    p.platform ?? 'gumroad',
        niche:       p.niche    ?? 'botanical',
        titleIdx:    Number(p.titleIdx) || 0,
        revenueUsd:  Number(p.revenueUsd) || 0,
        ...(p.descIdx !== undefined ? { descIdx: Number(p.descIdx) } : {}),
      })
      return { ok: true }
    },
  },
  'listing.best_template': {
    description: 'R377: Highest-converting (titleIdx, descIdx) for a (platform, niche). Used by listing-rotator to pick winners. Params: platform, niche',
    risk: 'low',
    handler: async (ws, params) => {
      const { bestTemplateFor } = await import('./r377-listing-outcome-tracker.js')
      const p = params as { platform?: string; niche?: string }
      return bestTemplateFor(ws, p.platform ?? 'gumroad', p.niche ?? 'botanical')
    },
  },
  'listing.rankings': {
    description: 'R377: Template performance leaderboard. Params: platform?, niche?',
    risk: 'low',
    handler: async (ws, params) => {
      const { getRankings } = await import('./r377-listing-outcome-tracker.js')
      const p = params as { platform?: string; niche?: string }
      return getRankings(ws, p.platform, p.niche)
    },
  },
  'capability.self_test': {
    description: 'R376: Exercise core ops + report what works, what is degraded, what is missing prerequisites.',
    risk: 'low',
    handler: async (ws) => {
      const { runCapabilitySelfTest } = await import('./r376-capability-self-test.js')
      return runCapabilitySelfTest(ws)
    },
  },
  'sales.record': {
    description: 'R375: Record a sale from any platform (manual entry / webhook). Idempotent on externalSaleId. Auto-fires winner-variant generation. Params: platform, externalSaleId, grossUsd, netUsd?, productUrl?, productName?, occurredAt?',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordSale } = await import('./r375-cross-platform-sales.js')
      const p = params as Record<string, unknown>
      return recordSale({
        workspaceId:    ws,
        platform:       String(p['platform'] ?? 'gumroad') as 'gumroad',
        externalSaleId: String(p['externalSaleId'] ?? ''),
        grossUsd:       Number(p['grossUsd']) || 0,
        ...(p['netUsd']      !== undefined ? { netUsd:      Number(p['netUsd']) } : {}),
        ...(p['productUrl']                 ? { productUrl:  String(p['productUrl']) } : {}),
        ...(p['productName']                ? { productName: String(p['productName']) } : {}),
        ...(p['occurredAt']  !== undefined ? { occurredAt:  Number(p['occurredAt']) } : {}),
      })
    },
  },
  'sales.cross_platform_mrr': {
    description: 'R375: Cross-platform 30d MRR breakdown by platform + current tier.',
    risk: 'low',
    handler: async (ws) => {
      const { getCrossPlatformMrr } = await import('./r375-cross-platform-sales.js')
      return getCrossPlatformMrr(ws)
    },
  },
  'winner.generate_variants': {
    description: 'R374: Given a winning parent_design_id, generate 3 variants (color-shift / crop / reframe) and queue them. Params: parentDesignId, count?',
    risk: 'low',
    handler: async (ws, params) => {
      const { generateWinnerVariants } = await import('./r374-winner-variant-generator.js')
      const p = params as { parentDesignId?: string; count?: number }
      return generateWinnerVariants({ workspaceId: ws, parentDesignId: p.parentDesignId ?? '', ...(p.count !== undefined ? { count: p.count } : {}) })
    },
  },
  'sales.sync_gumroad': {
    description: 'R367: Pull recent Gumroad sales, persist to business_revenue, auto-progress goal-ladder tier. Params: businessId?',
    risk: 'low',
    handler: async (ws, params) => {
      const { syncGumroadSales } = await import('./r367-gumroad-sales-sync.js')
      const p = params as { businessId?: string }
      return syncGumroadSales(ws, p.businessId ?? 'cyzor_creations')
    },
  },
  'sales.last_tier_unlock': {
    description: 'R367: Most-recent tier-unlock event for this workspace.',
    risk: 'low',
    handler: async (ws) => {
      const { lastSyncSummary } = await import('./r367-gumroad-sales-sync.js')
      return lastSyncSummary(ws)
    },
  },
  'selector.improve': {
    description: 'R366: When a driver crashes on a missing selector, post page HTML + screenshot + error → LLM proposes new selectors. Params: platform, step, errorMessage, pageUrl, pageHtmlExcerpt, screenshotBase64?, previousSelectors?',
    risk: 'low',
    handler: async (ws, params) => {
      const { improveSelectors } = await import('./r366-selector-improver.js')
      const p = params as Record<string, unknown>
      return improveSelectors({
        workspaceId:       ws,
        platform:          String(p['platform']      ?? 'unknown'),
        step:              String(p['step']           ?? 'unknown'),
        errorMessage:      String(p['errorMessage']   ?? ''),
        pageUrl:           String(p['pageUrl']        ?? ''),
        pageHtmlExcerpt:   String(p['pageHtmlExcerpt'] ?? '').slice(0, 8000),
        ...(typeof p['screenshotBase64'] === 'string' ? { screenshotBase64: p['screenshotBase64'] as string } : {}),
        ...(Array.isArray(p['previousSelectors']) ? { previousSelectors: (p['previousSelectors'] as string[]).filter(s => typeof s === 'string') } : {}),
      })
    },
  },
  'selector.outcome': {
    description: 'R366: Report whether a selector worked. Improves future suggestions. Params: platform, step, selector, success (bool)',
    risk: 'low',
    handler: async (ws, params) => {
      const { recordSelectorOutcome } = await import('./r366-selector-improver.js')
      const p = params as Record<string, unknown>
      await recordSelectorOutcome(ws, String(p['platform'] ?? 'unknown'), String(p['step'] ?? 'unknown'), String(p['selector'] ?? ''), p['success'] === true)
      return { ok: true }
    },
  },
  'selector.stored': {
    description: 'R366: Get top-N stored selectors for (platform, step). Agent calls this BEFORE asking LLM. Params: platform, step, limit?',
    risk: 'low',
    handler: async (ws, params) => {
      const { getStoredSelectors } = await import('./r366-selector-improver.js')
      const p = params as Record<string, unknown>
      return getStoredSelectors(ws, String(p['platform'] ?? 'unknown'), String(p['step'] ?? 'unknown'), Number(p['limit']) || 3)
    },
  },
  'account.birthdays': {
    description: 'R358: Return per-platform account-creation timestamps from workspace_memory. Used by birthday-ramp to clamp day 1-7 velocity.',
    risk: 'low',
    handler: async (ws) => {
      const { getAllAccountBirthdays } = await import('./r358-agent-telemetry.js')
      return getAllAccountBirthdays(ws)
    },
  },
  'upload_queue.next': {
    description: 'R349: Pull the next N paste-ready items for a platform (priority DESC, queued_at ASC). Params: platform, limit?',
    risk: 'low',
    handler: async (ws, params) => {
      const { nextForPlatform } = await import('./r349-upload-queue.js')
      const p = params as { platform?: string; limit?: number }
      return nextForPlatform({ workspaceId: ws, platform: (p.platform ?? 'gumroad') as 'gumroad', limit: p.limit ?? 5 })
    },
  },
  'upload_queue.stats': {
    description: 'R349: Per-platform queue counts (queued / live / today) + safe daily velocity caps. Params: none.',
    risk: 'low',
    handler: async (ws) => {
      const { statsByPlatform } = await import('./r349-upload-queue.js')
      return statsByPlatform(ws)
    },
  },
  'upload_queue.mark_uploaded': {
    description: 'R349: Mark a queue item as uploaded (operator confirms after manual upload). Params: queueItemId, externalUrl?',
    risk: 'low',
    handler: async (ws, params) => {
      const { markUploaded } = await import('./r349-upload-queue.js')
      const p = params as { queueItemId?: string; externalUrl?: string }
      return markUploaded({
        workspaceId: ws,
        queueItemId: p.queueItemId ?? '',
        ...(p.externalUrl ? { externalUrl: p.externalUrl } : {}),
      })
    },
  },
  'briefing.daily_uploads': {
    description: 'R349: The morning briefing - what to upload to each platform today within safe velocity. Params: platforms? (default: all)',
    risk: 'low',
    handler: async (ws, params) => {
      const { dailyBriefing } = await import('./r349-daily-briefing.js')
      const p = params as { platforms?: string[] }
      return dailyBriefing({
        workspaceId: ws,
        ...(p.platforms ? { platforms: p.platforms as Array<'gumroad'> } : {}),
      })
    },
  },
  'briefing.velocity_status': {
    description: 'R349: Quick velocity-cap status per platform without item content.',
    risk: 'low',
    handler: async (ws) => {
      const { velocityStatus } = await import('./r349-daily-briefing.js')
      return velocityStatus(ws)
    },
  },

  // ── R350 Universal goal ladder ─────────────────────────────────────
  'goal.ladder': {
    description: 'R350: Show the universal goal-tier ladder (pre_first_sale -> $1m+) with tactics unlocked at each tier.',
    risk: 'low',
    handler: async () => {
      const { LADDER } = await import('./r350-goal-ladder.js')
      return LADDER
    },
  },
  'goal.classify_tier': {
    description: 'R350: Given an MRR amount, return the matching tier + tactics. Params: mrrUsd',
    risk: 'low',
    handler: async (_ws, params) => {
      const { nextMilestone } = await import('./r350-goal-ladder.js')
      const p = params as { mrrUsd?: number }
      return nextMilestone(p.mrrUsd ?? 0)
    },
  },
  'goal.business_status': {
    description: 'R350: Per-business goal status: which tier, gap to next, tactics unlocked/blocked. Params: businessId?',
    risk: 'low',
    handler: async (ws, params) => {
      const { businessGoalStatus } = await import('./r350-goal-ladder.js')
      const p = params as { businessId?: string }
      return businessGoalStatus(ws, p.businessId)
    },
  },

  // ── R351 Trend Intelligence + Pipeline ─────────────────────────────
  'trends.list_all': {
    description: 'R351: List all currently-trending subjects across proven/breakout/niche-breakout tiers with conversion + saturation scores.',
    risk: 'low',
    handler: async () => {
      const { PROVEN_SUBJECTS, BREAKOUT_SUBJECTS, NICHE_BREAKOUT_SUBJECTS } = await import('./r351-trend-catalog.js')
      return {
        proven:         PROVEN_SUBJECTS,
        breakout:       BREAKOUT_SUBJECTS,
        nicheBreakout:  NICHE_BREAKOUT_SUBJECTS,
        totalSubjects:  PROVEN_SUBJECTS.length + BREAKOUT_SUBJECTS.length + NICHE_BREAKOUT_SUBJECTS.length,
      }
    },
  },
  'trends.pick_batch': {
    description: 'R351: Pick today\'s trending batch (top-N by conversion per tier). Params: provenCount?, breakoutCount?, nicheBreakoutCount?',
    risk: 'low',
    handler: async (_ws, params) => {
      const { pickTrendingBatch } = await import('./r351-trend-catalog.js')
      const p = params as { provenCount?: number; breakoutCount?: number; nicheBreakoutCount?: number }
      return pickTrendingBatch(p)
    },
  },
  'trends.run_pipeline': {
    description: 'R351: End-to-end - pick trending subjects, generate designs via HF, queue listings across all platforms. Params: provenCount?, breakoutCount?, nicheBreakoutCount?, primaryOnly?, dryRun?',
    risk: 'medium',
    handler: async (ws, params) => {
      const { runTrendingPipeline } = await import('./r351-trend-pipeline.js')
      const p = params as { provenCount?: number; breakoutCount?: number; nicheBreakoutCount?: number; primaryOnly?: boolean; dryRun?: boolean }
      return runTrendingPipeline({
        workspaceId:        ws,
        ...(p.provenCount !== undefined ? { provenCount: p.provenCount } : {}),
        ...(p.breakoutCount !== undefined ? { breakoutCount: p.breakoutCount } : {}),
        ...(p.nicheBreakoutCount !== undefined ? { nicheBreakoutCount: p.nicheBreakoutCount } : {}),
        ...(p.primaryOnly !== undefined ? { primaryOnly: p.primaryOnly } : {}),
        ...(p.dryRun !== undefined ? { dryRun: p.dryRun } : {}),
      })
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
        (p['provider'] as 'runway' | 'veo' | 'sora' | 'kling' | 'luma' | 'huggingface' | 'free-realistic') ?? 'kling',
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
        (p['primary'] as 'runway' | 'veo' | 'sora' | 'kling' | 'luma' | 'huggingface' | 'free-realistic') ?? 'kling',
        ((p['fallbacks'] as string[]) ?? []) as Array<'runway' | 'veo' | 'sora' | 'kling' | 'luma' | 'huggingface' | 'free-realistic'>,
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
  // ─── R146.106 — Free-only realistic video pipeline ─────────────────
  'aiVideo.renderRealisticFree': {
    description: 'End-to-end FREE realistic video render: Pollinations Flux still → SVD img2vid → optional Real-ESRGAN upscale. $0 cost, ~30-90s latency, photoreal quality. Params: prompt, aspectRatio?, durationSec?, motionLevel? (subtle|moderate|high), upscale?, seed?',
    risk: 'medium',  // not paid, but autonomous compute
    handler: async (ws, p) => {
      const { renderRealisticFree } = await import('./ai-video-free-realistic.js')
      return renderRealisticFree({
        prompt:      String(p['prompt'] ?? ''),
        workspaceId: ws,
        ...(p['aspectRatio'] ? { aspectRatio: p['aspectRatio'] as '16:9' | '9:16' | '1:1' } : {}),
        ...(typeof p['durationSec'] === 'number' ? { durationSec: p['durationSec'] as number } : {}),
        ...(p['motionLevel'] ? { motionLevel: p['motionLevel'] as 'subtle' | 'moderate' | 'high' } : {}),
        ...(typeof p['seed'] === 'number' ? { seed: p['seed'] as number } : {}),
        upscale:     p['upscale'] === true,
        interpolate: p['interpolate'] === true,
      })
    },
  },
  'aiVideo.setFreeOnly': {
    description: 'Toggle global VIDEO_FREE_ONLY mode. When true, every video render call is forced through the free realistic pipeline. Params: enabled (boolean).',
    risk: 'medium',
    handler: async (_ws, p) => {
      const enabled = p['enabled'] === true
      process.env['VIDEO_FREE_ONLY'] = enabled ? '1' : '0'
      return { ok: true, freeOnly: enabled }
    },
  },
  // ─── R146.105 — Novan Frontier Intelligence (24/7 research + advance) ───
  'frontier.seedSources': {
    description: 'Seed default frontier-intel sources (arxiv/HF/GitHub/labs/HN) for this workspace.',
    risk: 'low',
    handler: async (ws) => (await import('./frontier-intel.js')).seedDefaultSources(ws),
  },
  'frontier.tick': {
    description: 'Run one frontier-intel cycle: scan due sources, distill new findings, queue prototypes.',
    risk: 'low',
    handler: async (ws) => (await import('./frontier-intel.js')).frontierTick(ws),
  },
  'frontier.ledger': {
    description: 'List frontier findings ranked by composite score. Params: limit?, minScore?, status?',
    risk: 'low',
    handler: async (ws, p) => (await import('./frontier-intel.js')).listFrontierLedger(ws, {
      limit:    typeof p['limit']    === 'number' ? p['limit']    as number : 50,
      minScore: typeof p['minScore'] === 'number' ? p['minScore'] as number : 0,
      ...(p['status'] ? { status: String(p['status']) } : {}),
    }),
  },
  'frontier.recordAdvance': {
    description: 'Record that Novan integrated/prototyped/specced a finding ahead of competitors. Params: findingId, ahead (integrated|prototyped|specced), monthsAhead?, notes?',
    risk: 'low',
    handler: async (ws, p) => (await import('./frontier-intel.js')).recordAdvance({
      workspaceId: ws,
      findingId:   String(p['findingId'] ?? ''),
      ahead:       (p['ahead'] as 'integrated' | 'prototyped' | 'specced') ?? 'specced',
      ...(typeof p['monthsAhead'] === 'number' ? { monthsAhead: p['monthsAhead'] as number } : {}),
      ...(p['notes'] ? { notes: String(p['notes']) } : {}),
    }),
  },
  'frontier.stats': {
    description: 'Summary stats for the frontier ledger: total findings, queued, prototyping, integrated, avg months ahead.',
    risk: 'low',
    handler: async (ws) => (await import('./frontier-intel.js')).frontierStats(ws),
  },
  // ─── R146.107 — Frontier MAX: capability catalog + permanent advancement ─
  'frontier.setMax': {
    description: 'Toggle MAX learning mode. true → 60s tick, 30 distill/batch, 10 prototype/batch, 10 advance/batch, 8 parallel scans, expanded source list. false → defaults. Params: enabled.',
    risk: 'medium',
    handler: async (ws, p) => (await import('./frontier-max.js')).setMaxMode(ws, p['enabled'] === true),
  },
  'frontier.setSettings': {
    description: 'Set custom frontier-intel tunables. Params: scanIntervalMs?, distillBatchSize?, prototypeBatchSize?, advanceBatchSize?, parallelSources?, maxMode?',
    risk: 'medium',
    handler: async (ws, p) => (await import('./frontier-max.js')).setCustomSettings(ws, {
      ...(typeof p['maxMode']            === 'boolean' ? { maxMode:            p['maxMode']            as boolean } : {}),
      ...(typeof p['scanIntervalMs']     === 'number'  ? { scanIntervalMs:     p['scanIntervalMs']     as number  } : {}),
      ...(typeof p['distillBatchSize']   === 'number'  ? { distillBatchSize:   p['distillBatchSize']   as number  } : {}),
      ...(typeof p['prototypeBatchSize'] === 'number'  ? { prototypeBatchSize: p['prototypeBatchSize'] as number  } : {}),
      ...(typeof p['advanceBatchSize']   === 'number'  ? { advanceBatchSize:   p['advanceBatchSize']   as number  } : {}),
      ...(typeof p['parallelSources']    === 'number'  ? { parallelSources:    p['parallelSources']    as number  } : {}),
    }),
  },
  'frontier.getSettings': {
    description: 'Read current frontier-intel settings.',
    risk: 'low',
    handler: async (ws) => (await import('./frontier-max.js')).getSettings(ws),
  },
  'frontier.maxTick': {
    description: 'Force one full MAX cycle now: parallel scans → distill → prototype → catalog → advance. Returns counts per phase.',
    risk: 'medium',
    handler: async (ws) => (await import('./frontier-max.js')).frontierMaxTick(ws),
  },
  'frontier.listCapabilities': {
    description: 'List capability catalog rows. Params: status?, category?, limit?',
    risk: 'low',
    handler: async (ws, p) => (await import('./frontier-max.js')).listCapabilities(ws, {
      ...(p['status']   ? { status:   String(p['status']) }   : {}),
      ...(p['category'] ? { category: String(p['category']) } : {}),
      ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}),
    }),
  },
  'frontier.listAdvancements': {
    description: 'List proposed advancements. Params: capabilityId?, limit?',
    risk: 'low',
    handler: async (ws, p) => (await import('./frontier-max.js')).listAdvancements(ws,
      p['capabilityId'] ? String(p['capabilityId']) : undefined,
      typeof p['limit'] === 'number' ? p['limit'] as number : 50,
    ),
  },
  'frontier.applyAdvancement': {
    description: 'Mark an advancement as applied with score deltas. Capability gets promoted to permanent after 5 applied. Params: advancementId, realism?, quality?, efficiency?, notes?',
    risk: 'medium',
    handler: async (ws, p) => (await import('./frontier-max.js')).applyAdvancement(ws, String(p['advancementId'] ?? ''), {
      ...(typeof p['realism']    === 'number' ? { realism:    p['realism']    as number } : {}),
      ...(typeof p['quality']    === 'number' ? { quality:    p['quality']    as number } : {}),
      ...(typeof p['efficiency'] === 'number' ? { efficiency: p['efficiency'] as number } : {}),
      ...(p['notes'] ? { notes: String(p['notes']) } : {}),
    }),
  },
  'frontier.capabilityStats': {
    description: 'Catalog stats: total, by status, by category, avg realism/quality/efficiency.',
    risk: 'low',
    handler: async (ws) => (await import('./frontier-max.js')).capabilityStats(ws),
  },
  // ─── R146.116 — gap closes (poster, TEAM, USAGE) ────────────────────
  'shortform.posterTick':  { description: 'Run the auto-poster now: post rendered clips with autoPostApproved=true to their target platforms via existing IG/TikTok/YT connectors. Soft-fails per-clip.', risk: 'high',
    handler: async (ws, p) => (await import('./r116-gap-fixes.js')).shortformPosterTick(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 10) },
  'shortform.approve':     { description: 'Flip auto_post_approved on/off for a pipeline. Required before clips post anywhere. Params: pipelineId, approved', risk: 'medium',
    handler: async (ws, p) => (await import('./r116-gap-fixes.js')).setPipelineAutoPostApproved(ws, String(p['pipelineId'] ?? ''), p['approved'] === true) },
  'team.orgChart':         { description: 'Read the agent org chart (ceo + reports). Powers the TEAM tab.', risk: 'low',
    handler: async (ws) => (await import('./r116-gap-fixes.js')).teamOrgChart(ws) },
  'usage.buckets':         { description: 'Token spend totals + per-provider + per-hour for the last N hours (default 168). Powers the USAGE tab.', risk: 'low',
    handler: async (ws, p) => (await import('./r116-gap-fixes.js')).usageBuckets(ws, typeof p['windowHours'] === 'number' ? p['windowHours'] as number : 168) },

  // ─── R146.118 — universal "do anything" surface ─────────────────────
  'novan.capabilities':    { description: 'List every brain op the platform exposes (name + description + risk). Use this to discover what Novan can do.', risk: 'low',
    handler: async () => (await import('./novan-do.js')).listCapabilities() },
  'novan.classifyIntent':  { description: 'Classify a free-form request into a category + suggested ops. Pure routing, executes nothing. Params: prompt', risk: 'low',
    handler: async (_w, p) => (await import('./novan-do.js')).classifyIntent(String(p['prompt'] ?? '')) },
  'novan.proposeCode':     { description: 'Draft a code change as a code_proposal. Operator must approve before code-agent ships. Params: title, summary, filesToCreate?, filesToModify?, testsRequired?, riskLevel?, reasoning?', risk: 'medium',
    handler: async (ws, p) => (await import('./novan-do.js')).proposeCodeChange(ws, p as unknown as Parameters<typeof import('./novan-do.js').proposeCodeChange>[1]) },
  'novan.http':            { description: 'Outbound HTTP from Novan to any public URL. SSRF-guarded (no loopback / private ranges). Body capped at 64 KiB. Params: method?, url, headers?, body?, timeoutMs?', risk: 'high',
    handler: async (ws, p) => (await import('./novan-do.js')).httpAction(ws, p as unknown as Parameters<typeof import('./novan-do.js').httpAction>[1]) },

  // ─── R146.119 — code proposal lifecycle (list / approve / build / list patches) ─
  'proposals.list':        { description: 'List code_proposals for this workspace. Params: status? (proposed|approved|rejected|shipped), limit?', risk: 'low',
    handler: async (ws, p) => {
      const { db } = await import('../db/client.js')
      const { codeProposals } = await import('../db/schema.js')
      const { and, eq, desc } = await import('drizzle-orm')
      const limit = Math.min(typeof p['limit'] === 'number' ? p['limit'] as number : 25, 100)
      const where = p['status']
        ? and(eq(codeProposals.workspaceId, ws), eq(codeProposals.status, String(p['status'])))
        : eq(codeProposals.workspaceId, ws)
      const rows = await db.select().from(codeProposals).where(where).orderBy(desc(codeProposals.createdAt)).limit(limit)
      return { count: rows.length, proposals: rows }
    } },
  'proposals.approve':     { description: 'Mark a code_proposal as approved. Required before proposals.build will produce a patch. Params: proposalId, approvedBy?', risk: 'high',
    handler: async (ws, p) => {
      const { db } = await import('../db/client.js')
      const { codeProposals, events } = await import('../db/schema.js')
      const { and, eq } = await import('drizzle-orm')
      const { v7: uuidv7 } = await import('uuid')
      const proposalId = String(p['proposalId'] ?? '')
      if (!proposalId) throw new Error('proposalId required')
      const now = Date.now()
      const updated = await db.update(codeProposals)
        .set({ status: 'approved', approvalId: String(p['approvedBy'] ?? 'operator'), updatedAt: now })
        .where(and(eq(codeProposals.workspaceId, ws), eq(codeProposals.id, proposalId)))
        .returning({ id: codeProposals.id, title: codeProposals.title, risk: codeProposals.riskLevel })
      if (!updated[0]) throw new Error('proposal not found')
      await db.insert(events).values({
        id: uuidv7(), workspaceId: ws, type: 'proposal.approved',
        payload: { proposalId, title: updated[0].title, risk: updated[0].risk, approvedBy: String(p['approvedBy'] ?? 'operator') },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'brain-task', version: 1, createdAt: now,
      }).catch(() => null)
      return { ok: true, proposalId, status: 'approved' }
    } },
  'proposals.build':       { description: 'Generate the patch for an approved proposal (runs code-agent: LLM-or-template → safety → sandbox). Writes a code_patches row; does NOT touch disk. Params: proposalId', risk: 'high',
    handler: async (ws, p) => (await import('./code-agent.js')).buildPatchFromProposal(ws, String(p['proposalId'] ?? '')) },
  'patches.list':          { description: 'List code_patches drafts (review-only outputs from code-agent). Params: proposalId?, status?, limit?', risk: 'low',
    handler: async (ws, p) => {
      const { db } = await import('../db/client.js')
      const { codePatches } = await import('../db/schema.js')
      const { and, eq, desc } = await import('drizzle-orm')
      const limit = Math.min(typeof p['limit'] === 'number' ? p['limit'] as number : 25, 100)
      const filters = [eq(codePatches.workspaceId, ws)]
      if (p['proposalId']) filters.push(eq(codePatches.proposalId, String(p['proposalId'])))
      if (p['status'])     filters.push(eq(codePatches.status,     String(p['status'])))
      const rows = await db.select().from(codePatches).where(and(...filters)).orderBy(desc(codePatches.createdAt)).limit(limit)
      return { count: rows.length, patches: rows }
    } },
  // ─── R146.128 — Tier 1 safety bundle (spend caps + moderation + backup) ─
  'spend.status':          { description: 'Current spend status for the workspace: dailyUsd · monthlyUsd · caps · blocked flag.', risk: 'low',
    handler: async (ws) => (await import('./r128-safety.js')).getSpendStatus(ws) },
  'spend.setCap':          { description: 'Set spend caps. Params: dailyUsdCap?, monthlyUsdCap?, hardBlock?, updatedBy?', risk: 'high',
    handler: async (ws, p) => { await (await import('./r128-safety.js')).setSpendCap(ws, p as Parameters<typeof import('./r128-safety.js').setSpendCap>[1]); return { ok: true } } },
  'moderation.scan':       { description: 'Run pre-post moderation on a text. Params: contentType (shortform|caption|image|video), text, contentRefId?, useLlm?', risk: 'low',
    handler: async (ws, p) => (await import('./r128-safety.js')).moderate(ws, { contentType: String(p['contentType'] ?? 'caption') as 'shortform'|'caption'|'image'|'video', text: String(p['text'] ?? ''), ...(p['contentRefId'] ? { contentRefId: String(p['contentRefId']) } : {}), ...(p['useLlm'] !== undefined ? { useLlm: p['useLlm'] === true } : {}) }) },
  'backup.run':            { description: 'Trigger a database backup now (writes to BACKUP_DESTINATION_URL). Logs to backup_runs.', risk: 'medium',
    handler: async () => (await import('./r128-safety.js')).runBackup() },
  'backup.list':           { description: 'List the last 30 backup runs.', risk: 'low',
    handler: async (_w, p) => (await import('./r128-safety.js')).listBackups(typeof p['limit'] === 'number' ? p['limit'] as number : 30) },

  // ─── R146.129 — revenue execution loop (idea → published) ──────────
  'revenue.start':         { description: 'Start a revenue execution run from an idea. Params: ideaTitle, ideaPitch', risk: 'medium',
    handler: async (ws, p) => (await import('./r129-revenue-loop.js')).start(ws, { ideaTitle: String(p['ideaTitle'] ?? ''), ideaPitch: String(p['ideaPitch'] ?? '') }) },
  'revenue.advance':       { description: 'Advance the state machine by one step (idempotent). Params: runId', risk: 'high',
    handler: async (ws, p) => (await import('./r129-revenue-loop.js')).advance(ws, String(p['runId'] ?? '')) },
  'revenue.approve':       { description: 'Approve a HIL gate (business/channels/content/publish). Params: runId, gate', risk: 'high',
    handler: async (ws, p) => { await (await import('./r129-revenue-loop.js')).approve(ws, String(p['runId'] ?? ''), String(p['gate'] ?? '')); return { ok: true } } },
  'revenue.halt':          { description: 'Halt a run (preserves state). Params: runId, reason', risk: 'medium',
    handler: async (ws, p) => { await (await import('./r129-revenue-loop.js')).halt(ws, String(p['runId'] ?? ''), String(p['reason'] ?? 'operator halt')); return { ok: true } } },
  'revenue.list':          { description: 'List revenue runs. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r129-revenue-loop.js')).list(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'revenue.get':           { description: 'Get a single revenue run. Params: runId', risk: 'low',
    handler: async (ws, p) => (await import('./r129-revenue-loop.js')).get(ws, String(p['runId'] ?? '')) },

  // ─── R146.130 — decision memory + A/B harness + morning briefing ────
  'decision.record':       { description: 'Record an operator decision (approve/reject/dismiss/snooze/edit) on a subject. Params: subjectType, subjectId, decision, reason?, features?', risk: 'low',
    handler: async (ws, p) => (await import('./r130-tier2.js')).recordDecision(ws, p as unknown as Parameters<typeof import('./r130-tier2.js').recordDecision>[1]) },
  'decision.shouldSuppress':{ description: 'Check if N similar rejections in the last D days warrant suppressing a new suggestion. Params: subjectType, featuresToMatch, windowDays?, thresholdRejections?', risk: 'low',
    handler: async (ws, p) => (await import('./r130-tier2.js')).shouldSuppress(ws, p as unknown as Parameters<typeof import('./r130-tier2.js').shouldSuppress>[1]) },
  'prompt.startTrial':     { description: 'Start an A/B trial on a prompt-evolution key. Params: promptKey, variantA, variantB, samplesTarget?', risk: 'medium',
    handler: async (ws, p) => (await import('./r130-tier2.js')).startTrial(ws, p as unknown as Parameters<typeof import('./r130-tier2.js').startTrial>[1]) },
  'prompt.recordAbOutcome': { description: 'Record an A/B trial outcome (a/b/tie). Auto-completes trial when samples_target reached. Params: trialId, outcome', risk: 'low',
    handler: async (ws, p) => (await import('./r130-tier2.js')).recordTrialOutcome(ws, String(p['trialId'] ?? ''), p['outcome'] as 'a'|'b'|'tie') },
  'prompt.listTrials':     { description: 'List A/B trials. Params: status?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r130-tier2.js')).listTrials(ws, p as { status?: string; limit?: number }) },
  'briefing.sendNow':      { description: 'Send the morning briefing push now (manual override of cron).', risk: 'low',
    handler: async (ws) => (await import('./r130-tier2.js')).sendMorningBriefing(ws) },

  // ─── R146.131 — platform quotas + revenue attribution ──────────────
  'quota.check':           { description: 'Check daily quota usage for a platform/action. Params: platform, action', risk: 'low',
    handler: async (ws, p) => (await import('./r131-quotas-attribution.js')).quotaCheck(ws, String(p['platform'] ?? ''), String(p['action'] ?? '')) },
  'quota.summary':         { description: 'Show todays usage across all known platforms.', risk: 'low',
    handler: async (ws) => (await import('./r131-quotas-attribution.js')).quotaSummary(ws) },
  'quota.setCap':          { description: 'Override the daily cap for one (platform, action). Params: platform, action, cap', risk: 'medium',
    handler: async (ws, p) => { await (await import('./r131-quotas-attribution.js')).setQuotaCap(ws, String(p['platform'] ?? ''), String(p['action'] ?? ''), Number(p['cap'] ?? 0)); return { ok: true } } },
  'attribution.link':      { description: 'Create an attribution edge (e.g. clip → post, post → channel, sale → product). Params: srcType, srcId, dstType, dstId, relation, weight?, metadata?', risk: 'low',
    handler: async (ws, p) => (await import('./r131-quotas-attribution.js')).linkEdge(ws, p as unknown as Parameters<typeof import('./r131-quotas-attribution.js').linkEdge>[1]) },
  'attribution.traceFwd':  { description: 'Trace forward from a node up to maxDepth (default 4). Params: srcType, srcId, maxDepth?', risk: 'low',
    handler: async (ws, p) => (await import('./r131-quotas-attribution.js')).traceForward(ws, p['srcType'] as 'clip'|'post'|'channel'|'business'|'product'|'sale', String(p['srcId'] ?? ''), typeof p['maxDepth'] === 'number' ? p['maxDepth'] as number : 4) },
  'attribution.traceBack': { description: 'Trace backward from a sale/revenue node to upstream contributors. Params: dstType, dstId, maxDepth?', risk: 'low',
    handler: async (ws, p) => (await import('./r131-quotas-attribution.js')).traceBackward(ws, p['dstType'] as 'clip'|'post'|'channel'|'business'|'product'|'sale', String(p['dstId'] ?? ''), typeof p['maxDepth'] === 'number' ? p['maxDepth'] as number : 4) },
  'attribution.list':      { description: 'List recent attribution edges. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r131-quotas-attribution.js')).listEdges(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 50) },

  // ─── R146.132 — cross-account planner + LLM drift ────────────────
  'account.setNiche':      { description: 'Set niche tags + posting slots for a connector account. Params: connectorAccountId, nicheTags, postingSlots?', risk: 'medium',
    handler: async (ws, p) => { await (await import('./r132-planner-drift.js')).setAccountNiche(ws, p as unknown as Parameters<typeof import('./r132-planner-drift.js').setAccountNiche>[1]); return { ok: true } } },
  'account.listNiches':    { description: 'List niche+slot config across all connector accounts.', risk: 'low',
    handler: async (ws) => (await import('./r132-planner-drift.js')).listAccountNiches(ws) },
  'plan.acrossAccounts':   { description: 'Plan post slots across accounts: assigns each item to best-fit account + first unused slot. Params: items: [{contentId, tags: string[]}]', risk: 'low',
    handler: async (ws, p) => (await import('./r132-planner-drift.js')).planAcrossAccounts(ws, (p['items'] ?? []) as Array<{ contentId: string; tags: string[] }>) },
  'llm.fingerprint':       { description: 'Compute + record the shape fingerprint of an LLM output. Detects drift vs prior. Params: promptKey, provider, model, output', risk: 'low',
    handler: async (ws, p) => (await import('./r132-planner-drift.js')).recordFingerprint(ws, p as unknown as Parameters<typeof import('./r132-planner-drift.js').recordFingerprint>[1]) },
  'llm.driftSummary':      { description: 'Summary of recent shape drift across prompts. Params: windowDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r132-planner-drift.js')).driftSummary(ws, typeof p['windowDays'] === 'number' ? p['windowDays'] as number : 7) },

  // ─── R146.134 — POD mass production ──────────────────────────────
  'pod.runBatch':          { description: 'Kick off a mass POD production batch: generates N designs × M product types, lists to chosen stores. Params: niche, designStyle?, targetCount? (1-200), productTypes? (tshirt/poster/mug/tote/hoodie/sticker), stores? (printful/shopify/etsy)', risk: 'high',
    handler: async (ws, p) => (await import('./r134-pod-mass.js')).startBatch(ws, p as unknown as Parameters<typeof import('./r134-pod-mass.js').startBatch>[1]) },
  'pod.batchStatus':       { description: 'Get a POD batch run status (generated/listed/failed counts). Params: batchId', risk: 'low',
    handler: async (ws, p) => (await import('./r134-pod-mass.js')).batchStatus(ws, String(p['batchId'] ?? '')) },
  'pod.batchItems':        { description: 'List items in a POD batch. Params: batchId, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r134-pod-mass.js')).batchItems(ws, String(p['batchId'] ?? ''), typeof p['limit'] === 'number' ? p['limit'] as number : 200) },
  'pod.listBatches':       { description: 'List recent POD batch runs. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r134-pod-mass.js')).listBatches(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'pod.haltBatch':         { description: 'Halt a running POD batch. Params: batchId, reason', risk: 'medium',
    handler: async (ws, p) => { await (await import('./r134-pod-mass.js')).haltBatch(ws, String(p['batchId'] ?? ''), String(p['reason'] ?? 'operator halt')); return { ok: true } } },

  // ─── R146.135 — S-tier ────────────────────────────────────────────
  'twin.simulate':         { description: '#1 Pre-flight twin simulation: project ~30 days of plausible metrics before committing a real run. Params: targetRunType (revenue|pod_batch|business_create), targetInput, horizonDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).twinSimulate(ws, p as unknown as Parameters<typeof import('./r135-s-tier.js').twinSimulate>[1]) },
  'speculative.start':     { description: '#2 Start a real-world A/B by posting variants to burner accounts. Params: baseClipId?, variants: [{label,hook,platform}], burnerMinutes?', risk: 'high',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).speculativeStart(ws, p as unknown as Parameters<typeof import('./r135-s-tier.js')['speculativeStart']>[1]) },
  'speculative.score':     { description: '#2 Score a speculative test, return winner label. Params: testId, metrics: [{label,saves?,likes?,views?,comments?}]', risk: 'medium',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).speculativeScore(ws, String(p['testId'] ?? ''), (p['metrics'] ?? []) as Array<{ label: string; saves?: number; likes?: number; views?: number; comments?: number }>) },
  'auction.open':          { description: '#3 Open a task auction. Agents bid (cost, confidence, eta). Params: taskType, taskPayload', risk: 'low',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).auctionOpen(ws, { taskType: String(p['taskType'] ?? ''), taskPayload: (p['taskPayload'] ?? {}) as Record<string, unknown> }) },
  'auction.bid':           { description: '#3 Submit a bid. Params: auctionId, agentId, costUsd, confidence (0..1), etaSec', risk: 'low',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).auctionBid(ws, String(p['auctionId'] ?? ''), { agentId: String(p['agentId'] ?? ''), costUsd: Number(p['costUsd'] ?? 0), confidence: Number(p['confidence'] ?? 0), etaSec: Number(p['etaSec'] ?? 0) }) },
  'auction.award':         { description: '#3 Close auction + award winner (best score = confidence/(cost+eta/3600)). Params: auctionId', risk: 'medium',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).auctionAward(ws, String(p['auctionId'] ?? '')) },
  'constitutional.audit':  { description: '#4 Audit platform against mission (drift, manipulation, scope creep). Params: kind? (weekly|on_demand)', risk: 'low',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).constitutionalAudit(ws, (p['kind'] === 'weekly' ? 'weekly' : 'on_demand')) },
  'funnel.imagine':        { description: '#5 Reverse-funnel: simulate N strategic paths to a $/mo target. Params: targetUsdMo, horizonMonths, pathCount?', risk: 'low',
    handler: async (ws, p) => (await import('./r135-s-tier.js')).funnelImagine(ws, { targetUsdMo: Number(p['targetUsdMo'] ?? 0), horizonMonths: Number(p['horizonMonths'] ?? 6), ...(typeof p['pathCount'] === 'number' ? { pathCount: p['pathCount'] as number } : {}) }) },

  // ─── R146.136 — A-tier ────────────────────────────────────────────
  'distill.assemble':      { description: '#6 Assemble a fine-tuning dataset from approved proposals/decisions/rejections. Writes JSONL to /tmp/novan/distill/. Params: kind (proposals|decisions|rejections|patches)', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).distillAssemble(ws, (p['kind'] ?? 'decisions') as 'proposals'|'decisions'|'rejections'|'patches') },
  'reality.reconcile':     { description: '#7 Compare expected (DB) vs actual (API) state. Params: source, expected, actual', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).realityReconcile(ws, { source: String(p['source'] ?? ''), expected: (p['expected'] ?? {}) as Record<string, unknown>, actual: (p['actual'] ?? {}) as Record<string, unknown> }) },
  'reality.list':          { description: '#7 List reality diffs. Params: resolved?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).listRealityDiffs(ws, { ...(typeof p['resolved'] === 'boolean' ? { resolved: p['resolved'] as boolean } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'anomaly.explain':       { description: '#8 Generate ranked hypothesis chain for an observed vs expected metric. Params: metric, observedValue, expectedValue', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).anomalyExplain(ws, { metric: String(p['metric'] ?? ''), observedValue: Number(p['observedValue'] ?? 0), expectedValue: Number(p['expectedValue'] ?? 0) }) },
  'sponsorship.draft':     { description: '#9 Draft outbound sponsorship DM + rate. Params: prospectBrand, channelNiche, followerCount, engagementRate?, channelId?', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).sponsorshipDraft(ws, { prospectBrand: String(p['prospectBrand'] ?? ''), channelNiche: String(p['channelNiche'] ?? ''), followerCount: Number(p['followerCount'] ?? 0), ...(typeof p['engagementRate'] === 'number' ? { engagementRate: p['engagementRate'] as number } : {}), ...(p['channelId'] ? { channelId: String(p['channelId']) } : {}) }) },
  'sponsorship.markSent':  { description: '#9 Mark a sponsorship outreach as sent. Params: outreachId', risk: 'medium',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).sponsorshipMarkSent(ws, String(p['outreachId'] ?? '')) },
  'sponsorship.list':      { description: '#9 List sponsorship outreach. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).sponsorshipList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'docs.regenerate':       { description: '#10 Regenerate auto-doc (architecture / ops_index / runbook) from observed reality. Params: docKind', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).docsRegenerate(ws, (p['docKind'] ?? 'architecture') as 'architecture'|'ops_index'|'runbook') },
  'docs.latest':           { description: '#10 Get latest auto-doc body. Params: docKind', risk: 'low',
    handler: async (ws, p) => (await import('./r136-a-tier.js')).docsLatest(ws, String(p['docKind'] ?? 'architecture')) },

  // ─── R146.137 — B-tier ────────────────────────────────────────────
  'injection.scan':        { description: '#11 Scan content for prompt-injection patterns. Params: source (transcript|scraped_page|oauth_payload|user_input), sourceRef?, content', risk: 'low',
    handler: async (ws, p) => (await import('./r137-b-tier.js')).scanForInjection(ws, { source: (p['source'] ?? 'user_input') as 'transcript'|'scraped_page'|'oauth_payload'|'user_input', ...(p['sourceRef'] ? { sourceRef: String(p['sourceRef']) } : {}), content: String(p['content'] ?? '') }) },
  'redteam.run':           { description: '#12 Run the AI red team suite (SSRF, prompt injection, moderation bypass, spend-cap bypass) and report.', risk: 'medium',
    handler: async (ws) => (await import('./r137-b-tier.js')).redteamRun(ws) },
  'provenance.sign':       { description: '#13 Sign a content manifest. Stores hmac-sha256(canonical(manifest)). Params: postId?, clipId?, manifest', risk: 'low',
    handler: async (ws, p) => (await import('./r137-b-tier.js')).provenanceSign(ws, { ...(p['postId'] ? { postId: String(p['postId']) } : {}), ...(p['clipId'] ? { clipId: String(p['clipId']) } : {}), manifest: (p['manifest'] ?? {}) as Record<string, unknown> }) },
  'provenance.verify':     { description: '#13 Verify a post is signed + manifest unmodified. Params: postId', risk: 'low',
    handler: async (ws, p) => (await import('./r137-b-tier.js')).provenanceVerify(ws, String(p['postId'] ?? '')) },
  'skill.roiRecord':       { description: '#14 Record cost/revenue for an op call. Params: opName, costUsd, revenueUsd?', risk: 'low',
    handler: async (ws, p) => { await (await import('./r137-b-tier.js')).skillRoiRecord(ws, { opName: String(p['opName'] ?? ''), costUsd: Number(p['costUsd'] ?? 0), ...(typeof p['revenueUsd'] === 'number' ? { revenueUsd: p['revenueUsd'] as number } : {}) }); return { ok: true } } },
  'skill.roiRank':         { description: '#14 Rank ops by ROI (revenue/cost). Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r137-b-tier.js')).skillRoiRank(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'agent.demoteTick':      { description: '#15 Propose throttle/retire for agents whose ROI is below threshold. Records to agent_demotions.', risk: 'medium',
    handler: async (ws) => (await import('./r137-b-tier.js')).agentDemotionTick(ws) },

  // ─── R146.138 — C-tier (final batch of the 20) ────────────────────
  'member.invite':         { description: '#16 Invite a workspace member with a role (owner|admin|dev|security|va|accountant|observer). Params: userId, role, invitedBy, scopeOverride?', risk: 'high',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).memberInvite(ws, { userId: String(p['userId'] ?? ''), role: String(p['role'] ?? 'observer') as 'owner'|'admin'|'dev'|'security'|'va'|'accountant'|'observer', invitedBy: String(p['invitedBy'] ?? 'operator'), ...(p['scopeOverride'] ? { scopeOverride: p['scopeOverride'] as string[] } : {}) }) },
  'member.list':           { description: '#16 List workspace members.', risk: 'low',
    handler: async (ws) => (await import('./r138-c-tier.js')).memberList(ws) },
  'member.hasScope':       { description: '#16 Check if a user has scope for an op. Params: userId, opName', risk: 'low',
    handler: async (ws, p) => ({ allowed: await (await import('./r138-c-tier.js')).memberHasScope(ws, String(p['userId'] ?? ''), String(p['opName'] ?? '')) }) },
  'negotiation.draft':     { description: '#17 Draft a negotiation: opening position, walk-away floor, BATNA. Params: counterparty, topic (stripe_fees|ig_ad_rate|contractor_sow|sponsor_rate), context', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).negotiationDraft(ws, { counterparty: String(p['counterparty'] ?? ''), topic: (p['topic'] ?? 'sponsor_rate') as 'stripe_fees'|'ig_ad_rate'|'contractor_sow'|'sponsor_rate', context: String(p['context'] ?? '') }) },
  'negotiation.appendTurn':{ description: '#17 Add a turn to a negotiation transcript. Params: id, role (us|them), content', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).negotiationAppendTurn(ws, { id: String(p['id'] ?? ''), role: (p['role'] === 'them' ? 'them' : 'us'), content: String(p['content'] ?? '') }) },
  'negotiation.list':      { description: '#17 List negotiations. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).negotiationList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'a2a.propose':           { description: '#18 Propose an agent-to-agent contract with a peer Novan workspace. Params: peerWorkspace, capability, revenueSplit?', risk: 'medium',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).a2aPropose(ws, { peerWorkspace: String(p['peerWorkspace'] ?? ''), capability: String(p['capability'] ?? ''), ...(typeof p['revenueSplit'] === 'number' ? { revenueSplit: p['revenueSplit'] as number } : {}) }) },
  'a2a.activate':          { description: '#18 Activate an A2A contract. Params: contractId', risk: 'high',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).a2aActivate(ws, String(p['contractId'] ?? '')) },
  'a2a.list':              { description: '#18 List A2A contracts.', risk: 'low',
    handler: async (ws) => (await import('./r138-c-tier.js')).a2aList(ws) },
  'calendar.record':       { description: '#19 Record an energy/load signal for a date. Used to defer cognitively-heavy drafts. Params: signalDate (YYYY-MM-DD), energyLevel (high|medium|low), predictedLoad?, recommendations?', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).calendarSignalRecord(ws, { signalDate: String(p['signalDate'] ?? new Date().toISOString().slice(0, 10)), energyLevel: (p['energyLevel'] ?? 'medium') as 'high'|'medium'|'low', ...(typeof p['predictedLoad'] === 'number' ? { predictedLoad: p['predictedLoad'] as number } : {}), ...(p['recommendations'] ? { recommendations: p['recommendations'] as string[] } : {}) }) },
  'calendar.upcoming':     { description: '#19 Upcoming calendar signals. Params: days?', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).calendarUpcoming(ws, typeof p['days'] === 'number' ? p['days'] as number : 7) },
  'commit.create':         { description: '#20 Create a time-locked commitment with hmac signature. Params: statement, deadlineAt (ms), forfeitUsd?, forfeitTo?', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).commitmentCreate(ws, { statement: String(p['statement'] ?? ''), deadlineAt: Number(p['deadlineAt'] ?? Date.now()), ...(typeof p['forfeitUsd'] === 'number' ? { forfeitUsd: p['forfeitUsd'] as number } : {}), ...(p['forfeitTo'] ? { forfeitTo: String(p['forfeitTo']) } : {}) }) },
  'commit.resolve':        { description: '#20 Resolve a commitment: fulfilled=true marks done, false marks forfeited. Params: id, fulfilled', risk: 'medium',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).commitmentResolve(ws, { id: String(p['id'] ?? ''), fulfilled: p['fulfilled'] === true }) },
  'commit.list':           { description: '#20 List commitments. Params: status?', risk: 'low',
    handler: async (ws, p) => (await import('./r138-c-tier.js')).commitmentList(ws, p['status'] ? String(p['status']) : undefined) },
  'commit.overdue':        { description: '#20 List active commitments past their deadline.', risk: 'low',
    handler: async (ws) => (await import('./r138-c-tier.js')).commitmentOverdue(ws) },

  // ─── R146.139 — AI foundation (semantic memory + structured output + tool-use + eval + vision) ─
  'memory.store':          { description: '#1 Store a content chunk in semantic memory (auto-embed). Params: content, sourceType (chat|decision|proposal|doc|event|manual), sourceId?, metadata?, pinned?', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).memoryStore(ws, { content: String(p['content'] ?? ''), sourceType: (p['sourceType'] ?? 'manual') as 'chat'|'decision'|'proposal'|'doc'|'event'|'manual', ...(p['sourceId'] ? { sourceId: String(p['sourceId']) } : {}), ...(p['metadata'] ? { metadata: p['metadata'] as Record<string, unknown> } : {}), ...(p['pinned'] === true ? { pinned: true } : {}) }) },
  'memory.recall':         { description: '#1 Semantic recall top-k chunks for a query. Params: query, k?, sourceType?', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).memoryRecall(ws, { query: String(p['query'] ?? ''), ...(typeof p['k'] === 'number' ? { k: p['k'] as number } : {}), ...(p['sourceType'] ? { sourceType: String(p['sourceType']) } : {}) }) },
  'memory.pin':            { description: '#1 Pin or unpin a memory chunk. Params: id, pinned', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).memoryPin(ws, String(p['id'] ?? ''), p['pinned'] === true) },
  'memory.delete':         { description: '#1 Delete a memory chunk. Params: id', risk: 'medium',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).memoryDelete(ws, String(p['id'] ?? '')) },
  'structured.call':       { description: '#2 Run LLM with JSON-schema enforcement + auto-retry. Params: messages: [{role,content}], jsonSchema, maxRetries?, maxTokens?', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).structuredCall(ws, p as unknown as Parameters<typeof import('./r139-ai-foundation.js').structuredCall>[1]) },
  'agent.run':             { description: '#3 ReAct tool-use loop: LLM picks ops from whitelist, observes results, iterates. Params: goal, maxSteps?, contextMemoryK?', risk: 'medium',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).agentLoop(ws, { goal: String(p['goal'] ?? ''), ...(typeof p['maxSteps'] === 'number' ? { maxSteps: p['maxSteps'] as number } : {}), ...(typeof p['contextMemoryK'] === 'number' ? { contextMemoryK: p['contextMemoryK'] as number } : {}) }) },
  'eval.addCase':          { description: '#4 Add a golden test case for a prompt. Params: promptKey, input, expected?, rubric?, weight?', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).evalAddCase(ws, p as unknown as Parameters<typeof import('./r139-ai-foundation.js').evalAddCase>[1]) },
  'eval.run':              { description: '#4 Run all eval cases for a prompt key. Params: promptKey, promptText?, promptVersion?', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).evalRun(ws, String(p['promptKey'] ?? ''), { ...(p['promptText'] ? { promptText: String(p['promptText']) } : {}), ...(p['promptVersion'] ? { promptVersion: String(p['promptVersion']) } : {}) }) },
  'vision.chat':           { description: '#5 Multi-modal chat with image URL input. Params: prompt, imageUrl', risk: 'low',
    handler: async (ws, p) => (await import('./r139-ai-foundation.js')).visionChat(ws, { prompt: String(p['prompt'] ?? ''), imageUrl: String(p['imageUrl'] ?? '') }) },

  // ─── R146.140 — A-tier AI ─────────────────────────────────────────
  'ollama.status':         { description: '#6 Check Ollama health + list local models.', risk: 'low',
    handler: async () => (await import('./r140-ai-a-tier.js')).ollamaStatus() },
  'route.forTask':         { description: '#7 Recommend provider+model for a task type. Params: taskType', risk: 'low',
    handler: async (_w, p) => (await import('./r140-ai-a-tier.js')).routeForTask(String(p['taskType'] ?? 'other')) },
  'route.table':           { description: '#7 Full task→provider routing table.', risk: 'low',
    handler: async () => (await import('./r140-ai-a-tier.js')).routingTable() },
  'cache.lookup':          { description: '#8 Semantic inference-cache lookup. Params: messages, taskType', risk: 'low',
    handler: async (ws, p) => (await import('./r140-ai-a-tier.js')).cacheLookup(ws, { messages: (p['messages'] ?? []) as Array<{ role: string; content: string }>, taskType: String(p['taskType'] ?? 'chat') }) },
  'cache.store':           { description: '#8 Store a response in semantic cache. Params: messages, response, taskType, provider', risk: 'low',
    handler: async (ws, p) => (await import('./r140-ai-a-tier.js')).cacheStore(ws, { messages: (p['messages'] ?? []) as Array<{ role: string; content: string }>, response: String(p['response'] ?? ''), taskType: String(p['taskType'] ?? 'chat'), provider: String(p['provider'] ?? 'unknown') }) },
  'cache.inferenceStats':  { description: '#8 Inference cache stats: total entries, hits, top-hit rows.', risk: 'low',
    handler: async (ws) => (await import('./r140-ai-a-tier.js')).cacheStats(ws) },
  'template.save':         { description: '#9 Save a versioned prompt template. Params: name, body, inputSchema?, outputSchema?', risk: 'low',
    handler: async (ws, p) => (await import('./r140-ai-a-tier.js')).templateSave(ws, { name: String(p['name'] ?? ''), body: String(p['body'] ?? ''), ...(p['inputSchema'] ? { inputSchema: p['inputSchema'] as Record<string, unknown> } : {}), ...(p['outputSchema'] ? { outputSchema: p['outputSchema'] as Record<string, unknown> } : {}) }) },
  'template.render':       { description: '#9 Render an active template with {{var}} substitution. Params: name, variables', risk: 'low',
    handler: async (ws, p) => (await import('./r140-ai-a-tier.js')).templateRender(ws, { name: String(p['name'] ?? ''), variables: (p['variables'] ?? {}) as Record<string, unknown> }) },
  'template.list':         { description: '#9 List prompt templates. Params: activeOnly?', risk: 'low',
    handler: async (ws, p) => (await import('./r140-ai-a-tier.js')).templateList(ws, { ...(p['activeOnly'] === true ? { activeOnly: true } : {}) }) },
  'llm.observability':     { description: '#10 LLM observability: totals + by provider/model/taskType/hour over a window. Params: windowHours?', risk: 'low',
    handler: async (ws, p) => (await import('./r140-ai-a-tier.js')).llmObservability(ws, { ...(typeof p['windowHours'] === 'number' ? { windowHours: p['windowHours'] as number } : {}) }) },

  // ─── R146.141 — B-tier AI ─────────────────────────────────────────
  'debate.run':            { description: '#11 Multi-agent debate: N participants take turns, then a synthesis with confidence. Params: question, participants: [{name,prior}], rounds?', risk: 'low',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).debateRun(ws, { question: String(p['question'] ?? ''), participants: (p['participants'] ?? []) as Array<{ name: string; prior: string }>, ...(typeof p['rounds'] === 'number' ? { rounds: p['rounds'] as number } : {}) }) },
  'parallel.call':         { description: '#12 Call multiple brain ops in parallel. Params: calls: [{op, params?}]', risk: 'medium',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).parallelOpCall(ws, (p['calls'] ?? []) as Array<{ op: string; params?: Record<string, unknown> }>) },
  'profile.get':           { description: '#13 Get the operator profile (facts + preferences).', risk: 'low',
    handler: async (ws) => (await import('./r141-ai-b-tier.js')).profileGet(ws) },
  'profile.pinFact':       { description: '#13 Pin a fact in the operator profile. Params: key, value', risk: 'low',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).profilePinFact(ws, { key: String(p['key'] ?? ''), value: String(p['value'] ?? '') }) },
  'profile.setPref':       { description: '#13 Set a preference. Params: key, value', risk: 'low',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).profileSetPref(ws, String(p['key'] ?? ''), p['value']) },
  'profile.promptPrefix':  { description: '#13 Render operator profile as a prompt prefix (for prepending to LLM system prompts).', risk: 'low',
    handler: async (ws) => ({ prefix: await (await import('./r141-ai-b-tier.js')).profileToPromptPrefix(ws) }) },
  'synthetic.generate':    { description: '#14 Generate N synthetic training examples from seed examples. Params: taskKind, seedExamples, count', risk: 'medium',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).syntheticGenerate(ws, { taskKind: String(p['taskKind'] ?? ''), seedExamples: (p['seedExamples'] ?? []) as Array<Record<string, unknown>>, count: Number(p['count'] ?? 20) }) },
  'synthetic.list':        { description: '#14 List synthetic data runs. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).syntheticList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'descriptions.regenerate': { description: '#15 LLM-regenerate brain-op descriptions for clarity. Sample N ops. Params: sampleN?', risk: 'low',
    handler: async (ws, p) => (await import('./r141-ai-b-tier.js')).descriptionsRegenerate(ws, typeof p['sampleN'] === 'number' ? p['sampleN'] as number : 20) },

  // ─── R146.142 — C-tier AI (final batch of the 20) ─────────────────
  'transform.stream':      { description: '#16 Streaming LLM with per-delta transform (uppercase|lowercase|censor_pii|strip_html). Params: messages, transform', risk: 'low',
    handler: async (ws, p) => (await import('./r142-ai-c-tier.js')).transformingStream(ws, { messages: (p['messages'] ?? []) as Array<{ role: 'system'|'user'|'assistant'; content: string }>, transform: (p['transform'] ?? 'strip_html') as 'uppercase'|'lowercase'|'censor_pii'|'strip_html' }) },
  'cost.predict':          { description: '#17 Predict token count + USD cost before firing an LLM call. Params: messages, expectedOutputChars?, model?', risk: 'low',
    handler: async (_w, p) => (await import('./r142-ai-c-tier.js')).predictCost({ messages: (p['messages'] ?? []) as Array<{ role: string; content: string }>, ...(typeof p['expectedOutputChars'] === 'number' ? { expectedOutputChars: p['expectedOutputChars'] as number } : {}), ...(p['model'] ? { model: String(p['model']) } : {}) }) },
  'interrupt.start':       { description: '#18 Open an interruptible session — returns sessionId + signal. Caller passes signal to streamChat opts.', risk: 'low',
    handler: async () => { const { sessionId } = (await import('./r142-ai-c-tier.js')).startInterruptibleSession(); return { sessionId } } },
  'interrupt.cancel':      { description: '#18 Cancel an in-flight session. Params: sessionId', risk: 'low',
    handler: async (_w, p) => (await import('./r142-ai-c-tier.js')).interrupt(String(p['sessionId'] ?? '')) },
  'finetune.submit':       { description: '#19 Submit a fine-tune job to provider. Params: provider (openai|anthropic), baseModel, datasetPath', risk: 'high',
    handler: async (ws, p) => (await import('./r142-ai-c-tier.js')).finetuneSubmit(ws, { provider: (p['provider'] ?? 'openai') as 'openai'|'anthropic', baseModel: String(p['baseModel'] ?? ''), datasetPath: String(p['datasetPath'] ?? '') }) },
  'finetune.list':         { description: '#19 List fine-tune jobs. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r142-ai-c-tier.js')).finetuneList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'batch.submit':          { description: '#20 Submit batch requests (50% discount, 24h SLA). Params: provider (anthropic|openai), requests', risk: 'medium',
    handler: async (ws, p) => (await import('./r142-ai-c-tier.js')).batchSubmit(ws, { provider: (p['provider'] ?? 'anthropic') as 'anthropic'|'openai', requests: (p['requests'] ?? []) as Array<Record<string, unknown>> }) },
  'batch.status':          { description: '#20 Check batch job status. Params: jobId', risk: 'low',
    handler: async (ws, p) => (await import('./r142-ai-c-tier.js')).batchStatus(ws, String(p['jobId'] ?? '')) },
  'batch.list':            { description: '#20 List batch jobs. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r142-ai-c-tier.js')).batchList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },

  // ─── R146.143 — S2-tier AI 21-25 ──────────────────────────────────
  'rag.chat':              { description: '#21 Auto-RAG chat: prepend top-k relevant memory chunks before LLM call. Params: messages, topic?, k?', risk: 'low',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).ragChat(ws, { messages: (p['messages'] ?? []) as Array<{ role: 'system'|'user'|'assistant'; content: string }>, ...(p['topic'] ? { topic: String(p['topic']) } : {}), ...(typeof p['k'] === 'number' ? { k: p['k'] as number } : {}) }) },
  'workflow.define':       { description: '#22 Define a multi-step workflow. Params: name, steps: [{name, opName, params}]', risk: 'medium',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).workflowDefine(ws, { name: String(p['name'] ?? ''), steps: (p['steps'] ?? []) as Array<{ name: string; opName: string; params: Record<string, unknown> }> }) },
  'workflow.start':        { description: '#22 Start a workflow run with checkpointing. Params: workflowId', risk: 'high',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).workflowStart(ws, String(p['workflowId'] ?? '')) },
  'workflow.advance':      { description: '#22 Resume a paused/failed workflow run. Params: runId', risk: 'medium',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).workflowAdvance(ws, String(p['runId'] ?? '')) },
  'workflow.list':         { description: '#22 List workflow definitions.', risk: 'low',
    handler: async (ws) => (await import('./r143-ai-s2-tier.js')).workflowList(ws) },
  'workflow.runs':         { description: '#22 List recent workflow runs. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).workflowRunList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'finetune.cycleStart':   { description: '#23 Start a self-supervised fine-tune cycle (distill → submit). Params: baseModel, distillKind', risk: 'high',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).finetuneCycleStart(ws, { baseModel: String(p['baseModel'] ?? ''), distillKind: (p['distillKind'] ?? 'decisions') as 'proposals'|'decisions'|'rejections'|'patches' }) },
  'finetune.cycleList':    { description: '#23 List fine-tune cycles.', risk: 'low',
    handler: async (ws) => (await import('./r143-ai-s2-tier.js')).finetuneCycleList(ws) },
  'voice.sessionOpen':     { description: '#24 Open a voice session for full-duplex chat. Returns sessionId.', risk: 'low',
    handler: async (ws) => (await import('./r143-ai-s2-tier.js')).voiceSessionOpen(ws) },
  'voice.sessionAppend':   { description: '#24 Append text to a voice session transcript. Params: sessionId, text, role (user|assistant)', risk: 'low',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).voiceSessionAppend(ws, { sessionId: String(p['sessionId'] ?? ''), text: String(p['text'] ?? ''), role: (p['role'] === 'assistant' ? 'assistant' : 'user') }) },
  'voice.sessionClose':    { description: '#24 Close a voice session. Params: sessionId', risk: 'low',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).voiceSessionClose(ws, String(p['sessionId'] ?? '')) },
  'mcp.registerClient':    { description: '#25 Register an external MCP client. Returns apiKey (shown once). Params: name, allowedOps', risk: 'high',
    handler: async (ws, p) => (await import('./r143-ai-s2-tier.js')).mcpRegisterClient(ws, { name: String(p['name'] ?? ''), allowedOps: (p['allowedOps'] ?? []) as string[] }) },
  'mcp.listClients':       { description: '#25 List registered MCP clients (no api keys).', risk: 'low',
    handler: async (ws) => (await import('./r143-ai-s2-tier.js')).mcpClientList(ws) },

  // ─── R146.144 — A2-tier AI 26-30 ──────────────────────────────────
  'consensus.vote':        { description: '#26 Query N providers, take majority answer. Params: messages, providers, parseAs?', risk: 'medium',
    handler: async (ws, p) => (await import('./r144-ai-a2-tier.js')).consensusVote(ws, { messages: (p['messages'] ?? []) as Array<{ role: 'system'|'user'|'assistant'; content: string }>, providers: (p['providers'] ?? []) as string[], ...(p['parseAs'] ? { parseAs: p['parseAs'] as 'string'|'json'|'boolean' } : {}) }) },
  'transform.chain':       { description: '#27 Stream chat through a chain of delta transforms. Params: messages, transforms (uppercase|lowercase|strip_html|censor_pii|trim)', risk: 'low',
    handler: async (ws, p) => (await import('./r144-ai-a2-tier.js')).transformChain(ws, { messages: (p['messages'] ?? []) as Array<{ role: 'system'|'user'|'assistant'; content: string }>, transforms: (p['transforms'] ?? []) as string[] }) },
  'eval.bisect':           { description: '#28 Find which prompt version regressed by bisecting eval run history. Params: promptKey', risk: 'low',
    handler: async (ws, p) => (await import('./r144-ai-a2-tier.js')).evalBisect(ws, String(p['promptKey'] ?? '')) },
  'memory.dedup':          { description: '#29 Find + remove near-duplicate memory chunks via embedding similarity. Params: dryRun?, limit?', risk: 'medium',
    handler: async (ws, p) => (await import('./r144-ai-a2-tier.js')).memoryDedup(ws, { ...(p['dryRun'] === true ? { dryRun: true } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'speculative.preview':   { description: '#30 Stream first N deltas as preview; returns sessionId to cancel full run. Params: messages, previewDeltas?', risk: 'low',
    handler: async (ws, p) => (await import('./r144-ai-a2-tier.js')).speculativePreview(ws, { messages: (p['messages'] ?? []) as Array<{ role: 'system'|'user'|'assistant'; content: string }>, ...(typeof p['previewDeltas'] === 'number' ? { previewDeltas: p['previewDeltas'] as number } : {}) }) },

  // ─── R146.145 — B2-tier AI 31-35 ──────────────────────────────────
  'model.swapAdvice':      { description: '#31 Mid-stream model swap advice based on progress. Params: tokensSoFar, totalEstimate', risk: 'low',
    handler: async (_w, p) => (await import('./r145-ai-b2-tier.js')).midstreamSwapAdvice({ tokensSoFar: Number(p['tokensSoFar'] ?? 0), totalEstimate: Number(p['totalEstimate'] ?? 1) }) },
  'embed.cached':          { description: '#32 Embed text with cache hit. Params: text', risk: 'low',
    handler: async (_w, p) => (await import('./r145-ai-b2-tier.js')).embedCached(String(p['text'] ?? '')) },
  'embed.cacheStats':      { description: '#32 Embedding cache stats.', risk: 'low',
    handler: async () => (await import('./r145-ai-b2-tier.js')).embedCacheStats() },
  'context.fit':           { description: '#33 Auto-summarize older messages to fit in token budget. Params: messages, maxTokens', risk: 'low',
    handler: async (ws, p) => (await import('./r145-ai-b2-tier.js')).contextWindowFit(ws, { messages: (p['messages'] ?? []) as Array<{ role: 'system'|'user'|'assistant'; content: string }>, maxTokens: Number(p['maxTokens'] ?? 8000) }) },
  'model.pinOp':           { description: '#34 Pin a provider+model to a specific op. Params: opName, provider, model', risk: 'medium',
    handler: async (ws, p) => (await import('./r145-ai-b2-tier.js')).modelPinOp(ws, { opName: String(p['opName'] ?? ''), provider: String(p['provider'] ?? ''), model: String(p['model'] ?? '') }) },
  'model.pinResolve':      { description: '#34 Resolve the pinned model for an op (or null). Params: opName', risk: 'low',
    handler: async (ws, p) => (await import('./r145-ai-b2-tier.js')).modelPinResolve(ws, String(p['opName'] ?? '')) },
  'model.pinList':         { description: '#34 List all per-op model pins.', risk: 'low',
    handler: async (ws) => (await import('./r145-ai-b2-tier.js')).modelPinList(ws) },
  'temp.record':           { description: '#35 Record temperature outcome for a task type. Adapts via climbing heuristic. Params: taskType, temperature, score', risk: 'low',
    handler: async (ws, p) => (await import('./r145-ai-b2-tier.js')).adaptiveTempRecord(ws, { taskType: String(p['taskType'] ?? ''), temperature: Number(p['temperature'] ?? 0.7), score: Number(p['score'] ?? 0) }) },
  'temp.get':              { description: '#35 Get the adapted temperature for a task type. Params: taskType', risk: 'low',
    handler: async (ws, p) => (await import('./r145-ai-b2-tier.js')).adaptiveTempGet(ws, String(p['taskType'] ?? '')) },

  // ─── R146.146 — C2-tier AI 36-40 (final of next 20) ───────────────
  'density.summarize':     { description: '#36 Chain-of-density: iteratively denser summary, same length, more entities. Params: source, rounds?', risk: 'low',
    handler: async (ws, p) => (await import('./r146-ai-c2-tier.js')).chainOfDensity(ws, { source: String(p['source'] ?? ''), ...(typeof p['rounds'] === 'number' ? { rounds: p['rounds'] as number } : {}) }) },
  'constitutional.draft':  { description: '#37 LLM draft → self-critique vs constitution → revise. Params: task, constitution?, maxRevisions?', risk: 'low',
    handler: async (ws, p) => (await import('./r146-ai-c2-tier.js')).constitutionalDraft(ws, { task: String(p['task'] ?? ''), ...(p['constitution'] ? { constitution: p['constitution'] as string[] } : {}), ...(typeof p['maxRevisions'] === 'number' ? { maxRevisions: p['maxRevisions'] as number } : {}) }) },
  'tot.reason':            { description: '#38 Tree-of-thoughts: branch N reasoning approaches, score, pick winner. Params: problem, branches?', risk: 'low',
    handler: async (ws, p) => (await import('./r146-ai-c2-tier.js')).treeOfThoughts(ws, { problem: String(p['problem'] ?? ''), ...(typeof p['branches'] === 'number' ? { branches: p['branches'] as number } : {}) }) },
  'active.surface':        { description: '#39 Surface eval boundary cases (pass rate closest to 50%) for operator labeling. Params: promptKey, topN?', risk: 'low',
    handler: async (ws, p) => (await import('./r146-ai-c2-tier.js')).activeLearningSurface(ws, { promptKey: String(p['promptKey'] ?? ''), ...(typeof p['topN'] === 'number' ? { topN: p['topN'] as number } : {}) }) },
  'hybrid.solve':          { description: '#40 Symbolic+LLM hybrid solver — tries arithmetic/date math first, falls back to LLM. Params: question', risk: 'low',
    handler: async (ws, p) => (await import('./r146-ai-c2-tier.js')).hybridSolve(ws, { question: String(p['question'] ?? '') }) },

  // ─── R146.147 — Second-brain S-tier (#1-5) ────────────────────────
  'links.extract':         { description: 'SB#1 Scan a chunk for [[wiki-link]]s, resolve + persist directed edges. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).linksExtract(ws, String(p['chunkId'] ?? '')) },
  'links.forward':         { description: 'SB#1 Outgoing wiki-links from a chunk. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).linksForward(ws, String(p['chunkId'] ?? '')) },
  'links.backlinks':       { description: 'SB#1 Backlinks (incoming) for a chunk. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).linksBacklinks(ws, String(p['chunkId'] ?? '')) },
  'daily.for':             { description: 'SB#2 Get or create todays daily note (or specified date). Params: date? YYYY-MM-DD', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).dailyNoteFor(ws, p['date'] ? String(p['date']) : undefined) },
  'daily.list':            { description: 'SB#2 List recent daily notes. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).dailyNoteList(ws, { ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'tags.extract':          { description: 'SB#3 Auto-extract tags + entities from a chunk via LLM. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).tagsExtract(ws, String(p['chunkId'] ?? '')) },
  'tags.forChunk':         { description: 'SB#3 List tags on a chunk. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).tagsForChunk(ws, String(p['chunkId'] ?? '')) },
  'tags.chunksWith':       { description: 'SB#3 List chunks with a tag. Params: tag, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).chunksWithTag(ws, String(p['tag'] ?? ''), typeof p['limit'] === 'number' ? p['limit'] as number : 50) },
  'outline.setParent':     { description: 'SB#4 Set a chunks parent in the outline tree. Params: chunkId, parentChunkId, sortOrder?', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).outlineSetParent(ws, { chunkId: String(p['chunkId'] ?? ''), parentChunkId: p['parentChunkId'] ? String(p['parentChunkId']) : null, ...(typeof p['sortOrder'] === 'number' ? { sortOrder: p['sortOrder'] as number } : {}) }) },
  'outline.children':      { description: 'SB#4 List direct children of a chunk (or roots if null). Params: parentChunkId?', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).outlineChildren(ws, p['parentChunkId'] ? String(p['parentChunkId']) : null) },
  'outline.toggleCollapse':{ description: 'SB#4 Toggle collapsed state. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).outlineToggleCollapse(ws, String(p['chunkId'] ?? '')) },
  'inbox.capture':         { description: 'SB#5 Quick-capture into inbox. Params: kind (url|voice|photo|text|note), rawContent, sourceUrl?', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).inboxCapture(ws, { kind: (p['kind'] ?? 'note') as 'url'|'voice'|'photo'|'text'|'note', rawContent: String(p['rawContent'] ?? ''), ...(p['sourceUrl'] ? { sourceUrl: String(p['sourceUrl']) } : {}) }) },
  'inbox.list':            { description: 'SB#5 List inbox items. Params: processed?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).inboxList(ws, { ...(typeof p['processed'] === 'boolean' ? { processed: p['processed'] as boolean } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'inbox.processTick':     { description: 'SB#5 Process N unprocessed inbox items: extract + store + auto-tag. Params: limit?', risk: 'medium',
    handler: async (ws, p) => (await import('./r147-sb-s-tier.js')).inboxProcessTick(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 5) },

  // ─── R146.148 — SB A-tier (#6-10) ─────────────────────────────────
  'srs.add':               { description: 'SB#6 Add an SRS card. Params: chunkId, front, back', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).srsAdd(ws, { chunkId: String(p['chunkId'] ?? ''), front: String(p['front'] ?? ''), back: String(p['back'] ?? '') }) },
  'srs.due':               { description: 'SB#6 List cards due for review. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).srsDue(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 20) },
  'srs.review':            { description: 'SB#6 Review a card with grade 0-5 (SM-2). Params: id, grade', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).srsReview(ws, { id: String(p['id'] ?? ''), grade: Number(p['grade'] ?? 3) }) },
  'person.add':            { description: 'SB#7 Add a person to CRM. Params: name, email?, org?, notes?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).personAdd(ws, { name: String(p['name'] ?? ''), ...(p['email'] ? { email: String(p['email']) } : {}), ...(p['org'] ? { org: String(p['org']) } : {}), ...(p['notes'] ? { notes: String(p['notes']) } : {}) }) },
  'person.interact':       { description: 'SB#7 Log an interaction. Params: personId, channel (meeting|email|dm|call|in_person), notes, occurredAt?, followUpInDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).personInteractionAdd(ws, { personId: String(p['personId'] ?? ''), channel: (p['channel'] ?? 'email') as 'meeting'|'email'|'dm'|'call'|'in_person', notes: String(p['notes'] ?? ''), ...(typeof p['occurredAt'] === 'number' ? { occurredAt: p['occurredAt'] as number } : {}), ...(typeof p['followUpInDays'] === 'number' ? { followUpInDays: p['followUpInDays'] as number } : {}) }) },
  'person.list':           { description: 'SB#7 List people. Params: followUpDue?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).personList(ws, { ...(p['followUpDue'] === true ? { followUpDue: true } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'person.history':        { description: 'SB#7 Interaction history for a person. Params: personId, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).personHistory(ws, String(p['personId'] ?? ''), typeof p['limit'] === 'number' ? p['limit'] as number : 50) },
  'reading.add':           { description: 'SB#8 Add to reading queue. Params: title, url?, estimatedMin?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).readingAdd(ws, { title: String(p['title'] ?? ''), ...(p['url'] ? { url: String(p['url']) } : {}), ...(typeof p['estimatedMin'] === 'number' ? { estimatedMin: p['estimatedMin'] as number } : {}) }) },
  'reading.start':         { description: 'SB#8 Start reading. Params: id', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).readingStart(ws, String(p['id'] ?? '')) },
  'reading.finish':        { description: 'SB#8 Mark as done. Params: id, notesChunkId?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).readingFinish(ws, { id: String(p['id'] ?? ''), ...(p['notesChunkId'] ? { notesChunkId: String(p['notesChunkId']) } : {}) }) },
  'reading.list':          { description: 'SB#8 List reading queue. Params: status?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).readingList(ws, { ...(p['status'] ? { status: String(p['status']) } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'backlinks.top':         { description: 'SB#9 Most-linked-to chunks. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).backlinksTop(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 20) },
  'backlinks.orphans':     { description: 'SB#9 Chunks with no incoming or outgoing links. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).orphanChunks(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'weekly.generate':       { description: 'SB#10 Generate a weekly review synthesis. Params: week? (YYYY-MM-DD Monday)', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).weeklyReviewGenerate(ws, p['week'] ? String(p['week']) : undefined) },
  'weekly.list':           { description: 'SB#10 List weekly reviews. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r148-sb-a-tier.js')).weeklyReviewList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 12) },

  // ─── R146.149 — SB B-tier (#11-15) ────────────────────────────────
  'decision.log':          { description: 'SB#11 Log a decision with reasoning + expected outcome + confidence + review-in days. Params: question, reasoning, expectedOutcome?, alternatives?, confidence?, reviewInDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).decisionLog(ws, { question: String(p['question'] ?? ''), reasoning: String(p['reasoning'] ?? ''), ...(p['expectedOutcome'] ? { expectedOutcome: String(p['expectedOutcome']) } : {}), ...(Array.isArray(p['alternatives']) ? { alternatives: p['alternatives'] as string[] } : {}), ...(typeof p['confidence'] === 'number' ? { confidence: p['confidence'] as number } : {}), ...(typeof p['reviewInDays'] === 'number' ? { reviewInDays: p['reviewInDays'] as number } : {}) }) },
  'decision.review':       { description: 'SB#11 Review a decision in hindsight. Params: id, actualOutcome, actualConfidence (0..1)', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).decisionReview(ws, { id: String(p['id'] ?? ''), actualOutcome: String(p['actualOutcome'] ?? ''), actualConfidence: Number(p['actualConfidence'] ?? 0.5) }) },
  'decision.list':         { description: 'SB#11 List decisions. Params: dueOnly?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).decisionList(ws, { ...(p['dueOnly'] === true ? { dueOnly: true } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'idea.capture':          { description: 'SB#12 Capture an idea into the incubator. Params: title, body', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).ideaCapture(ws, { title: String(p['title'] ?? ''), body: String(p['body'] ?? '') }) },
  'idea.mention':          { description: 'SB#12 Bump mention count for an idea. Params: ideaId', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).ideaMention(ws, String(p['ideaId'] ?? '')) },
  'idea.setStatus':        { description: 'SB#12 Promote or discard an idea. Params: id, status (incubating|promoted|discarded)', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).ideaSetStatus(ws, { id: String(p['id'] ?? ''), status: (p['status'] ?? 'incubating') as 'incubating'|'promoted'|'discarded' }) },
  'idea.resonating':       { description: 'SB#12 Ideas still alive after N days with mentions. Params: minDaysOld?, minMentions?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).ideasResonating(ws, { ...(typeof p['minDaysOld'] === 'number' ? { minDaysOld: p['minDaysOld'] as number } : {}), ...(typeof p['minMentions'] === 'number' ? { minMentions: p['minMentions'] as number } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'qa.capture':            { description: 'SB#13 Capture a Q&A pair as searchable memory. Params: question, answer, conversationId?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).qaCapture(ws, { question: String(p['question'] ?? ''), answer: String(p['answer'] ?? ''), ...(p['conversationId'] ? { conversationId: String(p['conversationId']) } : {}) }) },
  'qa.find':               { description: 'SB#13 Semantic search past Q&A. Params: query, k?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).qaFind(ws, { query: String(p['query'] ?? ''), ...(typeof p['k'] === 'number' ? { k: p['k'] as number } : {}) }) },
  'concept.maturityTick':  { description: 'SB#14 Update concept maturity from tag usage. Cron-friendly.', risk: 'low',
    handler: async (ws) => (await import('./r149-sb-b-tier.js')).conceptMaturityTick(ws) },
  'concept.maturityList':  { description: 'SB#14 List concepts by maturity. Params: maturity? (fresh|growing|mature|archived), limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).conceptMaturityList(ws, { ...(p['maturity'] ? { maturity: String(p['maturity']) } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'knowledge.search':      { description: 'SB#15 Faceted search: tag:X since:DATE until:DATE kind:K -word word. Params: query, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r149-sb-b-tier.js')).knowledgeSearch(ws, String(p['query'] ?? ''), typeof p['limit'] === 'number' ? p['limit'] as number : 30) },

  // ─── R146.150 — SB C-tier (#16-20) — final of next 20 ─────────────
  'mindmap.build':         { description: 'SB#16 Build mind-map data (nodes + edges + degree). Params: tag?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).mindMapBuild(ws, { ...(p['tag'] ? { tag: String(p['tag']) } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'snapshot.capture':      { description: 'SB#17 Capture a memory snapshot for today (chunk/link/tag counts + top chunks).', risk: 'low',
    handler: async (ws) => (await import('./r150-sb-c-tier.js')).snapshotCapture(ws) },
  'snapshot.list':         { description: 'SB#17 List recent memory snapshots. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).snapshotList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 90) },
  'snapshot.diff':         { description: 'SB#17 Diff two snapshots. Params: fromDate (YYYY-MM-DD), toDate?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).snapshotDiff(ws, { fromDate: String(p['fromDate'] ?? ''), ...(p['toDate'] ? { toDate: String(p['toDate']) } : {}) }) },
  'reflective.dialogue':   { description: 'SB#18 Socratic dialogue agent on a topic. Params: topic, rounds?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).reflectiveDialogue(ws, { topic: String(p['topic'] ?? ''), ...(typeof p['rounds'] === 'number' ? { rounds: p['rounds'] as number } : {}) }) },
  'voiceJournal.create':   { description: 'SB#19 Record a voice journal entry (transcribed). Params: transcript, date?, audioPath?, durationSec?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).voiceJournalCreate(ws, { transcript: String(p['transcript'] ?? ''), ...(p['date'] ? { date: String(p['date']) } : {}), ...(p['audioPath'] ? { audioPath: String(p['audioPath']) } : {}), ...(typeof p['durationSec'] === 'number' ? { durationSec: p['durationSec'] as number } : {}) }) },
  'voiceJournal.list':     { description: 'SB#19 List voice journals. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).voiceJournalList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'import.external':       { description: 'SB#20 Import items from external source. Params: source (kindle|readwise|pocket|rss|twitter), sourceRef?, items: [{title,body,url?,tags?}]', risk: 'medium',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).externalImportRun(ws, { source: (p['source'] ?? 'readwise') as 'kindle'|'readwise'|'pocket'|'rss'|'twitter', ...(p['sourceRef'] ? { sourceRef: String(p['sourceRef']) } : {}), items: (p['items'] ?? []) as Array<{ title: string; body: string; url?: string; tags?: string[] }> }) },
  'import.list':           { description: 'SB#20 List external imports. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r150-sb-c-tier.js')).externalImportList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },

  // ─── R146.151 — SB2 S-tier (#1-5) ─────────────────────────────────
  'habit.add':             { description: 'SB2#1 Add a habit. Params: name, cadence? (daily|weekly|weekdays)', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).habitAdd(ws, { name: String(p['name'] ?? ''), ...(p['cadence'] ? { cadence: p['cadence'] as 'daily'|'weekly'|'weekdays' } : {}) }) },
  'habit.log':             { description: 'SB2#1 Log a habit day. Params: habitId, date?, done?, notes?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).habitLog(ws, { habitId: String(p['habitId'] ?? ''), ...(p['date'] ? { date: String(p['date']) } : {}), ...(typeof p['done'] === 'boolean' ? { done: p['done'] as boolean } : {}), ...(p['notes'] ? { notes: String(p['notes']) } : {}) }) },
  'habit.list':            { description: 'SB2#1 List habits.', risk: 'low',
    handler: async (ws) => (await import('./r151-sb2-s-tier.js')).habitList(ws) },
  'habit.broken':          { description: 'SB2#1 List broken streaks (cadence-based).', risk: 'low',
    handler: async (ws) => (await import('./r151-sb2-s-tier.js')).habitBroken(ws) },
  'objective.add':         { description: 'SB2#2 Add an objective. Params: title, quarter (e.g., 2026-Q3)', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).objectiveAdd(ws, { title: String(p['title'] ?? ''), quarter: String(p['quarter'] ?? '') }) },
  'kr.add':                { description: 'SB2#2 Add a key result to an objective. Params: objectiveId, title, targetValue?, unit?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).krAdd(ws, { objectiveId: String(p['objectiveId'] ?? ''), title: String(p['title'] ?? ''), ...(typeof p['targetValue'] === 'number' ? { targetValue: p['targetValue'] as number } : {}), ...(p['unit'] ? { unit: String(p['unit']) } : {}) }) },
  'kr.update':             { description: 'SB2#2 Update KR progress. Params: id, currentValue?, confidence?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).krUpdate(ws, { id: String(p['id'] ?? ''), ...(typeof p['currentValue'] === 'number' ? { currentValue: p['currentValue'] as number } : {}), ...(typeof p['confidence'] === 'number' ? { confidence: p['confidence'] as number } : {}) }) },
  'okr.summary':           { description: 'SB2#2 OKR summary for a quarter. Params: quarter', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).okrSummary(ws, String(p['quarter'] ?? '')) },
  'focus.start':           { description: 'SB2#3 Start a focus session. Params: description, durationMin, tags?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).focusStart(ws, { description: String(p['description'] ?? ''), durationMin: Number(p['durationMin'] ?? 25), ...(Array.isArray(p['tags']) ? { tags: p['tags'] as string[] } : {}) }) },
  'focus.finish':          { description: 'SB2#3 Finish a focus session. Params: id, outputChunkId?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).focusFinish(ws, { id: String(p['id'] ?? ''), ...(p['outputChunkId'] ? { outputChunkId: String(p['outputChunkId']) } : {}) }) },
  'focus.stats':           { description: 'SB2#3 Focus stats over windowDays. Params: windowDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).focusStats(ws, typeof p['windowDays'] === 'number' ? p['windowDays'] as number : 7) },
  'mood.log':              { description: 'SB2#4 Log mood/energy. Params: slot (morning|midday|evening), mood (1-5), energy (1-5), notes?, date?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).moodLog(ws, { slot: (p['slot'] ?? 'morning') as 'morning'|'midday'|'evening', mood: Number(p['mood'] ?? 3), energy: Number(p['energy'] ?? 3), ...(p['notes'] ? { notes: String(p['notes']) } : {}), ...(p['date'] ? { date: String(p['date']) } : {}) }) },
  'mood.trend':            { description: 'SB2#4 Mood + energy trend. Params: days?', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).moodTrend(ws, typeof p['days'] === 'number' ? p['days'] as number : 30) },
  'noteTemplate.seed':     { description: 'SB2#5 Seed starter templates (meeting, retro, 1on1, postmortem, weekly-review).', risk: 'low',
    handler: async (ws) => (await import('./r151-sb2-s-tier.js')).templateSeed(ws) },
  'noteTemplate.use':      { description: 'SB2#5 Render a template into a new memory chunk. Params: name, vars', risk: 'low',
    handler: async (ws, p) => (await import('./r151-sb2-s-tier.js')).templateUse(ws, { name: String(p['name'] ?? ''), vars: (p['vars'] ?? {}) as Record<string, string> }) },
  'noteTemplate.list':     { description: 'SB2#5 List note templates.', risk: 'low',
    handler: async (ws) => (await import('./r151-sb2-s-tier.js')).templateList(ws) },

  // ─── R146.152 — SB2 A-tier (#6-10) ────────────────────────────────
  'digest.subscribe':      { description: 'SB2#6 Subscribe to digest emails. Params: email, cadence? (weekly|monthly)', risk: 'medium',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).digestSubscribe(ws, { email: String(p['email'] ?? ''), ...(p['cadence'] ? { cadence: p['cadence'] as 'weekly'|'monthly' } : {}) }) },
  'digest.build':          { description: 'SB2#6 Build digest payload now (subject + body markdown).', risk: 'low',
    handler: async (ws) => (await import('./r152-sb2-a-tier.js')).digestBuild(ws) },
  'annotation.add':        { description: 'SB2#7 Add an annotation to a chunk. Params: chunkId, body, color?, startOffset?, endOffset?', risk: 'low',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).annotationAdd(ws, { chunkId: String(p['chunkId'] ?? ''), body: String(p['body'] ?? ''), ...(p['color'] ? { color: String(p['color']) } : {}), ...(typeof p['startOffset'] === 'number' ? { startOffset: p['startOffset'] as number } : {}), ...(typeof p['endOffset'] === 'number' ? { endOffset: p['endOffset'] as number } : {}) }) },
  'annotation.forChunk':   { description: 'SB2#7 List annotations on a chunk. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).annotationsForChunk(ws, String(p['chunkId'] ?? '')) },
  'annotation.delete':     { description: 'SB2#7 Delete an annotation. Params: id', risk: 'low',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).annotationDelete(ws, String(p['id'] ?? '')) },
  'chunk.edit':            { description: 'SB2#8 Edit a chunk, snapshot previous to revisions. Params: chunkId, newContent', risk: 'medium',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).chunkEdit(ws, { chunkId: String(p['chunkId'] ?? ''), newContent: String(p['newContent'] ?? '') }) },
  'chunk.revisions':       { description: 'SB2#8 List revisions for a chunk. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).chunkRevisionsList(ws, String(p['chunkId'] ?? '')) },
  'chunk.revert':          { description: 'SB2#8 Revert to a revision. Params: revisionId', risk: 'high',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).chunkRevert(ws, String(p['revisionId'] ?? '')) },
  'confidence.set':        { description: 'SB2#9 Set confidence (0..1) on a chunk. Params: chunkId, confidence, sources?', risk: 'low',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).confidenceSet(ws, { chunkId: String(p['chunkId'] ?? ''), confidence: Number(p['confidence'] ?? 0.7), ...(Array.isArray(p['sources']) ? { sources: p['sources'] as string[] } : {}) }) },
  'confidence.low':        { description: 'SB2#9 Find chunks with confidence < threshold. Params: threshold?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).confidenceLow(ws, typeof p['threshold'] === 'number' ? p['threshold'] as number : 0.4, typeof p['limit'] === 'number' ? p['limit'] as number : 20) },
  'crossref.verify':       { description: 'SB2#10 Search memory for contradictions to a chunk. Params: chunkId', risk: 'medium',
    handler: async (ws, p) => (await import('./r152-sb2-a-tier.js')).crossRefVerify(ws, String(p['chunkId'] ?? '')) },

  // ─── R146.153 — SB2 B-tier (#11-15) ───────────────────────────────
  'links.suggest':         { description: 'SB2#11 Suggest existing chunks to link to from draft text. Params: draftText, k?', risk: 'low',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).linkSuggest(ws, { draftText: String(p['draftText'] ?? ''), ...(typeof p['k'] === 'number' ? { k: p['k'] as number } : {}) }) },
  'tag.rollup':            { description: 'SB2#12 Rolling summary of all chunks under a tag. Params: tag, maxChunks?', risk: 'low',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).tagRollup(ws, { tag: String(p['tag'] ?? ''), ...(typeof p['maxChunks'] === 'number' ? { maxChunks: p['maxChunks'] as number } : {}) }) },
  'gap.inversion':         { description: 'SB2#13 Find adjacent concepts that a tag doesnt link to (blind spots). Params: tag, topAdjacent?', risk: 'low',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).gapInversion(ws, { tag: String(p['tag'] ?? ''), ...(typeof p['topAdjacent'] === 'number' ? { topAdjacent: p['topAdjacent'] as number } : {}) }) },
  'chunk.merge':           { description: 'SB2#14 Merge two chunks; redirects all links. Params: keepId, mergeId, mergedTitle?', risk: 'high',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).chunkMerge(ws, { keepId: String(p['keepId'] ?? ''), mergeId: String(p['mergeId'] ?? ''), ...(p['mergedTitle'] ? { mergedTitle: String(p['mergedTitle']) } : {}) }) },
  'chunk.split':           { description: 'SB2#14 Split a chunk on a marker (default \\n## ). Params: chunkId, splitMarker?', risk: 'medium',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).chunkSplit(ws, { chunkId: String(p['chunkId'] ?? ''), ...(p['splitMarker'] ? { splitMarker: String(p['splitMarker']) } : {}) }) },
  'citations.extract':     { description: 'SB2#15 Extract [cite:<chunkId>] markers and persist as cite-type links. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).citationsExtract(ws, String(p['chunkId'] ?? '')) },
  'citations.forChunk':    { description: 'SB2#15 List citations a chunk makes. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r153-sb2-b-tier.js')).citationsForChunk(ws, String(p['chunkId'] ?? '')) },

  // ─── R146.154 — SB2 C-tier (#16-20) — final ───────────────────────
  'sentiment.timeline':    { description: 'SB2#16 Daily sentiment over N days from recent notes. Surfaces trend shifts. Params: days?', risk: 'low',
    handler: async (ws, p) => (await import('./r154-sb2-c-tier.js')).sentimentTimeline(ws, { ...(typeof p['days'] === 'number' ? { days: p['days'] as number } : {}) }) },
  'devils.advocate':       { description: 'SB2#17 Generate N strong counter-arguments to a conclusion. Params: conclusion, n?', risk: 'low',
    handler: async (ws, p) => (await import('./r154-sb2-c-tier.js')).devilsAdvocate(ws, { conclusion: String(p['conclusion'] ?? ''), ...(typeof p['n'] === 'number' ? { n: p['n'] as number } : {}) }) },
  'advisor.ask':           { description: 'SB2#18 Ask an advisor archetype (munger|jobs|bezos|drucker|graham). Params: archetype, question', risk: 'low',
    handler: async (ws, p) => (await import('./r154-sb2-c-tier.js')).advisorAsk(ws, { archetype: String(p['archetype'] ?? ''), question: String(p['question'] ?? '') }) },
  'advisor.list':          { description: 'SB2#18 List available advisor archetypes.', risk: 'low',
    handler: async () => ({ archetypes: (await import('./r154-sb2-c-tier.js')).advisorList() }) },
  'counterfactual.run':    { description: 'SB2#19 Simulate alternative outcomes for a past decision. Params: decisionId', risk: 'low',
    handler: async (ws, p) => (await import('./r154-sb2-c-tier.js')).counterFactual(ws, { decisionId: String(p['decisionId'] ?? '') }) },
  'concept.lifecycle':     { description: 'SB2#20 Concept lifecycle viz: first seen, peak, current, weekly sparkline. Params: concept', risk: 'low',
    handler: async (ws, p) => (await import('./r154-sb2-c-tier.js')).conceptLifecycle(ws, { concept: String(p['concept'] ?? '') }) },

  // ─── R146.155 — SB3 S-tier (#1-5) ─────────────────────────────────
  'recall.proactive':      { description: 'SB3#1 Surface old memory chunks semantically matching current context (not recently accessed). Params: context, k?, minAgeDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).proactiveRecall(ws, { context: String(p['context'] ?? ''), ...(typeof p['k'] === 'number' ? { k: p['k'] as number } : {}), ...(typeof p['minAgeDays'] === 'number' ? { minAgeDays: p['minAgeDays'] as number } : {}) }) },
  'question.raise':        { description: 'SB3#2 Log an open question. Params: question, contextChunkId?, priority? (0|1|2)', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).questionRaise(ws, { question: String(p['question'] ?? ''), ...(p['contextChunkId'] ? { contextChunkId: String(p['contextChunkId']) } : {}), ...(typeof p['priority'] === 'number' ? { priority: p['priority'] as 0|1|2 } : {}) }) },
  'question.answer':       { description: 'SB3#2 Mark a question answered. Params: id, answerChunkId?', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).questionAnswer(ws, { id: String(p['id'] ?? ''), ...(p['answerChunkId'] ? { answerChunkId: String(p['answerChunkId']) } : {}) }) },
  'question.drop':         { description: 'SB3#2 Drop a question. Params: id', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).questionDrop(ws, String(p['id'] ?? '')) },
  'question.backlog':      { description: 'SB3#2 List open questions. Params: minPriority?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).questionBacklog(ws, { ...(typeof p['minPriority'] === 'number' ? { minPriority: p['minPriority'] as number } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'note.continue':         { description: 'SB3#3 Continue a draft in operator voice. Params: draftStart, maxTokens?', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).noteContinue(ws, { draftStart: String(p['draftStart'] ?? ''), ...(typeof p['maxTokens'] === 'number' ? { maxTokens: p['maxTokens'] as number } : {}) }) },
  'goal.decompose':        { description: 'SB3#4 Decompose an objective + KRs into daily actions. Params: objectiveId, horizonDays?, tasksPerDay?', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).goalDecompose(ws, { objectiveId: String(p['objectiveId'] ?? ''), ...(typeof p['horizonDays'] === 'number' ? { horizonDays: p['horizonDays'] as number } : {}), ...(typeof p['tasksPerDay'] === 'number' ? { tasksPerDay: p['tasksPerDay'] as number } : {}) }) },
  'habit.outcomeCorr':     { description: 'SB3#5 Pearson correlation of habit done vs next-day mood/energy. Params: habitId, outcome? (mood|energy), windowDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r155-sb3-s-tier.js')).habitOutcomeCorr(ws, { habitId: String(p['habitId'] ?? ''), ...(p['outcome'] ? { outcome: p['outcome'] as 'mood'|'energy' } : {}), ...(typeof p['windowDays'] === 'number' ? { windowDays: p['windowDays'] as number } : {}) }) },

  // ─── R146.156 — SB3 A-tier (#6-10) ────────────────────────────────
  'yearly.generate':       { description: 'SB3#6 Generate a yearly review synthesis from weekly reviews + chunks. Params: year', risk: 'low',
    handler: async (ws, p) => (await import('./r156-sb3-a-tier.js')).yearlyReviewGenerate(ws, Number(p['year'] ?? new Date().getUTCFullYear())) },
  'identity.timeline':     { description: 'SB3#7 Identity statements (I am / I value / I believe) over time. Params: windowDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r156-sb3-a-tier.js')).identityTimeline(ws, { ...(typeof p['windowDays'] === 'number' ? { windowDays: p['windowDays'] as number } : {}) }) },
  'calibration.trend':     { description: 'SB3#8 Monthly avg calibration score over windowMonths. Params: windowMonths?', risk: 'low',
    handler: async (ws, p) => (await import('./r156-sb3-a-tier.js')).calibrationTrend(ws, { ...(typeof p['windowMonths'] === 'number' ? { windowMonths: p['windowMonths'] as number } : {}) }) },
  'belief.shifts':         { description: 'SB3#9 Find chunks containing belief-change language. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r156-sb3-a-tier.js')).beliefShifts(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30) },
  'resonance.top':         { description: 'SB3#10 Most-referenced ideas by later chunks (resonance = later-links * sqrt(age/30)). Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r156-sb3-a-tier.js')).resonanceTop(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 20) },

  // ─── R146.157 — SB3 B-tier (#11-15) ───────────────────────────────
  'inline.rewrite':        { description: 'SB3#11 Rewrite text in a style (concise|honest|formal|specific|gentle|punchy|plain). Params: text, style, keepLength?', risk: 'low',
    handler: async (ws, p) => (await import('./r157-sb3-b-tier.js')).inlineRewrite(ws, { text: String(p['text'] ?? ''), style: (p['style'] ?? 'concise') as 'concise'|'honest'|'formal'|'specific'|'gentle'|'punchy'|'plain', ...(p['keepLength'] === true ? { keepLength: true } : {}) }) },
  'tone.check':            { description: 'SB3#12 Score tone drift vs baseline of recent notes. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r157-sb3-b-tier.js')).toneCheck(ws, { chunkId: String(p['chunkId'] ?? '') }) },
  'bibliography.for':      { description: 'SB3#13 Build bibliography of outgoing links from a chunk. Params: chunkId', risk: 'low',
    handler: async (ws, p) => (await import('./r157-sb3-b-tier.js')).bibliographyFor(ws, String(p['chunkId'] ?? '')) },
  'note.borrowStructure':  { description: 'SB3#14 Create new chunk with the skeleton (headings + bullets) of an existing one. Params: fromChunkId, newTitle?', risk: 'low',
    handler: async (ws, p) => (await import('./r157-sb3-b-tier.js')).noteBorrowStructure(ws, { fromChunkId: String(p['fromChunkId'] ?? ''), ...(p['newTitle'] ? { newTitle: String(p['newTitle']) } : {}) }) },
  'bulk.retag':            { description: 'SB3#15 Add/remove tags on chunks matching a search query. dryRun defaults TRUE. Params: query, addTags?, removeTags?, dryRun?', risk: 'high',
    handler: async (ws, p) => (await import('./r157-sb3-b-tier.js')).bulkRetag(ws, { query: String(p['query'] ?? ''), ...(Array.isArray(p['addTags']) ? { addTags: p['addTags'] as string[] } : {}), ...(Array.isArray(p['removeTags']) ? { removeTags: p['removeTags'] as string[] } : {}), ...(p['dryRun'] === false ? { dryRun: false } : {}) }) },
  'bulk.delete':            { description: 'SB3#15 Delete chunks matching a search query. Requires confirm: "DELETE" to actually delete. Params: query, confirm', risk: 'critical',
    handler: async (ws, p) => (await import('./r157-sb3-b-tier.js')).bulkDelete(ws, { query: String(p['query'] ?? ''), confirm: String(p['confirm'] ?? '') }) },

  // ─── R146.158 — SB3 C-tier (#16-20) — final ───────────────────────
  'pastSelves.dialogue':   { description: 'SB3#16 Generate dialogue between oldest + newest chunks on a topic. Params: topic', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).pastSelvesDialogue(ws, { topic: String(p['topic'] ?? '') }) },
  'dream.capture':         { description: 'SB3#17 Capture a dream entry with LLM theme extraction. Params: body, vivid?, date?', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).dreamCapture(ws, { body: String(p['body'] ?? ''), ...(p['vivid'] === true ? { vivid: true } : {}), ...(p['date'] ? { date: String(p['date']) } : {}) }) },
  'dream.themes':          { description: 'SB3#17 Theme trends across recent dreams. Params: windowDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).dreamThemeTrends(ws, typeof p['windowDays'] === 'number' ? p['windowDays'] as number : 90) },
  'body.log':              { description: 'SB3#18 Log a body metric. Params: metric (sleep_min|hrv|steps|weight_kg|rhr|workout_min), value, date?, source?', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).bodyMetricLog(ws, { metric: String(p['metric'] ?? ''), value: Number(p['value'] ?? 0), ...(p['date'] ? { date: String(p['date']) } : {}), ...(p['source'] ? { source: String(p['source']) } : {}) }) },
  'body.correlate':        { description: 'SB3#18 Correlate body metric with mood/energy/focus. Params: metric, outcome (mood|energy|focus_min), windowDays?', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).bodyMetricCorr(ws, { metric: String(p['metric'] ?? ''), outcome: (p['outcome'] ?? 'mood') as 'mood'|'energy'|'focus_min', ...(typeof p['windowDays'] === 'number' ? { windowDays: p['windowDays'] as number } : {}) }) },
  'garden.publish':        { description: 'SB3#19 Publish a chunk to a public URL slug. Params: chunkId, customSlug?', risk: 'high',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).publish(ws, { chunkId: String(p['chunkId'] ?? ''), ...(p['customSlug'] ? { customSlug: String(p['customSlug']) } : {}) }) },
  'garden.unpublish':      { description: 'SB3#19 Unpublish. Params: id', risk: 'medium',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).unpublish(ws, String(p['id'] ?? '')) },
  'garden.list':           { description: 'SB3#19 List published items. Params: activeOnly?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).publicList(ws, { ...(p['activeOnly'] === true ? { activeOnly: true } : {}), ...(typeof p['limit'] === 'number' ? { limit: p['limit'] as number } : {}) }) },
  'inheritance.generate':  { description: 'SB3#20 Generate a successor manifest. Params: recipientHint (self_future|spouse|cofounder|...)', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).inheritanceGenerate(ws, { recipientHint: String(p['recipientHint'] ?? 'self_future') }) },
  'inheritance.list':      { description: 'SB3#20 List generated inheritance manifests. Params: limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r158-sb3-c-tier.js')).inheritanceList(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 10) },

  'autonomy.counts':       { description: 'Live counts for autonomy dashboard: findings(open) · improvements(open) · ops(in_process/on_deck) · proposals(proposed/approved) · connectorsNeedingRefresh · agentsLive.', risk: 'low',
    handler: async (ws) => (await import('./r124-autonomy.js')).autonomyCounts(ws) },
  'suggestions.scan':      { description: 'Scan last 24h of error events and create improvement_suggestions for recurring patterns (≥3 occurrences). Powers Ali queue.', risk: 'low',
    handler: async (ws) => (await import('./r124-autonomy.js')).suggestionsProducerTick(ws) },
  'oauth.refreshAll':      { description: 'Pre-refresh every active connector OAuth token within 30 min of expiry. Returns refreshed/checked/skipped counts.', risk: 'medium',
    handler: async () => (await import('./r124-autonomy.js')).oauthRefreshTick() },
  'patches.exportDiff':    { description: 'Export a code_patches row as a git apply-compatible unified diff. Params: patchId', risk: 'low',
    handler: async (ws, p) => (await import('./r124-autonomy.js')).exportPatchDiff(ws, String(p['patchId'] ?? '')) },
  'patches.exportForProposal': { description: 'Export the latest patch for a proposal as a unified diff. Params: proposalId', risk: 'low',
    handler: async (ws, p) => (await import('./r124-autonomy.js')).exportLatestPatchDiffForProposal(ws, String(p['proposalId'] ?? '')) },
  'improvements.create':   { description: 'Record an improvement suggestion (manual entry). r117 bridge will route it onto the agent_ops_board. Params: title, body?, priority?, category?', risk: 'low',
    handler: async (ws, p) => {
      const { db } = await import('../db/client.js')
      const { v7: uuidv7 } = await import('uuid')
      const { sql } = await import('drizzle-orm')
      const id = uuidv7(); const now = Date.now()
      await db.execute(sql`
        INSERT INTO improvement_suggestions (id, workspace_id, title, body, category, priority, status, source, created_at, updated_at)
        VALUES (${id}, ${ws}, ${String(p['title'] ?? 'untitled')}, ${String(p['body'] ?? '')}, ${String(p['category'] ?? 'misc')}, ${String(p['priority'] ?? 'medium')}, 'open', 'operator', ${now}, ${now})
      `)
      return { ok: true, id }
    } },

  // ─── R146.117 — wiring fixes (findings→ops bridge, agent dispatch, IG userId, oauth refresh) ─
  'security.bridgeNow':    { description: 'Bridge open high/critical security findings onto the agent_ops_board (owner: Sam). Dedups via securityFindings.mitigationTaskId.', risk: 'low',
    handler: async (ws, p) => (await import('./r117-wiring-fixes.js')).findingsToOpsBridge(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 10) },
  'improvements.bridgeNow':{ description: 'Bridge improvement_suggestions onto the agent_ops_board (owner: Ali). Best-effort if table missing.', risk: 'low',
    handler: async (ws, p) => (await import('./r117-wiring-fixes.js')).improvementsToOpsBridge(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 5) },
  'agents.dispatchTick':   { description: 'Reflect ops_board state in agent_roster: status=live + currentTask for in_process owners; else preview the next on_deck.', risk: 'low',
    handler: async (ws) => (await import('./r117-wiring-fixes.js')).agentDispatcherTick(ws) },
  'agents.bridgeAll':      { description: 'Run security + improvements bridge + dispatcher in one tick (same op the cron runs).', risk: 'low',
    handler: async (ws) => (await import('./r117-wiring-fixes.js')).findingsBridgeTick(ws) },
  'instagram.ensureUserId':{ description: 'Fetch igUserId from Meta /me and stamp connectorAccounts.metadata. Params: connectorAccountId', risk: 'low',
    handler: async (_ws, p) => (await import('./r117-wiring-fixes.js')).ensureIgUserId(String(p['connectorAccountId'] ?? '')) },
  'oauth.refreshIfNeeded': { description: 'Refresh a connector OAuth token if within 5min of expiry. Returns the (possibly refreshed) access token. Params: connectorAccountId', risk: 'medium',
    handler: async (_ws, p) => ({ token: await (await import('./r117-wiring-fixes.js')).refreshIfNeeded(String(p['connectorAccountId'] ?? '')) }) },

  // ─── R146.115 — Build batch: War Room + shortform + viral + launch + ChatGPT ─
  'agents.seedDefaults':   { description: 'Seed the chriswesst-style 7-agent roster (Scan/Owl/Quilly/Larry/Ali/Sam/Cleo).', risk: 'low',
    handler: async (ws) => (await import('./r115-build-batch.js')).agentSeedDefaults(ws) },
  'agents.list':           { description: 'List the agent roster (War Room top row).', risk: 'low',
    handler: async (ws) => (await import('./r115-build-batch.js')).listAgents(ws) },
  'agents.setStatus':      { description: 'Update an agent. Params: shortName, status?, currentTask?', risk: 'low',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).setAgentStatus(ws, String(p['shortName'] ?? ''), { ...(p['status'] ? { status: p['status'] as 'idle' | 'live' | 'offline' } : {}), ...(p['currentTask'] !== undefined ? { currentTask: p['currentTask'] ? String(p['currentTask']) : null } : {}) }) },
  'agents.opsBoard':       { description: 'Read the Kanban ops board (on_deck / in_process / completed).', risk: 'low',
    handler: async (ws) => (await import('./r115-build-batch.js')).listOpsBoard(ws) },
  'agents.opsAdd':         { description: 'Add a task. Params: title, ownerAgentId?, column?, notes?', risk: 'low',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).addOpsTask(ws, { title: String(p['title'] ?? ''), ...(p['ownerAgentId'] ? { ownerAgentId: String(p['ownerAgentId']) } : {}), ...(p['column'] ? { column: p['column'] as 'on_deck' | 'in_process' | 'completed' } : {}), ...(p['notes'] ? { notes: String(p['notes']) } : {}) }) },
  'agents.opsMove':        { description: 'Move a task between columns. Params: taskId, toColumn', risk: 'low',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).moveOpsTask(ws, String(p['taskId'] ?? ''), (p['toColumn'] as 'on_deck' | 'in_process' | 'completed') ?? 'in_process') },

  'shortform.createPipeline': { description: 'Create a YouTube → viral shorts pipeline. Params: sourceUrl, sourceTitle?, targetAccounts?', risk: 'medium',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).createShortformPipeline({ workspaceId: ws, sourceUrl: String(p['sourceUrl'] ?? ''), ...(p['sourceTitle'] ? { sourceTitle: String(p['sourceTitle']) } : {}), ...(Array.isArray(p['targetAccounts']) ? { targetAccounts: p['targetAccounts'] as Array<{ platform: 'tiktok' | 'instagram' | 'youtube' | 'facebook'; handle: string }> } : {}) }) },
  'shortform.learnChannelStyle': { description: 'Generate a style profile from a YouTube channel URL. Used so the editing team matches the source style.', risk: 'low',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).learnChannelStyle(ws, String(p['channelUrl'] ?? '')) },
  'shortform.listChannelVideos': { description: 'List latest videos from a channel. Params: channelUrl, limit?', risk: 'low',
    handler: async (_ws, p) => (await import('./r115-build-batch.js')).listChannelVideos(String(p['channelUrl'] ?? ''), typeof p['limit'] === 'number' ? p['limit'] as number : 10) },
  'shortform.autoClip':    { description: 'Cut one video into N viral clips. Params: pipelineId, sourceVideoUrl, sourceTitle?, targetClipCount?', risk: 'high',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).autoClipVideo({ workspaceId: ws, pipelineId: String(p['pipelineId'] ?? ''), sourceVideoUrl: String(p['sourceVideoUrl'] ?? ''), ...(p['sourceTitle'] ? { sourceTitle: String(p['sourceTitle']) } : {}), ...(typeof p['targetClipCount'] === 'number' ? { targetClipCount: p['targetClipCount'] as number } : {}) }) },
  'shortform.cronNow':     { description: 'Run the shortform cron tick now: check every pipeline, clip new videos.', risk: 'high',
    handler: async (ws) => (await import('./r115-build-batch.js')).shortformCronTick(ws) },

  'viralStyle.generate':   { description: 'Drop a social URL → get N posts in that account\'s style. Params: sourceUrl, count?, voiceHint?', risk: 'medium',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).generateViralStyleScripts({ workspaceId: ws, sourceUrl: String(p['sourceUrl'] ?? ''), ...(typeof p['count'] === 'number' ? { count: p['count'] as number } : {}), ...(p['voiceHint'] ? { voiceHint: String(p['voiceHint']) } : {}) }) },
  'viralStyle.list':       { description: 'List generated scripts. Params: sourceUrl?, limit?', risk: 'low',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).listViralScripts(ws, p['sourceUrl'] ? String(p['sourceUrl']) : undefined, typeof p['limit'] === 'number' ? p['limit'] as number : 50) },

  'launch.start':          { description: 'Start a $1M brand launch flow. Params: ideaSeed, businessId?', risk: 'medium',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).startBusinessLaunch({ workspaceId: ws, ideaSeed: String(p['ideaSeed'] ?? ''), ...(p['businessId'] ? { businessId: String(p['businessId']) } : {}) }) },
  'launch.advance':        { description: 'Move a launch to its next stage (validation → brand → mockups → landing → waitlist → content → shipped). Params: launchId', risk: 'medium',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).advanceBusinessLaunch(ws, String(p['launchId'] ?? '')) },
  'launch.get':            { description: 'Read a launch row. Params: launchId', risk: 'low',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).getLaunch(ws, String(p['launchId'] ?? '')) },
  'launch.list':           { description: 'List active launches.', risk: 'low',
    handler: async (ws) => (await import('./r115-build-batch.js')).listLaunches(ws) },

  'chatgpt.import':        { description: 'Import an OpenAI export ZIP or conversations.json → extract business ideas. Params: filePath', risk: 'medium',
    handler: async (ws, p) => (await import('./r115-build-batch.js')).importChatgptExport({ workspaceId: ws, filePath: String(p['filePath'] ?? '') }) },
  'chatgpt.listIdeas':     { description: 'List business ideas extracted from ChatGPT exports, ranked by feasibility.', risk: 'low',
    handler: async (ws) => (await import('./r115-build-batch.js')).listExtractedIdeas(ws) },

  // ─── R146.114 — Second Brain (cryptocita /raw → /wiki pipeline) ──────
  'secondBrain.drop': {
    description: 'Drop a source (URL/video/text) into the /raw inbox. Compiled into wiki articles on the next ingest. Params: source (url|video|text|file), url?, title?, content?, tagsHint?',
    risk: 'low',
    handler: async (ws, p) => (await import('./second-brain.js')).dropSource({
      workspaceId: ws,
      source:      (p['source'] as 'url' | 'video' | 'text' | 'file') ?? 'text',
      ...(p['url']      ? { url:      String(p['url']) }      : {}),
      ...(p['title']    ? { title:    String(p['title']) }    : {}),
      ...(p['content']  ? { content:  String(p['content']) }  : {}),
      ...(p['tagsHint'] ? { tagsHint: String(p['tagsHint']) } : {}),
    }),
  },
  'secondBrain.compileNow': {
    description: 'Run the compile step on all queued /raw items now (bypasses cron). Returns counts.',
    risk: 'medium',
    handler: async (ws, p) => (await import('./second-brain.js')).dailyIngest(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 30),
  },
  'secondBrain.compileOne': {
    description: 'Compile one specific raw row by id. Params: rawId',
    risk: 'medium',
    handler: async (ws, p) => (await import('./second-brain.js')).compileRaw(ws, String(p['rawId'] ?? '')),
  },
  'secondBrain.review': {
    description: 'Run the daily review now: snapshot of what changed in the last 24h.',
    risk: 'low',
    handler: async (ws) => (await import('./second-brain.js')).dailyReview(ws),
  },
  'secondBrain.audit': {
    description: 'Run the weekly audit now: surfaces gaps, broken cross-links, thin topics.',
    risk: 'low',
    handler: async (ws) => (await import('./second-brain.js')).weeklyAudit(ws),
  },
  'secondBrain.listArticles': {
    description: 'List wiki articles. Params: topic?, limit?',
    risk: 'low',
    handler: async (ws, p) => (await import('./second-brain.js')).listArticles(ws, p['topic'] ? String(p['topic']) : undefined, typeof p['limit'] === 'number' ? p['limit'] as number : 50),
  },
  'secondBrain.listTopics': {
    description: 'List topics with article counts.',
    risk: 'low',
    handler: async (ws) => (await import('./second-brain.js')).listTopics(ws),
  },
  'secondBrain.stats': {
    description: 'Counts + last review timestamp for the second brain.',
    risk: 'low',
    handler: async (ws) => (await import('./second-brain.js')).stats(ws),
  },
  'secondBrain.getRules': {
    description: 'Read the CLAUDE.md-style librarian rules.',
    risk: 'low',
    handler: async (ws) => (await import('./second-brain.js')).getConfig(ws),
  },
  'secondBrain.setRules': {
    description: 'Update the CLAUDE.md librarian rules + cron times. Params: rulesMd?, dailyIngestHour?, dailyReviewHour?, weeklyAuditDay?, weeklyAuditHour?, enabled?',
    risk: 'medium',
    handler: async (ws, p) => {
      await (await import('./second-brain.js')).setConfig(ws, {
        ...(typeof p['rulesMd']         === 'string'  ? { rulesMd:         p['rulesMd']         as string  } : {}),
        ...(typeof p['dailyIngestHour'] === 'number'  ? { dailyIngestHour: p['dailyIngestHour'] as number  } : {}),
        ...(typeof p['dailyReviewHour'] === 'number'  ? { dailyReviewHour: p['dailyReviewHour'] as number  } : {}),
        ...(typeof p['weeklyAuditDay']  === 'number'  ? { weeklyAuditDay:  p['weeklyAuditDay']  as number  } : {}),
        ...(typeof p['weeklyAuditHour'] === 'number'  ? { weeklyAuditHour: p['weeklyAuditHour'] as number  } : {}),
        ...(typeof p['enabled']         === 'boolean' ? { enabled:         p['enabled']         as boolean } : {}),
      })
      return { ok: true }
    },
  },
  // ─── R146.109 — Chat human personality voice ──────────────────────────
  'chat.getVoice': {
    description: 'Inspect current Novan chat voice (warmth/wit/directness/brevity/curiosity/opinionatedness 0..1, plus preset name).',
    risk: 'low',
    handler: async () => {
      const { envVoice, describePersonality } = await import('./chat-personality.js')
      return describePersonality(envVoice())
    },
  },
  'chat.setVoice': {
    description: 'Tune chat voice at runtime (env override). Params: enabled?, warmth?, wit?, directness?, brevity?, curiosity?, opinionatedness?, nickname? (all 0..1 except nickname). preset="max" or "default" applies a bundle.',
    risk: 'medium',
    handler: async (_ws, p) => {
      const set = (key: string, val: unknown) => {
        if (val === undefined || val === null) return
        if (typeof val === 'number' && Number.isFinite(val)) process.env[key] = String(Math.max(0, Math.min(1, val)))
        else if (typeof val === 'boolean') process.env[key] = val ? '1' : '0'
        else process.env[key] = String(val)
      }
      if (p['preset'] === 'max') process.env['NOVAN_VOICE'] = 'max'
      else if (p['preset'] === 'default') process.env['NOVAN_VOICE'] = '1'
      else if (typeof p['enabled'] === 'boolean') process.env['NOVAN_VOICE'] = p['enabled'] ? '1' : '0'
      set('NOVAN_VOICE_WARMTH',          p['warmth'])
      set('NOVAN_VOICE_WIT',             p['wit'])
      set('NOVAN_VOICE_DIRECTNESS',      p['directness'])
      set('NOVAN_VOICE_BREVITY',         p['brevity'])
      set('NOVAN_VOICE_CURIOSITY',       p['curiosity'])
      set('NOVAN_VOICE_OPINIONATEDNESS', p['opinionatedness'])
      if (p['nickname']) process.env['NOVAN_VOICE_NICKNAME'] = String(p['nickname'])
      const { envVoice, describePersonality } = await import('./chat-personality.js')
      return describePersonality(envVoice())
    },
  },
  // ─── R146.108 — Consumers + dedup + budget guard + empirical bench ────
  'frontier.consumerTick': {
    description: 'Run one consumer cycle: backfill embeddings, dedup capability names, write prototype + advancement specs to /data/intel/*.md, run one empirical capability benchmark.',
    risk: 'medium',
    handler: async (ws) => (await import('./frontier-consumers.js')).consumerTick(ws),
  },
  'frontier.dedupCapabilities': {
    description: 'Merge duplicate capability rows by canonical name (handles RAG↔retrieval-augmented-generation etc).',
    risk: 'medium',
    handler: async (ws) => (await import('./frontier-consumers.js')).dedupCapabilities(ws),
  },
  'frontier.backfillEmbeddings': {
    description: 'Fill missing embedding columns on frontier_findings. Params: limit?',
    risk: 'low',
    handler: async (ws, p) => (await import('./frontier-consumers.js')).backfillFindingEmbeddings(ws, typeof p['limit'] === 'number' ? p['limit'] as number : 20),
  },
  'frontier.benchCapability': {
    description: 'Empirically score one image-gen/video-gen capability via a real probe call. Rotates by oldest lastAdvancedAt.',
    risk: 'medium',
    handler: async (ws) => (await import('./frontier-consumers.js')).empiricallyScoreCapabilities(ws),
  },
  'frontier.budgetCheck': {
    description: 'Check whether frontier loop can spend ~$amount more this period. Params: amountUsd?',
    risk: 'low',
    handler: async (ws, p) => (await import('./frontier-consumers.js')).frontierBudgetAllowed(ws, typeof p['amountUsd'] === 'number' ? p['amountUsd'] as number : 1.0),
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

  // ─── R146.160 — PAI 7-phase loop for video gen ─────────────────────
  'video.pai.isaCreate': {
    description: 'Create a video Ideal State Artifact (brief + ISCs). Params: title, brief, target?, telos?, iscs?',
    risk: 'low',
    handler: async (ws, params) => {
      const { isaCreate } = await import('./r160-pai-video-loop.js')
      return isaCreate(ws, params as unknown as Parameters<typeof isaCreate>[1])
    },
  },
  'video.pai.isaList': {
    description: 'List ISAs for this workspace. Params: { limit?, status? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { isaList } = await import('./r160-pai-video-loop.js')
      return isaList(ws, (params as Parameters<typeof isaList>[1]) ?? {})
    },
  },
  'video.pai.run': {
    description: 'Run the OBSERVE→VERIFY phases for an ISA. Params: { isaId }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { paiRun } = await import('./r160-pai-video-loop.js')
      return paiRun(ws, params as Parameters<typeof paiRun>[1])
    },
  },
  'video.pai.recordOutcome': {
    description: 'LEARN phase. Feed real performance back. Params: { runId, score (0..1), meta? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { paiRecordOutcome } = await import('./r160-pai-video-loop.js')
      const p = params as { runId: string; score: number; meta?: Record<string, unknown> }
      return paiRecordOutcome(ws, p.runId, p.score, p.meta ?? {})
    },
  },
  'video.pai.listRuns': {
    description: 'List recent PAI runs. Params: { isaId?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { paiListRuns } = await import('./r160-pai-video-loop.js')
      return paiListRuns(ws, (params as Parameters<typeof paiListRuns>[1]) ?? {})
    },
  },
  'video.pai.lessons': {
    description: 'List cross-run lessons. Params: { topic?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { paiLessons } = await import('./r160-pai-video-loop.js')
      return paiLessons(ws, (params as Parameters<typeof paiLessons>[1]) ?? {})
    },
  },

  // ─── R146.161 — Social comment harvest + self-improvement ──────────
  'social.comments.harvest': {
    description: 'Fan out to every active social account, fetch new comments.',
    risk: 'low',
    handler: async (ws) => {
      const { commentsHarvest } = await import('./r161-social-comments.js')
      return commentsHarvest(ws)
    },
  },
  'social.comments.analyze': {
    description: 'Re-roll up themes from the last N days. Params: { windowDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { commentsAnalyze } = await import('./r161-social-comments.js')
      return commentsAnalyze(ws, (params as { windowDays?: number })?.windowDays)
    },
  },
  'social.comments.selfImprove': {
    description: 'Mint PAI lessons from audience themes (loves/dislikes/requests).',
    risk: 'low',
    handler: async (ws) => {
      const { commentsSelfImprove } = await import('./r161-social-comments.js')
      return commentsSelfImprove(ws)
    },
  },
  'social.comments.list': {
    description: 'List comments. Params: { intent?, sentiment?, limit?, unrepliedOnly? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { commentsList } = await import('./r161-social-comments.js')
      return commentsList(ws, (params as Parameters<typeof commentsList>[1]) ?? {})
    },
  },
  'social.comments.themes': {
    description: 'Top themes across the comment corpus. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { themesTop } = await import('./r161-social-comments.js')
      return themesTop(ws, (params as { limit?: number })?.limit)
    },
  },
  'social.reply.draft': {
    description: 'Draft a reply for one comment. Params: { commentId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { replyDraftCreate } = await import('./r161-social-comments.js')
      return replyDraftCreate(ws, (params as { commentId: string }).commentId)
    },
  },
  'social.reply.autoDraft': {
    description: 'Auto-draft replies for top-N high-priority unanswered comments. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { autoDraftBacklog } = await import('./r161-social-comments.js')
      return autoDraftBacklog(ws, (params as { limit?: number })?.limit ?? 10)
    },
  },
  'social.reply.approve': {
    description: 'Approve a draft. Params: { draftId, approvedBy }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { replyDraftApprove } = await import('./r161-social-comments.js')
      const p = params as { draftId: string; approvedBy?: string }
      return replyDraftApprove(ws, p.draftId, p.approvedBy ?? 'operator')
    },
  },
  'social.reply.send': {
    description: 'Send an approved draft to the platform. Params: { draftId }',
    risk: 'high',
    handler: async (ws, params) => {
      const { replyDraftSend } = await import('./r161-social-comments.js')
      return replyDraftSend(ws, (params as { draftId: string }).draftId)
    },
  },

  // ─── R146.162 — Owned-audience loop ────────────────────────────────
  'magnet.create': {
    description: 'Create a lead magnet. Params: { title, body, slug?, format?, fileUrl?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { magnetCreate } = await import('./r162-owned-audience.js')
      return magnetCreate(ws, params as unknown as Parameters<typeof magnetCreate>[1])
    },
  },
  'magnet.draftFromBrain': {
    description: 'Auto-write a magnet from brain knowledge. Params: { topic, format?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { magnetDraftFromBrain } = await import('./r162-owned-audience.js')
      return magnetDraftFromBrain(ws, params as { topic: string; format?: 'pdf' | 'checklist' | 'template' | 'swipe' | 'course'; businessId?: string })
    },
  },
  'magnet.list': {
    description: 'List active magnets.',
    risk: 'low',
    handler: async (ws, params) => {
      const { magnetList } = await import('./r162-owned-audience.js')
      return magnetList(ws, (params as { limit?: number }) ?? {})
    },
  },
  'list.capture': {
    description: 'Add an email to the workspace list. Params: { email, name?, magnetId?, source?, sourceRef? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { captureCreate } = await import('./r162-owned-audience.js')
      return captureCreate(ws, params as unknown as Parameters<typeof captureCreate>[1])
    },
  },
  'list.unsubscribe': {
    description: 'Unsubscribe an email. Params: { email }',
    risk: 'low',
    handler: async (ws, params) => {
      const { captureUnsubscribe } = await import('./r162-owned-audience.js')
      return captureUnsubscribe(ws, (params as { email: string }).email)
    },
  },
  'list.segmentSync': {
    description: 'Recompute behavior segments across the list.',
    risk: 'low',
    handler: async (ws) => {
      const { segmentSync } = await import('./r162-owned-audience.js')
      return segmentSync(ws)
    },
  },
  'list.stats': {
    description: 'List size + segment breakdown for dashboards.',
    risk: 'low',
    handler: async (ws) => {
      const { listStats } = await import('./r162-owned-audience.js')
      return listStats(ws)
    },
  },
  'list.captures': {
    description: 'List captures. Params: { segment?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { listCaptures } = await import('./r162-owned-audience.js')
      return listCaptures(ws, (params as Parameters<typeof listCaptures>[1]) ?? {})
    },
  },
  'email.campaignCreate': {
    description: 'Draft a campaign. Params: { name, subjectA, subjectB?, body, segmentFilter?, fromAddress, fromName?, replyTo?, scheduledAt? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { campaignCreate } = await import('./r162-owned-audience.js')
      return campaignCreate(ws, params as unknown as Parameters<typeof campaignCreate>[1])
    },
  },
  'email.campaignSend': {
    description: 'Send a campaign now. Requires resend_api_key in vault + fromAddress on campaign. Params: { campaignId }',
    risk: 'high',
    handler: async (ws, params) => {
      const { campaignSendNow } = await import('./r162-owned-audience.js')
      return campaignSendNow(ws, (params as { campaignId: string }).campaignId)
    },
  },
  'email.campaigns': {
    description: 'List campaigns. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { listCampaigns } = await import('./r162-owned-audience.js')
      return listCampaigns(ws, (params as Parameters<typeof listCampaigns>[1]) ?? {})
    },
  },
  'list.winBack': {
    description: 'Detect dormant subscribers and auto-draft a win-back campaign.',
    risk: 'low',
    handler: async (ws) => {
      const { winBackTick } = await import('./r162-owned-audience.js')
      return winBackTick(ws)
    },
  },

  // ─── R146.163 — Volume engines ─────────────────────────────────────
  'repurpose.create': {
    description: 'Splits a long source into N variants per format. Params: { sourceBody, title?, businessId?, formats?, perFormat? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { repurposeCreate } = await import('./r163-volume-engines.js')
      return repurposeCreate(ws, params as unknown as Parameters<typeof repurposeCreate>[1])
    },
  },
  'repurpose.packs': {
    description: 'List repurpose packs.',
    risk: 'low',
    handler: async (ws, params) => {
      const { repurposeListPacks } = await import('./r163-volume-engines.js')
      return repurposeListPacks(ws, (params as { limit?: number }) ?? {})
    },
  },
  'repurpose.variants': {
    description: 'List variants. Params: { packId?, format?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { repurposeVariants } = await import('./r163-volume-engines.js')
      return repurposeVariants(ws, (params as Parameters<typeof repurposeVariants>[1]) ?? {})
    },
  },
  'trend.toDraft': {
    description: 'Turn a trend_findings row into a repurpose pack. Params: { trendId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { trendToDraft } = await import('./r163-volume-engines.js')
      return trendToDraft(ws, (params as { trendId: string }).trendId)
    },
  },
  'trend.listFresh': {
    description: 'List recent trends. Params: { sinceHours?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { trendListFresh } = await import('./r163-volume-engines.js')
      return trendListFresh(ws, (params as Parameters<typeof trendListFresh>[1]) ?? {})
    },
  },
  'competitor.watch': {
    description: 'Track a competitor handle for content gap analysis. Params: { platform, handle, niche?, notes?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { competitorAdd } = await import('./r163-volume-engines.js')
      return competitorAdd(ws, params as unknown as Parameters<typeof competitorAdd>[1])
    },
  },
  'competitor.watchList': {
    description: 'List watched competitor handles. Params: { businessId?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { competitorList } = await import('./r163-volume-engines.js')
      return competitorList(ws, (params as Parameters<typeof competitorList>[1]) ?? {})
    },
  },
  'competitor.recordWinner': {
    description: 'Log a winning competitor post. Params: { competitorId, body, externalId?, metricScore?, theme? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { competitorRecordWinner } = await import('./r163-volume-engines.js')
      return competitorRecordWinner(ws, params as unknown as Parameters<typeof competitorRecordWinner>[1])
    },
  },
  'competitor.gaps': {
    description: 'Identify themes competitors hit that we miss; mint PAI lessons.',
    risk: 'low',
    handler: async (ws) => {
      const { competitorGaps } = await import('./r163-volume-engines.js')
      return competitorGaps(ws)
    },
  },

  // ─── R146.164 — Funnel CRO ────────────────────────────────────────
  'funnel.track': {
    description: 'Record a funnel event. Params: { sessionId, kind, source?, medium?, campaign?, page?, ref?, amountCents?, meta?, captureId?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { eventTrack } = await import('./r164-funnel-cro.js')
      return eventTrack(ws, params as unknown as Parameters<typeof eventTrack>[1])
    },
  },
  'funnel.summary': {
    description: 'View→click→signup→purchase conversion table. Params: { sinceDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { funnelSummary } = await import('./r164-funnel-cro.js')
      return funnelSummary(ws, (params as { sinceDays?: number }) ?? {})
    },
  },
  'funnel.sessions': {
    description: 'List funnel sessions. Params: { purchasedOnly?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { sessionList } = await import('./r164-funnel-cro.js')
      return sessionList(ws, (params as Parameters<typeof sessionList>[1]) ?? {})
    },
  },
  'funnel.topSources': {
    description: 'Top traffic sources by revenue. Params: { sinceDays?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { topSources } = await import('./r164-funnel-cro.js')
      return topSources(ws, (params as Parameters<typeof topSources>[1]) ?? {})
    },
  },
  'bandit.pick': {
    description: 'Pick next variant via Thompson sampling. Params: { name, variantLabels? (first call) }',
    risk: 'low',
    handler: async (ws, params) => {
      const { banditPick } = await import('./r164-funnel-cro.js')
      return banditPick(ws, params as unknown as Parameters<typeof banditPick>[1])
    },
  },
  'bandit.observe': {
    description: 'Record bandit outcome. Params: { name, variant, won }',
    risk: 'low',
    handler: async (ws, params) => {
      const { banditObserve } = await import('./r164-funnel-cro.js')
      const p = params as { name: string; variant: string; won: boolean }
      return banditObserve(ws, p.name, p.variant, p.won)
    },
  },
  'bandit.list': {
    description: 'List all bandit experiments.',
    risk: 'low',
    handler: async (ws) => {
      const { banditList } = await import('./r164-funnel-cro.js')
      return banditList(ws)
    },
  },
  'cart.abandon': {
    description: 'Register a cart abandonment. Params: { sessionId?, email?, cartValueCents?, items?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { cartAbandonRegister } = await import('./r164-funnel-cro.js')
      return cartAbandonRegister(ws, params as unknown as Parameters<typeof cartAbandonRegister>[1])
    },
  },
  'cart.recovered': {
    description: 'Mark a session as recovered. Params: { sessionId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { cartMarkRecovered } = await import('./r164-funnel-cro.js')
      return cartMarkRecovered(ws, (params as { sessionId: string }).sessionId)
    },
  },
  'cart.recoverDrafts': {
    description: 'Mint a recovery campaign for ≥1h-old abandons with known emails.',
    risk: 'low',
    handler: async (ws) => {
      const { cartRecoverDrafts } = await import('./r164-funnel-cro.js')
      return cartRecoverDrafts(ws)
    },
  },

  // ─── R146.165 — Revenue intelligence ──────────────────────────────
  'seo.draft': {
    description: 'Draft a buyer-intent SEO article. Params: { query, businessId?, bodyHint? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { seoDraft } = await import('./r165-revenue-intel.js')
      return seoDraft(ws, params as unknown as Parameters<typeof seoDraft>[1])
    },
  },
  'seo.list': {
    description: 'List SEO articles. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { seoList } = await import('./r165-revenue-intel.js')
      return seoList(ws, (params as Parameters<typeof seoList>[1]) ?? {})
    },
  },
  'seo.publish': {
    description: 'Publish a draft article. Params: { id }',
    risk: 'low',
    handler: async (ws, params) => {
      const { seoPublish } = await import('./r165-revenue-intel.js')
      return seoPublish(ws, (params as { id: string }).id)
    },
  },
  'ltv.score': {
    description: 'Score one customer. Params: { customerRef, revenueCents?, purchaseCount?, firstSeenAt?, lastPurchaseAt?, emailOpens?, emailClicks?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { ltvScore } = await import('./r165-revenue-intel.js')
      return ltvScore(ws, params as unknown as Parameters<typeof ltvScore>[1])
    },
  },
  'ltv.whales': {
    description: 'List top-decile customers. Params: { minDecile?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { ltvWhales } = await import('./r165-revenue-intel.js')
      return ltvWhales(ws, (params as Parameters<typeof ltvWhales>[1]) ?? {})
    },
  },
  'ltv.sweep': {
    description: 'Re-score every active capture using existing funnel + email signals.',
    risk: 'low',
    handler: async (ws) => {
      const { ltvSweep } = await import('./r165-revenue-intel.js')
      return ltvSweep(ws)
    },
  },
  'crossbusiness.overlap': {
    description: 'Find customers shared across businesses (upsell opportunity).',
    risk: 'low',
    handler: async (ws) => {
      const { crossOverlap } = await import('./r165-revenue-intel.js')
      return crossOverlap(ws)
    },
  },
  'refund.log': {
    description: 'Log + classify a refund. Params: { reasonText, businessId?, orderRef?, customerRef?, amountCents?, category? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { refundLog } = await import('./r165-revenue-intel.js')
      return refundLog(ws, params as unknown as Parameters<typeof refundLog>[1])
    },
  },
  'refund.themes': {
    description: 'Roll up refund categories; mint product-issue PAI lessons. Params: { sinceDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { refundThemes } = await import('./r165-revenue-intel.js')
      return refundThemes(ws, (params as { sinceDays?: number }) ?? {})
    },
  },

  // ─── R146.166 — Director controls (Higgsfield-style) ──────────────
  'director.presets': {
    description: 'List all cinema presets: camera bodies, lenses, motions, color grades, vibes.',
    risk: 'low',
    handler: async () => {
      const { presetsList } = await import('./r166-director-controls.js')
      return presetsList()
    },
  },
  'director.profileCreate': {
    description: 'Create a director profile (camera+lens+motions+grade+vibe). Params: { name, cameraBody?, lens?, focalMm?, aperture?, motions? (≤3), colorGrade?, vibe?, notes?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { profileCreate } = await import('./r166-director-controls.js')
      return profileCreate(ws, params as unknown as Parameters<typeof profileCreate>[1])
    },
  },
  'director.profileList': {
    description: 'List director profiles.',
    risk: 'low',
    handler: async (ws) => {
      const { profileList } = await import('./r166-director-controls.js')
      return profileList(ws)
    },
  },
  'character.lock': {
    description: 'Register a character with reference images + description for cross-shot consistency. Params: { name, description, referenceUrls?, appearanceSeed?, voiceId?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { characterLockCreate } = await import('./r166-director-controls.js')
      return characterLockCreate(ws, params as unknown as Parameters<typeof characterLockCreate>[1])
    },
  },
  'character.list': {
    description: 'List locked characters.',
    risk: 'low',
    handler: async (ws) => {
      const { characterList } = await import('./r166-director-controls.js')
      return characterList(ws)
    },
  },
  'director.bindToRun': {
    description: 'Bind a director profile + characters to a PAI run. Params: { runId, profileId, characterIds? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bindToRun } = await import('./r166-director-controls.js')
      return bindToRun(ws, params as unknown as Parameters<typeof bindToRun>[1])
    },
  },
  'director.applyToPlan': {
    description: 'Rewrite a PAI run plan with the bound profile (composes augmented shot prompts). Params: { runId }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { applyProfileToPlan } = await import('./r166-director-controls.js')
      return applyProfileToPlan(ws, (params as { runId: string }).runId)
    },
  },

  // ─── R146.167 — Auto-publish pipeline ─────────────────────────────
  'publish.fromRun': {
    description: 'Publish a completed PAI run to all active platforms (drafts socialPosts with bandit-picked captions). Params: { runId, platforms?, scheduledAt? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { publishFromRun } = await import('./r167-auto-publish.js')
      return publishFromRun(ws, params as unknown as Parameters<typeof publishFromRun>[1])
    },
  },
  'publish.autoRepurpose': {
    description: 'Mint a R163 repurpose pack from a completed run. Params: { runId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { autoRepurposeFromRun } = await import('./r167-auto-publish.js')
      return autoRepurposeFromRun(ws, (params as { runId: string }).runId)
    },
  },
  'publish.andRepurpose': {
    description: 'Combo: publish + repurpose. Params: { runId, platforms?, scheduledAt? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { publishAndRepurpose } = await import('./r167-auto-publish.js')
      const p = params as { runId: string; platforms?: string[]; scheduledAt?: number }
      return publishAndRepurpose(ws, p.runId, { ...(p.platforms ? { platforms: p.platforms } : {}), ...(p.scheduledAt ? { scheduledAt: p.scheduledAt } : {}) })
    },
  },
  'publish.plans': {
    description: 'List publish plans. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { publishPlanList } = await import('./r167-auto-publish.js')
      return publishPlanList(ws, (params as Parameters<typeof publishPlanList>[1]) ?? {})
    },
  },

  // ─── R146.168 — Loop closure: lessons→prompts + funnel→PAI ────────
  'loop.lessonsToPrompts': {
    description: 'Seed high-confidence PAI lessons into the prompt-evolution registry. Params: { minConfidence?, maxPerTopic? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { lessonsToPrompts } = await import('./r168-loop-closure.js')
      return lessonsToPrompts(ws, (params as Parameters<typeof lessonsToPrompts>[1]) ?? {})
    },
  },
  'loop.funnelToOutcome': {
    description: 'Auto-fill outcomeScore on done PAI runs from attributed funnel revenue. Params: { sinceDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { funnelToOutcome } = await import('./r168-loop-closure.js')
      return funnelToOutcome(ws, (params as { sinceDays?: number }) ?? {})
    },
  },
  'loop.close': {
    description: 'Run both closures in sequence.',
    risk: 'low',
    handler: async (ws) => {
      const { closeLoops } = await import('./r168-loop-closure.js')
      return closeLoops(ws)
    },
  },

  // ─── R146.169 — Operator dashboard ────────────────────────────────
  'dashboard.summary': {
    description: 'All-in-one dashboard: audience, social, funnel, revenue, PAI, publishing, issues, action queue.',
    risk: 'low',
    handler: async (ws) => {
      const { dashboardSummary } = await import('./r169-dashboard.js')
      return dashboardSummary(ws)
    },
  },

  // ─── R146.170 — Frontier video ────────────────────────────────────
  'video.vibeMotion': {
    description: 'Derive a new director profile from your top-scored PAI runs (motion style transfer). Params: { topN?, profileName? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { vibeMotionDerive } = await import('./r170-frontier-video.js')
      return vibeMotionDerive(ws, (params as Parameters<typeof vibeMotionDerive>[1]) ?? {})
    },
  },
  'video.imageToVideo': {
    description: 'Single-shot image-to-video direct render. Params: { imageUrl, prompt?, motionPreset?, durationSec?, aspectRatio? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { imageToVideo } = await import('./r170-frontier-video.js')
      return imageToVideo(ws, params as unknown as Parameters<typeof imageToVideo>[1])
    },
  },

  // ─── R146.171 — Audio sync layer ──────────────────────────────────
  'audio.lipSync': {
    description: 'Lip-sync an audio track onto a video via Sieve. Params: { videoUrl, audioUrl, runId?, shotId? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { lipSyncToVideo } = await import('./r171-audio-sync.js')
      return lipSyncToVideo(ws, params as unknown as Parameters<typeof lipSyncToVideo>[1])
    },
  },
  'audio.foley': {
    description: 'Generate ambient SFX for a scene via ElevenLabs. Params: { sceneDesc, durationSec?, runId?, shotId? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { foleyForScene } = await import('./r171-audio-sync.js')
      return foleyForScene(ws, params as unknown as Parameters<typeof foleyForScene>[1])
    },
  },
  'audio.narrateSync': {
    description: 'Voiceover script + lip-sync to video in one call. Params: { videoUrl, script, voice?, runId?, shotId? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { narrateAndSync } = await import('./r171-audio-sync.js')
      return narrateAndSync(ws, params as unknown as Parameters<typeof narrateAndSync>[1])
    },
  },
  'audio.jobs': {
    description: 'List audio sync jobs. Params: { runId?, status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { audioJobsList } = await import('./r171-audio-sync.js')
      return audioJobsList(ws, (params as Parameters<typeof audioJobsList>[1]) ?? {})
    },
  },

  // ─── R146.172 — Mixcraft adapter ──────────────────────────────────
  'mixcraft.bundleCreate': {
    description: 'Create a Mixcraft project bundle. Params: { name, bpm?, timeSignature?, sampleRate?, bitDepth?, masterAudioUrl?, durationSec?, sourceKind?, sourceRef?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bundleCreate } = await import('./r172-mixcraft-adapter.js')
      return bundleCreate(ws, params as unknown as Parameters<typeof bundleCreate>[1])
    },
  },
  'mixcraft.trackAdd': {
    description: 'Add a track to a Mixcraft bundle. Params: { bundleId, name, audioUrl, role?, midiUrl?, positionSec?, durationSec?, volumeDb?, pan?, muted?, solo?, colorHex?, orderIdx? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { trackAdd } = await import('./r172-mixcraft-adapter.js')
      return trackAdd(ws, params as unknown as Parameters<typeof trackAdd>[1])
    },
  },
  'mixcraft.fromMusicJob': {
    description: 'Wrap a Novan music-studio result (stems + master) into a Mixcraft bundle. Params: { name?, bpm?, timeSignature?, durationSec?, masterAudioUrl?, stems[], sourceRef?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { fromMusicJob } = await import('./r172-mixcraft-adapter.js')
      return fromMusicJob(ws, params as unknown as Parameters<typeof fromMusicJob>[1])
    },
  },
  'mixcraft.bundles': {
    description: 'List Mixcraft bundles. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bundleList } = await import('./r172-mixcraft-adapter.js')
      return bundleList(ws, (params as { limit?: number }) ?? {})
    },
  },
  'mixcraft.bundle': {
    description: 'Get a bundle + its tracks. Params: { bundleId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bundleGet } = await import('./r172-mixcraft-adapter.js')
      return bundleGet(ws, (params as { bundleId: string }).bundleId)
    },
  },
  'mixcraft.manifest': {
    description: 'Return the JSON manifest for a bundle (same shape served by GET /mixcraft/:ws/:id/manifest.json). Params: { bundleId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { manifestFor } = await import('./r172-mixcraft-adapter.js')
      return manifestFor(ws, (params as { bundleId: string }).bundleId)
    },
  },
  'mixcraft.importScript': {
    description: 'Return the PowerShell import driver for a bundle. Params: { bundleId, mixcraftExe?, workDir? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { manifestFor, importScriptPs1 } = await import('./r172-mixcraft-adapter.js')
      const p = params as { bundleId: string; mixcraftExe?: string; workDir?: string }
      const m = await manifestFor(ws, p.bundleId)
      if (!m) return { error: 'bundle not found' }
      return { script: importScriptPs1(m, { ...(p.mixcraftExe ? { mixcraftExe: p.mixcraftExe } : {}), ...(p.workDir ? { workDir: p.workDir } : {}) }) }
    },
  },
  'mixcraft.controllerScript': {
    description: 'Return the Mixcraft 10 MIDI controller script (JavaScript).',
    risk: 'low',
    handler: async () => {
      const { controllerScriptJs } = await import('./r172-mixcraft-adapter.js')
      return { script: controllerScriptJs() }
    },
  },

  // ─── R146.173 — Music deep-listen + reproduce + master ────────────
  'music.analyze': {
    description: 'Deep-listen a reference song: stems + key + BPM + structure + instruments. Params: { sourceUrl, sourceKind?, title?, artist? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { songAnalyze } = await import('./r173-music-deep.js')
      return songAnalyze(ws, params as unknown as Parameters<typeof songAnalyze>[1])
    },
  },
  'music.recipeFromAnalysis': {
    description: 'Compose a Suno/Udio-grade structured prompt from an analyzed song. Params: { analysisId, name?, durationSec?, targetLufs? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { recipeFromAnalysis } = await import('./r173-music-deep.js')
      return recipeFromAnalysis(ws, params as unknown as Parameters<typeof recipeFromAnalysis>[1])
    },
  },
  'music.reproduce': {
    description: 'Generate the song from a recipe via Suno/Udio/Stable Audio + auto-master. Params: { recipeId, provider?, autoMaster? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { reproduce } = await import('./r173-music-deep.js')
      return reproduce(ws, params as unknown as Parameters<typeof reproduce>[1])
    },
  },
  'music.makeAlike': {
    description: 'End-to-end: analyze → recipe → reproduce → master. One call to clone a song. Params: { sourceUrl, title?, artist?, durationSec? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { makeAlike } = await import('./r173-music-deep.js')
      return makeAlike(ws, params as unknown as Parameters<typeof makeAlike>[1])
    },
  },
  'music.studioMaster': {
    description: 'R173 studio master via Matchering / LANDR / CloudBounce / eMastered. Params: { inputUrl, referenceUrl?, lufsTarget?, truePeakTarget?, provider? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { masterAudio } = await import('./r173-music-deep.js')
      return masterAudio(ws, params as unknown as Parameters<typeof masterAudio>[1])
    },
  },
  'music.analysis': {
    description: 'Get a song analysis. Params: { id }',
    risk: 'low',
    handler: async (ws, params) => {
      const { analysisGet } = await import('./r173-music-deep.js')
      return analysisGet(ws, (params as { id: string }).id)
    },
  },
  'music.recipes': {
    description: 'List recipes. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { recipesList } = await import('./r173-music-deep.js')
      return recipesList(ws, (params as { limit?: number }) ?? {})
    },
  },
  'music.reproductions': {
    description: 'List reproductions. Params: { recipeId?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { reproductionsList } = await import('./r173-music-deep.js')
      return reproductionsList(ws, (params as Parameters<typeof reproductionsList>[1]) ?? {})
    },
  },

  // ─── R146.174 — CapCut adapter ────────────────────────────────────
  'capcut.projectCreate': {
    description: 'Create a CapCut project. Params: { name, width?, height?, fps?, sourceKind?, sourceRef?, businessId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { projectCreate } = await import('./r174-capcut-adapter.js')
      return projectCreate(ws, params as unknown as Parameters<typeof projectCreate>[1])
    },
  },
  'capcut.clipAdd': {
    description: 'Add a clip. Params: { projectId, kind, assetUrl?, trackIdx?, startMs, durationMs, sourceStartMs?, transform?, orderIdx? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { clipAdd } = await import('./r174-capcut-adapter.js')
      return clipAdd(ws, params as unknown as Parameters<typeof clipAdd>[1])
    },
  },
  'capcut.fromVideoRun': {
    description: 'Wrap a completed R160 PAI video run into a CapCut project. Params: { runId, name?, width?, height?, fps? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { capcutFromVideoRun } = await import('./r174-capcut-adapter.js')
      const p = params as { runId: string; name?: string; width?: number; height?: number; fps?: number }
      return capcutFromVideoRun(ws, p.runId, { ...(p.name ? { name: p.name } : {}), ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}), ...(p.fps ? { fps: p.fps } : {}) })
    },
  },
  'capcut.projects': {
    description: 'List CapCut projects. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { projectList } = await import('./r174-capcut-adapter.js')
      return projectList(ws, (params as { limit?: number }) ?? {})
    },
  },
  'capcut.project': {
    description: 'Get a project + clips. Params: { projectId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { projectGet } = await import('./r174-capcut-adapter.js')
      return projectGet(ws, (params as { projectId: string }).projectId)
    },
  },
  'capcut.draftJson': {
    description: 'Return CapCut draft_content.json (same as GET /capcut/:ws/:id/draft_content.json). Params: { projectId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { draftContentJson } = await import('./r174-capcut-adapter.js')
      return draftContentJson(ws, (params as { projectId: string }).projectId)
    },
  },

  // ─── R146.175 — Crystal-clear image generation + upscaling ────────
  'image.proGenerate': {
    description: 'Top-tier image gen. Provider waterfall: Flux Pro Ultra → MJ v7 → Recraft v3 → Imagen 4 → Ideogram v3. Params: { prompt, negativePrompt?, aspect?, megapixels?, seed?, referenceUrls?, provider? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { proGenerate } = await import('./r175-image-pro.js')
      return proGenerate(ws, params as unknown as Parameters<typeof proGenerate>[1])
    },
  },
  'image.upscale': {
    description: 'High-quality upscale. Waterfall: Magnific → Clarity → Topaz → Upscayl. Params: { imageUrl, factor?, detail?, provider? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { upscale } = await import('./r175-image-pro.js')
      return upscale(ws, params as unknown as Parameters<typeof upscale>[1])
    },
  },
  'image.crystalize': {
    description: 'Combo: top-tier generate + auto-upscale for crystal-clear output. Params: { prompt, ...genParams, upscaleFactor?, upscaleDetail? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { crystalize } = await import('./r175-image-pro.js')
      return crystalize(ws, params as unknown as Parameters<typeof crystalize>[1])
    },
  },
  'image.proJobs': {
    description: 'List pro image generations. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { proJobsList } = await import('./r175-image-pro.js')
      return proJobsList(ws, (params as Parameters<typeof proJobsList>[1]) ?? {})
    },
  },
  'image.upscaleJobs': {
    description: 'List upscale jobs. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { upscaleJobsList } = await import('./r175-image-pro.js')
      return upscaleJobsList(ws, (params as Parameters<typeof upscaleJobsList>[1]) ?? {})
    },
  },

  // ─── R146.176 — Video tactics analyzer ────────────────────────────
  'video.tactics.analyze': {
    description: 'Watch a video and extract: hook, cut tempo, retention beats, captions, engagement, platform ranking signals. Params: { sourceUrl, platform? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { tacticAnalyze } = await import('./r176-video-tactics.js')
      return tacticAnalyze(ws, params as unknown as Parameters<typeof tacticAnalyze>[1])
    },
  },
  'video.tactics.compare': {
    description: 'Diff two analyses + give improvement suggestions for A. Params: { id1, id2 }',
    risk: 'low',
    handler: async (ws, params) => {
      const { compareTactics } = await import('./r176-video-tactics.js')
      return compareTactics(ws, params as unknown as Parameters<typeof compareTactics>[1])
    },
  },
  'video.tactics.get': {
    description: 'Get a tactic analysis. Params: { id }',
    risk: 'low',
    handler: async (ws, params) => {
      const { tacticAnalysisGet } = await import('./r176-video-tactics.js')
      return tacticAnalysisGet(ws, (params as { id: string }).id)
    },
  },
  'video.tactics.list': {
    description: 'List analyses. Params: { platform?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { tacticAnalysesList } = await import('./r176-video-tactics.js')
      return tacticAnalysesList(ws, (params as Parameters<typeof tacticAnalysesList>[1]) ?? {})
    },
  },
  'video.tactics.playbook': {
    description: 'Get the workspace-or-global ranking playbook for a platform+form. Params: { platform, form }',
    risk: 'low',
    handler: async (ws, params) => {
      const { playbookGet } = await import('./r176-video-tactics.js')
      const p = params as { platform: string; form: 'short' | 'long' }
      return playbookGet(ws, p.platform, p.form)
    },
  },

  // ─── R146.177 — Browser humanizer + spend-lock ────────────────────
  'browser.humanize.action': {
    description: 'Run a browser action through the humanizer + spend-lock + cap-check + audit. Params: { sessionId, accountId?, platform?, kind, countAs?, target?, value?, scrollPx?, waitMs? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { humanizeAction } = await import('./r177-browser-humanizer.js')
      return humanizeAction(ws, params as unknown as Parameters<typeof humanizeAction>[1])
    },
  },
  'browser.humanize.profileUpsert': {
    description: 'Set the humanizer profile (typing WPM, pause range, peak hours, daily caps). Params: { accountId?, typingWpmMin?, typingWpmMax?, pauseMinMs?, pauseMaxMs?, peakHours?, dailyCaps?, weekendFactor? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { profileUpsert } = await import('./r177-browser-humanizer.js')
      return profileUpsert(ws, params as unknown as Parameters<typeof profileUpsert>[1])
    },
  },
  'browser.humanize.profileGet': {
    description: 'Get the humanizer profile. Params: { accountId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { profileGet } = await import('./r177-browser-humanizer.js')
      return profileGet(ws, (params as { accountId?: string }).accountId)
    },
  },
  'browser.humanize.actionLog': {
    description: 'List recent browser actions. Params: { sessionId?, accountId?, platform?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { actionLogList } = await import('./r177-browser-humanizer.js')
      return actionLogList(ws, (params as Parameters<typeof actionLogList>[1]) ?? {})
    },
  },
  'browser.humanize.dailyCounts': {
    description: 'Per-kind action counts for the last 24h. Params: { accountId?, platform? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { dailyCountsSummary } = await import('./r177-browser-humanizer.js')
      return dailyCountsSummary(ws, (params as Parameters<typeof dailyCountsSummary>[1]) ?? {})
    },
  },

  // ─── R146.178 — Managed accounts + warmup + sign-in ───────────────
  'account.add': {
    description: 'Register a managed account (creds stored in vault). Params: { platform, handle, username, password, totpSeed?, requires2fa?, displayName?, businessId?, role? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { accountAdd } = await import('./r178-managed-accounts.js')
      return accountAdd(ws, params as unknown as Parameters<typeof accountAdd>[1])
    },
  },
  'account.list': {
    description: 'List managed accounts (no creds returned). Params: { status?, platform?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { accountList } = await import('./r178-managed-accounts.js')
      return accountList(ws, (params as Parameters<typeof accountList>[1]) ?? {})
    },
  },
  'account.pause': {
    description: 'Pause an account. Params: { accountId }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { accountPause } = await import('./r178-managed-accounts.js')
      return accountPause(ws, (params as { accountId: string }).accountId)
    },
  },
  'account.warmupPlan': {
    description: 'Create a warmup plan for an account using the platform curve. Params: { accountId }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { warmupPlanCreate } = await import('./r178-managed-accounts.js')
      return warmupPlanCreate(ws, (params as { accountId: string }).accountId)
    },
  },
  'account.warmupTick': {
    description: 'Mark todays warmup day complete with executed counts. Params: { accountId, completed (Record<string, number>) }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { warmupTick } = await import('./r178-managed-accounts.js')
      const p = params as { accountId: string; completed: Record<string, number> }
      return warmupTick(ws, p.accountId, p.completed ?? {})
    },
  },
  'account.warmupStatus': {
    description: 'Account + warmup plan + per-day progress. Params: { accountId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { warmupStatus } = await import('./r178-managed-accounts.js')
      return warmupStatus(ws, (params as { accountId: string }).accountId)
    },
  },
  'account.signIn': {
    description: 'Humanized sign-in via stored vault creds. Returns requires_human:true on CAPTCHA/2FA. Params: { accountId, sessionId }',
    risk: 'high',
    handler: async (ws, params) => {
      const { accountSignIn } = await import('./r178-managed-accounts.js')
      return accountSignIn(ws, params as unknown as Parameters<typeof accountSignIn>[1])
    },
  },
  'account.signUpOpen': {
    description: 'Open the platform signup page (no auto-fill). Operator finishes by hand. Requires confirm="I_AUTHORIZE_ACCOUNT_CREATION". Params: { platform, sessionId, confirm }',
    risk: 'high',
    handler: async (ws, params) => {
      const { accountSignUpOpen } = await import('./r178-managed-accounts.js')
      return accountSignUpOpen(ws, params as unknown as Parameters<typeof accountSignUpOpen>[1])
    },
  },
  'account.maxDailyTargets': {
    description: 'Todays max sustainable action targets for an account. Returns warming-curve while warming; full caps when active. Params: { accountId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { maxDailyTargets } = await import('./r178-managed-accounts.js')
      return maxDailyTargets(ws, (params as { accountId: string }).accountId)
    },
  },

  // ─── R146.179 — POD social-traffic engine ─────────────────────────
  'pod.store.create': {
    description: 'Create a POD store. Params: { platform: shopify|etsy|printful|redbubble|gumroad, brandName, niche?, domain?, businessId?, socialAccountIds? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { storeCreate } = await import('./r179-pod-social.js')
      return storeCreate(ws, params as unknown as Parameters<typeof storeCreate>[1])
    },
  },
  'pod.store.list': {
    description: 'List active stores.',
    risk: 'low',
    handler: async (ws) => {
      const { storeList } = await import('./r179-pod-social.js')
      return storeList(ws)
    },
  },
  'pod.product.add': {
    description: 'Add a product. Params: { storeId, sku, title, designUrl?, category?, tags?, priceCents, costCents, externalId?, productUrl? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { productAdd } = await import('./r179-pod-social.js')
      return productAdd(ws, params as unknown as Parameters<typeof productAdd>[1])
    },
  },
  'pod.product.list': {
    description: 'Products in a store by revenue. Params: { storeId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { productListByStore } = await import('./r179-pod-social.js')
      return productListByStore(ws, (params as { storeId: string }).storeId)
    },
  },
  'pod.route.attach': {
    description: 'Stitch a social post → store via UTM short URL. Params: { postId, storeId, productId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { routeAttach } = await import('./r179-pod-social.js')
      return routeAttach(ws, params as unknown as Parameters<typeof routeAttach>[1])
    },
  },
  'pod.cadence': {
    description: 'Max-volume content cadence given store inventory + attached accounts. Params: { storeId, daysAhead? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { cadenceFromInventory } = await import('./r179-pod-social.js')
      return cadenceFromInventory(ws, params as unknown as Parameters<typeof cadenceFromInventory>[1])
    },
  },
  'pod.bestSellersToContent': {
    description: 'Top-revenue products → R163 repurpose packs ready to post. Params: { storeId, topN? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bestSellersToContent } = await import('./r179-pod-social.js')
      return bestSellersToContent(ws, params as unknown as Parameters<typeof bestSellersToContent>[1])
    },
  },

  // ─── R146.180 — Money maximizer ───────────────────────────────────
  'money.scan': {
    description: 'Scan every loop for actionable money-making opportunities; rank by $/hr.',
    risk: 'low',
    handler: async (ws) => {
      const { opportunityScan } = await import('./r180-money-maximizer.js')
      return opportunityScan(ws)
    },
  },
  'money.allocate': {
    description: 'Knapsack the top opportunities to fit your hours. Params: { hoursAvailable?, minDollarsPerHour? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { allocateEffort } = await import('./r180-money-maximizer.js')
      return allocateEffort(ws, (params as Parameters<typeof allocateEffort>[1]) ?? {})
    },
  },
  'money.execute': {
    description: 'Execute one opportunity via its mapped brain op. Params: { opportunityId }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { executeNext } = await import('./r180-money-maximizer.js')
      return executeNext(ws, params as unknown as Parameters<typeof executeNext>[1])
    },
  },
  'money.opportunities': {
    description: 'List opportunities. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { opportunitiesList } = await import('./r180-money-maximizer.js')
      return opportunitiesList(ws, (params as Parameters<typeof opportunitiesList>[1]) ?? {})
    },
  },
  'money.dailyOptimize': {
    description: 'Combo: scan + allocate todays effort. Params: { hoursAvailable? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { dailyOptimize } = await import('./r180-money-maximizer.js')
      return dailyOptimize(ws, (params as { hoursAvailable?: number })?.hoursAvailable ?? 8)
    },
  },

  // ─── R146.181 — Self-pentest ──────────────────────────────────────
  'pentest.run': {
    description: 'Run safe red-team probes against Novan itself. Params: { targetBaseUrl?, scope?, triggeredBy? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { runPentest } = await import('./r181-self-pentest.js')
      return runPentest(ws, (params as Parameters<typeof runPentest>[1]) ?? {})
    },
  },
  'pentest.runs': {
    description: 'List pentest runs. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { runsList } = await import('./r181-self-pentest.js')
      return runsList(ws, (params as { limit?: number }) ?? {})
    },
  },
  'pentest.findings': {
    description: 'List findings. Params: { runId?, severity?, status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { findingsList } = await import('./r181-self-pentest.js')
      return findingsList(ws, (params as Parameters<typeof findingsList>[1]) ?? {})
    },
  },
  'pentest.finding.resolve': {
    description: 'Resolve a finding. Params: { id, status: fixed|wontfix|duplicate, fixPr? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { findingResolve } = await import('./r181-self-pentest.js')
      return findingResolve(ws, params as unknown as Parameters<typeof findingResolve>[1])
    },
  },

  // ─── R146.182 — Voice layer ───────────────────────────────────────
  'voice.persona.upsert': {
    description: 'Create or update a voice persona. Params: { name?, preset?, wakeWord?, voiceId?, personaPrompt?, tone?, alwaysOn?, proactiveEnabled? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { personaUpsert } = await import('./r182-voice-layer.js')
      return personaUpsert(ws, params as unknown as Parameters<typeof personaUpsert>[1])
    },
  },
  'voice.persona.get': {
    description: 'Get persona + client-side wake-word config. Params: { name? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { personaGet, wakeWordConfig } = await import('./r182-voice-layer.js')
      const p = await personaGet(ws, (params as { name?: string })?.name ?? 'novan')
      if (!p) return null
      return { persona: p, wakeWordConfig: wakeWordConfig(p) }
    },
  },
  'voice.persona.list': {
    description: 'List personas.',
    risk: 'low',
    handler: async (ws) => {
      const { personaList } = await import('./r182-voice-layer.js')
      return personaList(ws)
    },
  },
  'voice.session.ping': {
    description: 'Cross-device heartbeat + draft sync. Params: { userId, deviceId, deviceKind?, activeChatId?, draftInput?, draftVoiceState? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { sessionPing } = await import('./r182-voice-layer.js')
      return sessionPing(ws, params as unknown as Parameters<typeof sessionPing>[1])
    },
  },
  'voice.session.handoff': {
    description: 'Transfer active chat + draft from one device to another. Params: { userId, fromDeviceId, toDeviceId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { handoff } = await import('./r182-voice-layer.js')
      return handoff(ws, params as unknown as Parameters<typeof handoff>[1])
    },
  },
  'voice.devices': {
    description: 'List devices active in last 5 minutes. Params: { userId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { devicesList } = await import('./r182-voice-layer.js')
      return devicesList(ws, (params as { userId: string }).userId)
    },
  },

  // ─── R146.183 — Proactive + threat radar ──────────────────────────
  'proactive.scan': {
    description: 'Sweep for interrupt-worthy events + fire push for high/urgent.',
    risk: 'medium',
    handler: async (ws) => {
      const { proactiveScan } = await import('./r183-proactive-radar.js')
      return proactiveScan(ws)
    },
  },
  'proactive.ack': {
    description: 'Acknowledge a signal. Params: { id }',
    risk: 'low',
    handler: async (ws, params) => {
      const { proactiveAck } = await import('./r183-proactive-radar.js')
      return proactiveAck(ws, (params as { id: string }).id)
    },
  },
  'proactive.list': {
    description: 'List signals. Params: { unackedOnly?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { proactiveList } = await import('./r183-proactive-radar.js')
      return proactiveList(ws, (params as Parameters<typeof proactiveList>[1]) ?? {})
    },
  },
  'radar.scan': {
    description: 'Compute + persist a threat radar snapshot.',
    risk: 'low',
    handler: async (ws) => {
      const { radarScan } = await import('./r183-proactive-radar.js')
      return radarScan(ws)
    },
  },
  'radar.latest': {
    description: 'Latest snapshot.',
    risk: 'low',
    handler: async (ws) => {
      const { radarLatest } = await import('./r183-proactive-radar.js')
      return radarLatest(ws)
    },
  },
  'radar.ticker': {
    description: 'Single-line ticker string for UI heads-up.',
    risk: 'low',
    handler: async (ws) => {
      const { radarTickerLine } = await import('./r183-proactive-radar.js')
      return { line: await radarTickerLine(ws) }
    },
  },

  // ─── R146.184 — Physical bridges ──────────────────────────────────
  'physical.endpoint.register': {
    description: 'Register Home Assistant / OctoPrint / Bambu / Tesla / LinuxCNC endpoint. Params: { kind, label, baseUrl, token?, metadata? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { endpointRegister } = await import('./r184-physical-bridges.js')
      return endpointRegister(ws, params as unknown as Parameters<typeof endpointRegister>[1])
    },
  },
  'physical.endpoint.list': {
    description: 'List physical endpoints (no tokens returned). Params: { kind? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { endpointList } = await import('./r184-physical-bridges.js')
      return endpointList(ws, (params as { kind?: string }) ?? {})
    },
  },
  'home.callService': {
    description: 'Home Assistant service call. Params: { endpointId, domain, service, data? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { homeCallService } = await import('./r184-physical-bridges.js')
      return homeCallService(ws, params as unknown as Parameters<typeof homeCallService>[1])
    },
  },
  'home.state': {
    description: 'Home Assistant state read. Params: { endpointId, entityId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { homeState } = await import('./r184-physical-bridges.js')
      return homeState(ws, params as unknown as Parameters<typeof homeState>[1])
    },
  },
  'print.start': {
    description: 'Start an OctoPrint/Bambu job. Params: { endpointId, filePath }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { printStart } = await import('./r184-physical-bridges.js')
      return printStart(ws, params as unknown as Parameters<typeof printStart>[1])
    },
  },
  'print.status': {
    description: 'Print job status. Params: { endpointId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { printStatus } = await import('./r184-physical-bridges.js')
      return printStatus(ws, (params as { endpointId: string }).endpointId)
    },
  },
  'print.cancel': {
    description: 'Cancel print. Params: { endpointId }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { printCancel } = await import('./r184-physical-bridges.js')
      return printCancel(ws, (params as { endpointId: string }).endpointId)
    },
  },
  'bio.ingest': {
    description: 'Ingest biometric event(s). Params: { source, kind, value, unit?, recordedAt?, userId? } or array',
    risk: 'low',
    handler: async (ws, params) => {
      const { bioIngest } = await import('./r184-physical-bridges.js')
      return bioIngest(ws, params as unknown as Parameters<typeof bioIngest>[1])
    },
  },
  'bio.list': {
    description: 'List biometric events. Params: { kind?, source?, sinceDays?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bioList } = await import('./r184-physical-bridges.js')
      return bioList(ws, (params as Parameters<typeof bioList>[1]) ?? {})
    },
  },
  'bio.summary': {
    description: 'Avg/min/max for a biometric kind. Params: { kind, sinceDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bioSummary } = await import('./r184-physical-bridges.js')
      return bioSummary(ws, params as unknown as Parameters<typeof bioSummary>[1])
    },
  },

  // ─── R146.185 — Tier B (FRIDAY + predictive + tactical + XR + vehicle) ──
  'companion.create': {
    description: 'Create a FRIDAY-style companion AI. Params: { name, basePersona?, modelTier? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { companionCreate } = await import('./r185-tier-b.js')
      return companionCreate(ws, params as unknown as Parameters<typeof companionCreate>[1])
    },
  },
  'companion.list': {
    description: 'List active companions.',
    risk: 'low',
    handler: async (ws) => {
      const { companionList } = await import('./r185-tier-b.js')
      return companionList(ws)
    },
  },
  'signal.classify': {
    description: 'Classify any incoming signal (email/dm/comment/call/sms). Params: { source, content, externalRef? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { signalClassify } = await import('./r185-tier-b.js')
      return signalClassify(ws, params as unknown as Parameters<typeof signalClassify>[1])
    },
  },
  'signal.list': {
    description: 'List classified signals. Params: { kind?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { signalList } = await import('./r185-tier-b.js')
      return signalList(ws, (params as Parameters<typeof signalList>[1]) ?? {})
    },
  },
  'tactical.sim': {
    description: 'Monte Carlo over a scenario. Params: { scenario, assumptions: {key: number}, trials?, variance?, durationDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { tacticalSim } = await import('./r185-tier-b.js')
      return tacticalSim(ws, params as unknown as Parameters<typeof tacticalSim>[1])
    },
  },
  'tactical.whatIf': {
    description: 'Baseline vs scenario comparison from current portfolio. Params: { scenarioLabel, pauseAccountId?, durationDays? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { tacticalWhatIf } = await import('./r185-tier-b.js')
      return tacticalWhatIf(ws, params as unknown as Parameters<typeof tacticalWhatIf>[1])
    },
  },
  'xr.scene.save': {
    description: 'Save an A-Frame XR scene. Params: { name, sceneJson, arEnabled?, vrEnabled? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { xrSceneSave } = await import('./r185-tier-b.js')
      return xrSceneSave(ws, params as unknown as Parameters<typeof xrSceneSave>[1])
    },
  },
  'xr.scene.get': {
    description: 'Get a scene by name. Params: { name }',
    risk: 'low',
    handler: async (ws, params) => {
      const { xrSceneGet } = await import('./r185-tier-b.js')
      return xrSceneGet(ws, (params as { name: string }).name)
    },
  },
  'xr.dashboard.auto': {
    description: 'Auto-build the portfolio dashboard scene. Served at /xr/:ws/dashboard.',
    risk: 'low',
    handler: async (ws) => {
      const { xrAutoDashboard } = await import('./r185-tier-b.js')
      return xrAutoDashboard(ws)
    },
  },
  'vehicle.status': {
    description: 'Read Tesla vehicle data via R184 endpoint kind=tesla. Params: { endpointId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { vehicleStatus } = await import('./r185-tier-b.js')
      return vehicleStatus(ws, (params as { endpointId: string }).endpointId)
    },
  },

  // ─── R146.191 — Feature flags + R161 approved-reply sweep ─────────
  'flag.list': {
    description: 'List all feature flags.',
    risk: 'low',
    handler: async () => {
      const { db } = await import('../db/client.js')
      const { featureFlag } = await import('../db/schema.js')
      return db.select().from(featureFlag).orderBy(featureFlag.key)
    },
  },
  'flag.set': {
    description: 'Toggle a feature flag. Params: { key, enabled, description? }',
    risk: 'medium',
    handler: async (_ws, params) => {
      const { db } = await import('../db/client.js')
      const { featureFlag } = await import('../db/schema.js')
      const { eq } = await import('drizzle-orm')
      const p = params as { key: string; enabled: boolean; description?: string }
      if (!p.key) throw new Error('key required')
      const now = Date.now()
      await db.insert(featureFlag).values({ key: p.key, enabled: p.enabled, ...(p.description ? { description: p.description } : {}), updatedAt: now, updatedBy: 'brain-op' })
        .onConflictDoUpdate({ target: featureFlag.key, set: { enabled: p.enabled, ...(p.description ? { description: p.description } : {}), updatedAt: now, updatedBy: 'brain-op' } })
      const [r] = await db.select().from(featureFlag).where(eq(featureFlag.key, p.key)).limit(1)
      return r
    },
  },
  'bio.anomalyCheck': {
    description: 'Z-score anomaly check vs 14-day baseline; mints proactive_signal on z≥2.5. Params: { kind, windowMin?, baselineDays?, zThreshold? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { bioAnomalyCheck } = await import('./r184-physical-bridges.js')
      return bioAnomalyCheck(ws, params as unknown as Parameters<typeof bioAnomalyCheck>[1])
    },
  },
  // ─── R146.196 — Quickstart + status ──────────────────────────────
  'platform.status': {
    description: 'Single-call platform snapshot: radar + open issues + open self-dev findings + cron coverage + flags.',
    risk: 'low',
    handler: async (ws) => {
      const { platformStatus } = await import('./r196-quickstart.js')
      return platformStatus(ws)
    },
  },
  'platform.quickstart': {
    description: 'First-run wizard: seeds default persona + director profile + starter ISA + returns checklist.',
    risk: 'low',
    handler: async (ws) => {
      const { quickstart } = await import('./r196-quickstart.js')
      return quickstart(ws)
    },
  },

  // ─── R146.193 — Novan Self-Dev Engine ─────────────────────────────
  'selfdev.inspect': {
    description: 'Run 12 parallel inspectors and persist findings. Params: { goal? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { inspectAll } = await import('./r193-novan-self-dev.js')
      return inspectAll(ws, (params as { goal?: string }) ?? {})
    },
  },
  'selfdev.propose': {
    description: 'Generate fix proposals for open findings via LLM. Params: { sessionId?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { proposeForFindings } = await import('./r193-novan-self-dev.js')
      return proposeForFindings(ws, (params as { sessionId?: string; limit?: number }) ?? {})
    },
  },
  'selfdev.approve': {
    description: 'Approve a proposal. Params: { proposalId, approvedBy, confirm:"I_AUTHORIZE_PROPOSAL_APPROVAL" }',
    risk: 'high',
    handler: async (ws, params) => {
      const { approveProposal } = await import('./r193-novan-self-dev.js')
      return approveProposal(ws, params as unknown as Parameters<typeof approveProposal>[1])
    },
  },
  'selfdev.reject': {
    description: 'Reject a proposal. Params: { proposalId }',
    risk: 'low',
    handler: async (ws, params) => {
      const { rejectProposal } = await import('./r193-novan-self-dev.js')
      return rejectProposal(ws, (params as { proposalId: string }).proposalId)
    },
  },
  'selfdev.autoLoop': {
    description: 'Run a full inspect → propose cycle. Gated by feature flag self_dev_inspect_enabled.',
    risk: 'medium',
    handler: async (ws) => {
      const { autoLoop } = await import('./r193-novan-self-dev.js')
      return autoLoop(ws)
    },
  },
  'selfdev.sessions': {
    description: 'List sessions. Params: { limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { sessionList } = await import('./r193-novan-self-dev.js')
      return sessionList(ws, (params as { limit?: number }) ?? {})
    },
  },
  'selfdev.findings': {
    description: 'List findings. Params: { status?, severity?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { findingList } = await import('./r193-novan-self-dev.js')
      return findingList(ws, (params as Parameters<typeof findingList>[1]) ?? {})
    },
  },
  'selfdev.proposals': {
    description: 'List proposals. Params: { status?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { proposalList } = await import('./r193-novan-self-dev.js')
      return proposalList(ws, (params as Parameters<typeof proposalList>[1]) ?? {})
    },
  },

  'social.reply.sweepApproved': {
    description: 'Sweep approved drafts and send them, capped 10/h. Params: { hourlyCap? }',
    risk: 'high',
    handler: async (ws, params) => {
      const { sweepApprovedSends } = await import('./r161-social-comments.js')
      return sweepApprovedSends(ws, (params as { hourlyCap?: number }) ?? {})
    },
  },

  // ─── R146.206 Skills registry ───────────────────────────────────
  'skill.create': {
    description: 'Register or update a skill (capability bundle). Params: { name, description, whenToUse?, instructions }',
    risk: 'low',
    handler: async (ws, params) => {
      const { skillCreate } = await import('./r206-skills.js')
      return skillCreate(ws, params as { name: string; description: string; whenToUse?: string; instructions: string })
    },
  },
  'skill.list': {
    description: 'List all skills registered for the workspace, sorted by uses.',
    risk: 'low',
    handler: async (ws) => {
      const { skillList } = await import('./r206-skills.js')
      return skillList(ws)
    },
  },
  'skill.load': {
    description: 'Load full instructions for a skill by name. Increments uses counter. Params: { name }',
    risk: 'low',
    handler: async (ws, params) => {
      const { skillLoad } = await import('./r206-skills.js')
      return skillLoad(ws, (params as { name: string }).name)
    },
  },
  'skill.search': {
    description: 'Fuzzy-find skills matching query. Params: { query, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { skillSearch } = await import('./r206-skills.js')
      const p = params as { query: string; limit?: number }
      return skillSearch(ws, p.query, p.limit)
    },
  },
  'skill.score': {
    description: 'Record outcome for a skill. Params: { name, won }',
    risk: 'low',
    handler: async (ws, params) => {
      const { skillScore } = await import('./r206-skills.js')
      const p = params as { name: string; won: boolean }
      return skillScore(ws, p.name, p.won)
    },
  },

  // ─── R146.207 Op search (deferred discovery) ────────────────────
  'op.search': {
    description: 'Find brain ops matching a query without loading the full ~900-op registry. Params: { query, limit? }',
    risk: 'low',
    handler: async (_ws, params) => {
      const { opSearch } = await import('./r207-op-search.js')
      const p = params as { query: string; limit?: number }
      return opSearch(p.query, p.limit)
    },
  },

  // ─── R146.208 Sub-agent spawner ─────────────────────────────────
  'subagent.run': {
    description: 'Spawn an isolated sub-agent with focused prompt + optional JSON schema. Params: { prompt, schema?, parentOp? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { spawnSubagent } = await import('./r208-subagent.js')
      return spawnSubagent(ws, params as { prompt: string; schema?: Record<string, unknown>; parentOp?: string })
    },
  },
  'subagent.parallel': {
    description: 'Spawn N sub-agents in parallel. Params: { requests: [{prompt, schema?}, ...] }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { parallelSubagents } = await import('./r208-subagent.js')
      const p = params as { requests: Array<{ prompt: string; schema?: Record<string, unknown> }> }
      return parallelSubagents(ws, p.requests)
    },
  },

  // ─── R146.209 Adversarial verify ────────────────────────────────
  'verify.adversarial': {
    description: 'Run N skeptics tasked to refute a claim. Returns {decision: approve|block, votes, reasons}. Params: { subject, claim, evidence?, voters?, threshold? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { adversarialVerify } = await import('./r209-adversarial.js')
      return adversarialVerify(ws, params as { subject: string; claim: string; evidence?: string; voters?: number; threshold?: number })
    },
  },

  // ─── R146.210 Workflow runtime ──────────────────────────────────
  'wf.create': {
    description: 'Register or update a workflow JS script. Params: { name, description?, script }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { workflowCreate } = await import('./r210-workflow.js')
      return workflowCreate(ws, params as { name: string; description?: string; script: string })
    },
  },
  'wf.list': {
    description: 'List R210 operator workflows (JS-script kind). For old multi-step workflows use workflow.list.',
    risk: 'low',
    handler: async (ws) => {
      const { workflowList } = await import('./r210-workflow.js')
      return workflowList(ws)
    },
  },
  'wf.run': {
    description: 'Execute an R210 workflow by name with optional args. Params: { name, args?, resumeFromRunId? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { workflowRun } = await import('./r210-workflow.js')
      const p = params as { name: string; args?: unknown; resumeFromRunId?: string }
      return workflowRun(ws, p.name, p.args, p.resumeFromRunId ? { resumeFromRunId: p.resumeFromRunId } : {})
    },
  },
  'brain.metrics': {
    description: 'R219 — operator-visible metrics: skill leaderboard, recent outcomes, routing health, cost 24h, HTTP latency percentiles, workplace counts.',
    risk: 'low',
    handler: async (ws) => {
      const { brainMetrics } = await import('./r219-brain-metrics.js')
      return brainMetrics(ws)
    },
  },
  'brain.capability.smoke': {
    description: 'R236 — hit every R206-R234 brain op in sequence (read-only + cleanup-after writes). Returns probes:[{op, ok, ms}]. Useful end-to-end health check.',
    risk: 'low',
    handler: async (ws) => {
      const { capabilitySmoke } = await import('./r236-capability-smoke.js')
      return capabilitySmoke(ws)
    },
  },
  'session.recap': {
    description: 'R233 — single-call summary of capability-layer activity over 24h. Skills total + active, brain loop runs, sub-agents, adversarial verdicts, workflows, memories, chapters, top skills by wins, cost.',
    risk: 'low',
    handler: async (ws) => {
      const { sessionRecap } = await import('./r233-session-recap.js')
      return sessionRecap(ws)
    },
  },
  'applier.health': {
    description: 'R231 — host-side applier daemon liveness: {status: alive|stale|unwired|never, lastEventAt, lastApplyAt, recentApplies24h, recentRollbacks24h}.',
    risk: 'low',
    handler: async () => {
      const { applierHealth } = await import('./r231-applier-health.js')
      return applierHealth()
    },
  },
  'cost.dailyCap': {
    description: 'R248 — daily AI cost cap status for the workspace. Returns {spent, cap, over, remaining} in USD. Cached 60s. Cap = env DAILY_AI_COST_CAP_USD (default $5).',
    risk: 'low',
    handler: async (ws) => {
      const { checkDailyCostCap } = await import('./r248-cost-cap.js')
      return checkDailyCostCap(ws)
    },
  },
  'cost.overCapList': {
    description: 'R248 — list workspaces currently over their daily cost cap.',
    risk: 'low',
    handler: async () => {
      const { findOverCapWorkspaces } = await import('./r248-cost-cap.js')
      return findOverCapWorkspaces()
    },
  },
  'brain.health.history': {
    description: 'R262 — last N brain.health snapshots for trend graphs. Params: sinceMs? (default 24h), limit? (default 200). Newest first. Returns [{overall, costSpent, cronMissing, errors1h, createdAt}].',
    risk: 'low',
    handler: async (ws, params) => {
      const { readHistory } = await import('./r262-brain-health-history.js')
      const p = params as { sinceMs?: number; limit?: number }
      return readHistory(ws, p.sinceMs, p.limit)
    },
  },
  'brain.health.summary': {
    description: 'R262 — aggregated brain.health for the period. Params: sinceMs? (default 24h). Returns {ticks, healthy, degraded, critical, maxCostSpent, maxCronMissing}.',
    risk: 'low',
    handler: async (ws, params) => {
      const { readSummary } = await import('./r262-brain-health-history.js')
      const p = params as { sinceMs?: number }
      return readSummary(ws, p.sinceMs)
    },
  },
  'notify.send': {
    description: 'R272 — send a notification through configured drivers (webPush, webhook, pushover). Params: type, title, body, severity?, signature?, link?. Rate-limited per (workspace,type,signature).',
    risk: 'low',
    handler: async (ws, params) => {
      const p = params as Record<string, unknown>
      const { notify } = await import('./notifications.js')
      return notify({
        workspaceId: ws,
        type:        String(p['type'] ?? 'brain.alert'),
        title:       String(p['title'] ?? 'Novan'),
        body:        String(p['body'] ?? ''),
        severity:    (p['severity'] as 'normal' | 'high' | 'critical') ?? 'high',
        ...(p['signature'] ? { signature: String(p['signature']) } : {}),
        ...(p['link']      ? { link:      String(p['link']) }      : {}),
      })
    },
  },
  'hooks.seedDefaults': {
    description: 'R257 — seed default event hooks: brain.critical→issue.create(critical), brain.degraded→issue.create(warning). Idempotent (atomic onConflictDoNothing on workspace_id+name unique idx). Returns {created, skipped}.',
    risk: 'low',
    handler: async (ws) => {
      const { seedDefaultHooks } = await import('./r257-seed-default-hooks.js')
      return seedDefaultHooks(ws)
    },
  },
  'brain.health.alertTick': {
    description: 'R255 — manually trigger the brain.health state-change alert tick. Fires brain.degraded / brain.critical / brain.healthy via R212 event hooks ONLY on state change (no spam). Returns {prev, now, emitted}.',
    risk: 'low',
    handler: async (ws) => {
      const { tickBrainHealthAlert } = await import('./r255-brain-alert-tick.js')
      return tickBrainHealthAlert(ws)
    },
  },
  'brain.health': {
    description: 'R253 — unified workspace health snapshot: cost cap, backup freshness, applier liveness, cron presence, error counts, skill win-rate. Returns {overall: healthy|degraded|critical, ...}. Single call replaces stitching 6 ops together.',
    risk: 'low',
    handler: async (ws) => {
      const { brainHealth } = await import('./r253-brain-health.js')
      return brainHealth(ws)
    },
  },
  'brain.capabilities': {
    description: 'R326 — what Novan can do, what\'s partial, what\'s missing. Honest registry. Use this when the operator asks \"what can you do\".',
    risk: 'low',
    handler: async () => {
      const { completenessReport, completenessSummary, CAPABILITIES } = await import('./brain-completeness.js')
      return { report: completenessReport(), summary: completenessSummary(), all: CAPABILITIES }
    },
  },
  'task.honest_assess': {
    description: 'R326 — given a task description, return {verdict: can_do|partial|cannot, steps, gaps, workarounds, honestReply}. Use BEFORE claiming you\'ll do something — call this, read verdict, then either execute or quote the honestReply text.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { assessTask } = await import('./task-honest-assess.js')
      const task = String(p['task'] ?? '').trim()
      if (!task) throw new Error('task.honest_assess: task description required')
      const requiredCaps = Array.isArray(p['requiredCaps']) ? (p['requiredCaps'] as string[]) : undefined
      return assessTask({ task, ...(requiredCaps ? { requiredCaps } : {}) })
    },
  },
  // ─── R146.327 ─────────────────────────────────────────────────
  'relationship.upsert': {
    description: 'R327 #3 — register/refresh a person/business/vendor/partner in the relationship graph.',
    risk: 'low',
    handler: async (ws, p) => {
      const { relationshipUpsert } = await import('./r327-relationship-graph.js')
      return relationshipUpsert({
        workspaceId: ws, kind: String(p['kind'] ?? 'person') as 'person' | 'business' | 'vendor' | 'partner' | 'team' | 'other',
        name: String(p['name'] ?? '').trim(),
        ...(p['attrs'] ? { attrs: p['attrs'] as Record<string, unknown> } : {}),
      })
    },
  },
  'relationship.recall': {
    description: 'R327 #3 — search the relationship graph by name substring.',
    risk: 'low',
    handler: async (ws, p) => {
      const { relationshipRecall } = await import('./r327-relationship-graph.js')
      return relationshipRecall({ workspaceId: ws, query: String(p['query'] ?? ''), limit: Number(p['limit'] ?? 10) })
    },
  },
  'clarify.assess': {
    description: 'R327 #4 — given a user message, decide proceed vs ask-one-question. Returns {proceed, score, question?, missing}.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { shouldClarify } = await import('./r327-clarify.js')
      return shouldClarify(String(p['userMessage'] ?? ''))
    },
  },
  'setup.state': {
    description: 'R327 #5 — operator onboarding progress. Returns {steps, nextStep, percentDone, completed}.',
    risk: 'low',
    handler: async (ws) => {
      const { getSetupState } = await import('./r327-onboarding.js')
      return getSetupState(ws)
    },
  },
  'setup.mark': {
    description: 'R327 #5 — mark an onboarding step complete.',
    risk: 'low',
    handler: async (ws, p) => {
      const { markStep } = await import('./r327-onboarding.js')
      return markStep(ws, String(p['step'] ?? '') as 'persona' | 'firstGoal' | 'connector' | 'budget' | 'preview')
    },
  },
  'daily_routine.run': {
    description: 'R327 #6 — run the 6am daily routine (feed scan + ideas + approval triage + push notify). Idempotent: skips if already ran today.',
    risk: 'medium',
    handler: async (ws) => {
      const { runDailyRoutine } = await import('./r327-daily-routine.js')
      return runDailyRoutine(ws)
    },
  },
  'cost.forecast': {
    description: 'R327 #8 — 30-day cost projection at current burn vs cap, plus days-of-runway.',
    risk: 'low',
    handler: async (ws, p) => {
      const { costForecast } = await import('./r327-misc.js')
      return costForecast(ws, Number(p['capUsd'] ?? 5))
    },
  },
  'backup.restore_drill': {
    description: 'R327 #7 — lightweight restore drill: verify newest backup is found + schema is plausible. Returns {backupFound, schemaCheckOk, tablesFound}.',
    risk: 'low',
    handler: async () => {
      const { backupRestoreDrill } = await import('./r327-misc.js')
      return backupRestoreDrill()
    },
  },
  'email.triage': {
    description: 'R327 #10 — triage Gmail inbox. Currently returns {available:false, workarounds:[...]} if no Gmail credential. Honest about the gap.',
    risk: 'low',
    handler: async (ws, p) => {
      const { emailTriage } = await import('./r327-misc.js')
      return emailTriage({ workspaceId: ws, ...(p['maxMessages'] ? { maxMessages: Number(p['maxMessages']) } : {}) })
    },
  },
  'brain.what_did_you_do_today': {
    description: 'R327 #17 — narrative timeline of what Novan did in the last N hours (default 24). Filters noisy heartbeats. Returns {entries, byCategory, totalEvents}.',
    risk: 'low',
    handler: async (ws, p) => {
      const { whatDidYouDo } = await import('./r327-misc.js')
      return whatDidYouDo(ws, Number(p['windowHours'] ?? 24))
    },
  },
  'connector_cred.create': {
    description: 'R327 #2 — register an OAuth credential reference (vault_key only — actual secret stays in secrets_vault).',
    risk: 'high',
    handler: async (ws, p) => {
      const { connectorCredCreate } = await import('./r327-misc.js')
      return connectorCredCreate({
        workspaceId: ws,
        connectorId: String(p['connectorId'] ?? ''),
        accountLabel: String(p['accountLabel'] ?? ''),
        vaultKey: String(p['vaultKey'] ?? ''),
        scopes: Array.isArray(p['scopes']) ? p['scopes'] as string[] : [],
        ...(p['expiresAt'] ? { expiresAt: Number(p['expiresAt']) } : {}),
      })
    },
  },
  'connector_cred.list': {
    description: 'R327 #2 — list connector credentials in this workspace (never returns the secret).',
    risk: 'low',
    handler: async (ws) => {
      const { connectorCredList } = await import('./r327-misc.js')
      return connectorCredList(ws)
    },
  },
  'connector_cred.revoke': {
    description: 'R327 #2 — revoke a connector credential.',
    risk: 'high',
    handler: async (ws, p) => {
      const { connectorCredRevoke } = await import('./r327-misc.js')
      await connectorCredRevoke(ws, String(p['id'] ?? ''))
      return { ok: true }
    },
  },
  // ─── R146.332 ─────────────────────────────────────────────────
  'pod.platforms': {
    description: 'R332 — full POD ecosystem registry (Printful integrations, social publish targets, standalone PODs, payments) with cost + margin + price-tier metadata.',
    risk: 'low',
    handler: async () => {
      const { podPlatforms } = await import('./r332-pod-platforms.js')
      return podPlatforms()
    },
  },
  'pod.free_storefronts': {
    description: 'R332 — only Printful integrations with $0 monthly fee. Use NOW per operator constraint.',
    risk: 'low',
    handler: async () => {
      const { freeStorefrontsOnly } = await import('./r332-pod-platforms.js')
      return freeStorefrontsOnly()
    },
  },
  'pod.unlocked_at_mrr': {
    description: 'R332 — which Printful integrations are unlocked at the current MRR (free always; paid gated by unlockAtMrr).',
    risk: 'low',
    handler: async (_ws, p) => {
      const { unlockedAtMrr } = await import('./r332-pod-platforms.js')
      return unlockedAtMrr(Number(p['monthlyRevenueUsd'] ?? 0))
    },
  },
  'pod.highest_margin_standalone': {
    description: 'R332 — standalone POD marketplaces sorted by operator margin, filtered by customer-price tier (cheap | mid | premium).',
    risk: 'low',
    handler: async (_ws, p) => {
      const { highestMarginStandalone } = await import('./r332-pod-platforms.js')
      return highestMarginStandalone(String(p['maxPriceTier'] ?? 'mid') as 'cheap' | 'mid' | 'premium')
    },
  },

  // ─── R146.331 (#1-100) ────────────────────────────────────────
  // POD pipeline (1-10)
  'pod.first_listing':       { description: 'R331 #1 — orchestrate POD first listing (Printful + Etsy).', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-pod.js'); return m.podFirstListing({ workspaceId: ws, niche: String(p['niche'] ?? '') }) } },
  'pod.etsy_optimize':       { description: 'R331 #2 — A/B title/tag variants for an Etsy listing.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r331-pod.js'); return m.etsyOptimize({ workspaceId: ws, listingId: String(p['listingId'] ?? ''), variations: Number(p['variations'] ?? 3) }) } },
  'pod.design_library':      { description: 'R331 #3 — seed design templates for 10 niches.', risk: 'low',
    handler: async () => { const m = await import('./r331-pod.js'); return m.designLibrary() } },
  'pod.auto_price':          { description: 'R331 #4 — floor + ceiling + suggested midpoint price.', risk: 'low',
    handler: async (_ws, p) => { const m = await import('./r331-pod.js'); return m.autoPrice({ costUsd: Number(p['costUsd'] ?? 0), competitorMedianUsd: p['competitorMedianUsd'] ? Number(p['competitorMedianUsd']) : undefined, marginPct: p['marginPct'] ? Number(p['marginPct']) : undefined }) } },
  'pod.niche_picker':        { description: 'R331 #5 — niches with feasibility scoring.', risk: 'low',
    handler: async () => { const m = await import('./r331-pod.js'); return m.nichePicker() } },
  'pod.set_inventory_budget': { description: 'R331 #6 — monthly inventory budget per business.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r331-pod.js'); await m.setInventoryBudget({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), monthlyUsd: Number(p['monthlyUsd'] ?? 0), allocation: (p['allocation'] ?? {}) as Record<string, number> }); return { ok: true } } },
  'pod.review_monitor':      { description: 'R331 #7 — Etsy low-star review watcher.', risk: 'low',
    handler: async (ws) => { const m = await import('./r331-pod.js'); return m.etsyReviewMonitor({ workspaceId: ws }) } },
  'pod.shopify_path':        { description: 'R331 #8 — Shopify secondary surface plan.', risk: 'low',
    handler: async (ws) => { const m = await import('./r331-pod.js'); return m.shopifyPath({ workspaceId: ws }) } },
  'pod.record_first_sale':   { description: 'R331 #9 — record and push notification for first sale.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r331-pod.js'); return m.recordFirstSale({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), amountUsd: Number(p['amountUsd'] ?? 0), source: String(p['source'] ?? '') }) } },
  'pod.daily_revenue_digest': { description: 'R331 #10 — yesterday + 7-day trend + top business.', risk: 'low',
    handler: async (ws) => { const m = await import('./r331-pod.js'); return m.dailyRevenueDigest(ws) } },

  // Content engine (11-25)
  'content.upload_tiktok':   { description: 'R331 #11 — queue TikTok upload (requires connector).', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.uploadTikTok({ workspaceId: ws, videoUrl: String(p['videoUrl'] ?? ''), caption: String(p['caption'] ?? ''), tags: (p['tags'] ?? []) as string[] }) } },
  'content.upload_youtube':  { description: 'R331 #12 — queue YouTube Shorts upload.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.uploadYouTube({ workspaceId: ws, videoUrl: String(p['videoUrl'] ?? ''), title: String(p['title'] ?? ''), description: String(p['description'] ?? '') }) } },
  'content.upload_instagram': { description: 'R331 #13 — queue Instagram reel.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.uploadInstagram({ workspaceId: ws, videoUrl: String(p['videoUrl'] ?? ''), caption: String(p['caption'] ?? '') }) } },
  'content.upload_x':        { description: 'R331 #14 — queue X/Twitter post.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.uploadX({ workspaceId: ws, text: String(p['text'] ?? ''), mediaUrl: p['mediaUrl'] ? String(p['mediaUrl']) : undefined }) } },
  'content.upload_reddit':   { description: 'R331 #15 — queue Reddit post.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.uploadReddit({ workspaceId: ws, subreddit: String(p['subreddit'] ?? ''), title: String(p['title'] ?? ''), body: String(p['body'] ?? '') }) } },
  'content.upload_pinterest': { description: 'R331 #16 — queue Pinterest pin.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.uploadPinterest({ workspaceId: ws, imageUrl: String(p['imageUrl'] ?? ''), description: String(p['description'] ?? '') }) } },
  'content.daily_calendar':  { description: 'R331 #17 — today\'s content slots across platforms.', risk: 'low',
    handler: async (ws) => { const m = await import('./r331-content.js'); return m.dailyCalendar(ws) } },
  'content.ab_test_hooks':   { description: 'R331 #18 — N hook variants with predicted score.', risk: 'low',
    handler: async (_ws, p) => { const m = await import('./r331-content.js'); return m.abTestHooks({ product: String(p['product'] ?? ''), n: Number(p['n'] ?? 3) }) } },
  'content.repurpose':       { description: 'R331 #19 — long-form → shorts + posts.', risk: 'low',
    handler: async (_ws, p) => { const m = await import('./r331-content.js'); return m.repurpose({ longFormText: String(p['longFormText'] ?? '') }) } },
  'content.trend_hijack':    { description: 'R331 #20 — adapt current trending for niche.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.trendHijack({ workspaceId: ws, niche: String(p['niche'] ?? ''), platform: String(p['platform'] ?? 'tiktok') }) } },
  'content.comment_bot':     { description: 'R331 #21 — comment-reply bot in operator voice.', risk: 'high',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.commentReplyBot({ workspaceId: ws, platform: String(p['platform'] ?? ''), voiceSample: String(p['voiceSample'] ?? '') }) } },
  'content.dedupe_check':    { description: 'R331 #22 — has this content posted recently.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.dedupeCheck({ workspaceId: ws, contentHash: String(p['contentHash'] ?? ''), windowHours: p['windowHours'] ? Number(p['windowHours']) : undefined }) } },
  'content.get_brand_overlay': { description: 'R331 #23 — current brand overlay settings.', risk: 'low',
    handler: async (ws) => { const m = await import('./r331-content.js'); return m.getBrandOverlay(ws) } },
  'content.set_brand_overlay': { description: 'R331 #23 — set brand watermark overlay.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); await m.setBrandOverlay(ws, p as unknown as { logoUrl?: string; opacity: number; position: 'tl' | 'tr' | 'bl' | 'br' | 'center' }); return { ok: true } } },
  'content.hashtag_intel':   { description: 'R331 #24 — recommended + trending + long-tail.', risk: 'low',
    handler: async (_ws, p) => { const m = await import('./r331-content.js'); return m.hashtagIntel({ niche: String(p['niche'] ?? '') }) } },
  'content.attribution':     { description: 'R331 #25 — which posts drove which sales.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r331-content.js'); return m.attribution({ workspaceId: ws, windowDays: Number(p['windowDays'] ?? 30) }) } },

  // Audience (26-35), Monetize (36-45), Productivity (46-55), Autonomy (56-65), Scaling (66-75), Trust (76-85), Quality (86-95), Productization (96-100)
  'audience.cold_dm':        { description: 'R331 #26 — 3 cold-DM script variants.', risk: 'low',                                  handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.coldDMScript({ platform: String(p['platform'] ?? ''), goal: String(p['goal'] ?? ''), recipient: String(p['recipient'] ?? '') }) } },
  'audience.bio_optimize':   { description: 'R331 #27 — bio A/B variants.', risk: 'low',                                            handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.bioOptimize({ current: String(p['current'] ?? ''), niche: String(p['niche'] ?? '') }) } },
  'audience.lead_magnet':    { description: 'R331 #28 — lead-magnet ideas for niche.', risk: 'low',                                 handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.leadMagnet({ niche: String(p['niche'] ?? '') }) } },
  'audience.email_sequence': { description: 'R331 #29 — 4-step welcome email sequence.', risk: 'low',                               handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.emailSequence({ niche: String(p['niche'] ?? '') }) } },
  'audience.collab_partners': { description: 'R331 #30 — N collab partner suggestions.', risk: 'low',                               handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.collabPartnerList({ niche: String(p['niche'] ?? ''), count: p['count'] ? Number(p['count']) : undefined }) } },
  'audience.health':         { description: 'R331 #31 — follower velocity + engagement + churn signal.', risk: 'low',               handler: async (ws) => { const m = await import('./r331-rest.js'); return m.audienceHealth(ws) } },
  'audience.faq_response':   { description: 'R331 #32 — FAQ-style reply in brand voice.', risk: 'low',                              handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.faqResponder({ question: String(p['question'] ?? ''), brandVoice: p['brandVoice'] ? String(p['brandVoice']) : undefined }) } },
  'audience.newsletter':     { description: 'R331 #33 — newsletter automation status.', risk: 'low',                                handler: async (ws) => { const m = await import('./r331-rest.js'); return m.newsletterAutomation(ws) } },
  'audience.affiliate_finder': { description: 'R331 #34 — niche posts to drop affiliate links.', risk: 'low',                       handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.affiliateCommentFinder({ niche: String(p['niche'] ?? ''), productKeyword: String(p['productKeyword'] ?? '') }) } },
  'audience.engagement_schedule': { description: 'R331 #35 — daily engagement slot schedule.', risk: 'low',                         handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.communityEngagementScheduler({ dailyCount: Number(p['dailyCount'] ?? 10) }) } },

  'monetize.stripe_setup':   { description: 'R331 #36 — Stripe credential gate.', risk: 'low',                                      handler: async (ws) => { const m = await import('./r331-rest.js'); return m.stripeSetup({ workspaceId: ws }) } },
  'monetize.gumroad_upload': { description: 'R331 #37 — queue Gumroad product upload.', risk: 'medium',                             handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.gumroadUpload({ workspaceId: ws, productName: String(p['productName'] ?? ''), priceUsd: Number(p['priceUsd'] ?? 0) }) } },
  'monetize.affiliate_click': { description: 'R331 #38 — track affiliate link click.', risk: 'low',                                 handler: async (ws, p) => { const m = await import('./r331-rest.js'); await m.affiliateClickTrack({ workspaceId: ws, linkId: String(p['linkId'] ?? ''), source: p['source'] ? String(p['source']) : undefined }); return { ok: true } } },
  'monetize.sponsorship_pitch': { description: 'R331 #39 — pitch text + suggested rate.', risk: 'low',                              handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.sponsorshipPitch({ brand: String(p['brand'] ?? ''), niche: String(p['niche'] ?? ''), audienceSize: Number(p['audienceSize'] ?? 0) }) } },
  'monetize.pricing_experiment': { description: 'R331 #40 — 3-variant pricing test.', risk: 'low',                                  handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.pricingExperiment({ currentUsd: Number(p['currentUsd'] ?? 0), weeks: p['weeks'] ? Number(p['weeks']) : undefined }) } },
  'monetize.bundle':         { description: 'R331 #41 — suggested bundle + price.', risk: 'low',                                    handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.bundleSuggester({ products: (p['products'] ?? []) as string[] }) } },
  'monetize.cart_recovery':  { description: 'R331 #42 — queue cart-abandon email.', risk: 'low',                                    handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.cartAbandonRecovery({ workspaceId: ws, emailHash: String(p['emailHash'] ?? '') }) } },
  'monetize.upsell_seq':     { description: 'R331 #43 — post-purchase upsell sequence.', risk: 'low',                               handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.upsellSequence({ productJustBought: String(p['productJustBought'] ?? '') }) } },
  'monetize.ltv_cohort':     { description: 'R331 #44 — LTV by cohort.', risk: 'low',                                               handler: async (ws) => { const m = await import('./r331-rest.js'); return m.ltvByCohort(ws) } },
  'monetize.refund_rate':    { description: 'R331 #45 — refunds / sales rate.', risk: 'low',                                        handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.refundRate(ws, Number(p['windowDays'] ?? 30)) } },

  'productivity.what_to_work_on': { description: 'R331 #46 — top-3 priorities for now.', risk: 'low',                               handler: async (ws) => { const m = await import('./r331-rest.js'); return m.whatShouldIWorkOn(ws) } },
  'productivity.draft_replies': { description: 'R331 #47 — draft reply queue (stub until inbox wired).', risk: 'low',               handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.draftReplyQueue({ workspaceId: ws, limit: p['limit'] ? Number(p['limit']) : undefined }) } },
  'productivity.calendar_link': { description: 'R331 #48 — book-a-call link.', risk: 'low',                                         handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.calendarSlotLink({ workspaceId: ws, durationMin: Number(p['durationMin'] ?? 30) }) } },
  'productivity.meeting_brief': { description: 'R331 #49 — pre-meeting briefing.', risk: 'low',                                     handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.meetingPrepBrief({ workspaceId: ws, meetingId: String(p['meetingId'] ?? '') }) } },
  'productivity.action_items': { description: 'R331 #50 — extract action items from transcript.', risk: 'low',                      handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.actionItems({ transcript: String(p['transcript'] ?? '') }) } },
  'productivity.voice_memo': { description: 'R331 #51 — voice-memo capture status.', risk: 'low',                                   handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.voiceMemoCapture({ workspaceId: ws, audioBytes: p['audioBytes'] ? Number(p['audioBytes']) : undefined }) } },
  'productivity.kb_build':   { description: 'R331 #52 — knowledge base entry count.', risk: 'low',                                  handler: async (ws) => { const m = await import('./r331-rest.js'); return m.knowledgeBaseBuild(ws) } },
  'productivity.reading_list': { description: 'R331 #53 — reading list with summaries.', risk: 'low',                               handler: async () => { const m = await import('./r331-rest.js'); return m.readingList() } },
  'productivity.subscription_audit': { description: 'R331 #54 — paid-not-used subscriptions.', risk: 'low',                         handler: async (ws) => { const m = await import('./r331-rest.js'); return m.subscriptionAuditor(ws) } },
  'productivity.savings':    { description: 'R331 #55 — running total of bad-spend prevented.', risk: 'low',                        handler: async (ws) => { const m = await import('./r331-rest.js'); return m.savingsTracker(ws) } },

  'autonomy.approval_chain': { description: 'R331 #56 — required approval chain by risk.', risk: 'low',                             handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.approvalChain({ workspaceId: ws, risk: String(p['risk'] ?? 'low') as 'low' | 'medium' | 'high' }) } },
  'autonomy.goal_progress':  { description: 'R331 #57 — primary goal progress.', risk: 'low',                                       handler: async (ws) => { const m = await import('./r331-rest.js'); return m.goalProgress(ws) } },
  'autonomy.self_correcting': { description: 'R331 #58 — should regenerate plan.', risk: 'low',                                     handler: async (ws) => { const m = await import('./r331-rest.js'); return m.selfCorrectingPlan(ws) } },
  'autonomy.cost_degradation': { description: 'R331 #59 — degradation recommendation.', risk: 'low',                                handler: async (ws) => { const m = await import('./r331-rest.js'); return m.costAwareDegradation(ws) } },
  'autonomy.consult_mistakes': { description: 'R331 #60 — check past mistakes before an action.', risk: 'low',                      handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.consultMistakes(ws, String(p['intent'] ?? '')) } },
  'autonomy.daily_standup':  { description: 'R331 #61 — daily standup pair (yesterday + ask).', risk: 'low',                        handler: async (ws) => { const m = await import('./r331-rest.js'); return m.dailyStandup(ws) } },
  'autonomy.weekly_retro':   { description: 'R331 #62 — what worked/didn\'t/try.', risk: 'low',                                     handler: async (ws) => { const m = await import('./r331-rest.js'); return m.weeklyRetro(ws) } },
  'autonomy.board_deck':     { description: 'R331 #63 — monthly board-deck outline.', risk: 'low',                                  handler: async (ws) => { const m = await import('./r331-rest.js'); return m.boardDeck(ws) } },
  'autonomy.quarterly_okr':  { description: 'R331 #64 — quarterly OKR draft.', risk: 'low',                                         handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.quarterlyOKR({ theme: String(p['theme'] ?? '') }) } },
  'autonomy.annual_review':  { description: 'R331 #65 — year-over-year deltas.', risk: 'low',                                       handler: async (ws) => { const m = await import('./r331-rest.js'); return m.annualReview(ws) } },

  'scale.set_role':          { description: 'R331 #66 — set teammate role.', risk: 'high',                                          handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.setTeammateRole({ workspaceId: ws, teammateId: String(p['teammateId'] ?? ''), role: String(p['role'] ?? 'viewer') as 'admin' | 'editor' | 'viewer' }) } },
  'scale.delegate':          { description: 'R331 #67 — delegate approvals for op prefix.', risk: 'high',                            handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.delegateApproval({ workspaceId: ws, opPrefix: String(p['opPrefix'] ?? ''), teammateId: String(p['teammateId'] ?? '') }) } },
  'scale.sub_business':      { description: 'R331 #68 — create sub-business.', risk: 'medium',                                      handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.subBusiness({ workspaceId: ws, parentBusinessId: String(p['parentBusinessId'] ?? ''), name: String(p['name'] ?? '') }) } },
  'scale.white_label':       { description: 'R331 #69 — white-label mode (brand + logo).', risk: 'medium',                          handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.whiteLabelMode({ workspaceId: ws, brand: String(p['brand'] ?? ''), logoUrl: String(p['logoUrl'] ?? '') }) } },
  'scale.currency_convert':  { description: 'R331 #70 — USD → target currency.', risk: 'low',                                       handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.currency({ fromUsd: Number(p['fromUsd'] ?? 0), toCcy: String(p['toCcy'] ?? 'USD') as 'USD' | 'EUR' | 'GBP' | 'JPY' }) } },
  'scale.tax_by_jurisdiction': { description: 'R331 #71 — effective tax rate by jurisdiction.', risk: 'low',                        handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.taxByJurisdiction({ workspaceId: ws, jurisdiction: String(p['jurisdiction'] ?? '') }) } },
  'scale.invoice':           { description: 'R331 #72 — generate HTML invoice.', risk: 'low',                                       handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.invoiceGen({ client: String(p['client'] ?? ''), amountUsd: Number(p['amountUsd'] ?? 0), description: String(p['description'] ?? '') }) } },
  'scale.contractor_1099':   { description: 'R331 #73 — flag contractors needing 1099.', risk: 'low',                               handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.contractor1099Prep({ contractorTotals: (p['contractorTotals'] ?? []) as Array<{ name: string; totalUsd: number }> }) } },
  'scale.quarterly_tax':     { description: 'R331 #74 — quarterly tax estimate.', risk: 'low',                                       handler: async (ws) => { const m = await import('./r331-rest.js'); return m.quarterlyTaxEstimate(ws) } },
  'scale.entity_routing':    { description: 'R331 #75 — which LLC takes which revenue.', risk: 'medium',                            handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.entityRouting({ workspaceId: ws, businessId: String(p['businessId'] ?? ''), llcName: String(p['llcName'] ?? '') }) } },

  'trust.public_ledger':     { description: 'R331 #76 — what Novan published recently.', risk: 'low',                               handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.publicLedger(ws, Number(p['windowDays'] ?? 7)) } },
  'trust.disclosure_wrap':   { description: 'R331 #77 — append disclosure tags to outbound copy.', risk: 'low',                     handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.disclosureWrap({ text: String(p['text'] ?? ''), platform: String(p['platform'] ?? '') }) } },
  'trust.brand_safety':      { description: 'R331 #78 — sensitive-topic filter.', risk: 'low',                                      handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.brandSafety({ text: String(p['text'] ?? '') }) } },
  'trust.plagiarism':        { description: 'R331 #79 — plagiarism check (stub).', risk: 'low',                                     handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.plagiarismCheck({ text: String(p['text'] ?? '') }) } },
  'trust.legal_risk':        { description: 'R331 #80 — regulated-claim + professional-advice flags.', risk: 'low',                 handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.legalRiskCheck({ text: String(p['text'] ?? '') }) } },
  'trust.platform_rate_limit': { description: 'R331 #81 — remaining post quota on platform.', risk: 'low',                          handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.platformRateLimit({ workspaceId: ws, platform: String(p['platform'] ?? '') }) } },
  'trust.dmca':              { description: 'R331 #82 — queue DMCA takedown request.', risk: 'medium',                              handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.dmcaHandler({ workspaceId: ws, assetId: String(p['assetId'] ?? ''), reason: String(p['reason'] ?? '') }) } },
  'trust.autonomous_audit':  { description: 'R331 #83 — log of autonomous decisions.', risk: 'low',                                 handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.autonomousAuditTrail(ws, Number(p['windowDays'] ?? 7)) } },
  'trust.daily_report':      { description: 'R331 #84 — autonomous vs approval ratio today.', risk: 'low',                          handler: async (ws) => { const m = await import('./r331-rest.js'); return m.dailyTrustReport(ws) } },
  'trust.set_red_lines':     { description: 'R331 #85 — never-cross red lines.', risk: 'medium',                                    handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.setRedLines({ workspaceId: ws, lines: (p['lines'] ?? []) as string[] }) } },

  'quality.platform_benchmark': { description: 'R331 #86 — engagement vs niche median.', risk: 'low',                               handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.platformBenchmark({ workspaceId: ws, platform: String(p['platform'] ?? '') }) } },
  'quality.generation_evals': { description: 'R331 #87 — generation-quality fixture pass rate.', risk: 'low',                       handler: async () => { const m = await import('./r331-rest.js'); return m.generationEvals() } },
  'quality.cpm':             { description: 'R331 #88 — cost per 1k impressions.', risk: 'low',                                     handler: async (ws) => { const m = await import('./r331-rest.js'); return m.cpmTracker(ws) } },
  'quality.shadow_ban':      { description: 'R331 #89 — engagement-anomaly detector.', risk: 'low',                                 handler: async (ws, p) => { const m = await import('./r331-rest.js'); return m.shadowBanDetect({ workspaceId: ws, platform: String(p['platform'] ?? '') }) } },
  'quality.seo_optimize':    { description: 'R331 #90 — SEO score + suggestions.', risk: 'low',                                     handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.seoOptimize({ content: String(p['content'] ?? ''), keyword: String(p['keyword'] ?? '') }) } },
  'quality.image_quality':   { description: 'R331 #91 — image quality score.', risk: 'low',                                         handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.imageQuality({ width: Number(p['width'] ?? 0), height: Number(p['height'] ?? 0) }) } },
  'quality.video_quality':   { description: 'R331 #92 — video quality score (hook + length).', risk: 'low',                         handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.videoQuality({ lengthSec: Number(p['lengthSec'] ?? 0), hasHookFirst3s: Boolean(p['hasHookFirst3s']) }) } },
  'quality.audio_quality':   { description: 'R331 #93 — audio quality score.', risk: 'low',                                         handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.audioQuality({ sampleRateHz: Number(p['sampleRateHz'] ?? 0), hasBackgroundNoise: Boolean(p['hasBackgroundNoise']) }) } },
  'quality.grammar':         { description: 'R331 #94 — grammar pass + light fixes.', risk: 'low',                                  handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.grammarPass({ text: String(p['text'] ?? '') }) } },
  'quality.voice_of_customer': { description: 'R331 #95 — top themes from reviews.', risk: 'low',                                   handler: async (ws) => { const m = await import('./r331-rest.js'); return m.voiceOfCustomer(ws) } },

  'product.multi_tenant':    { description: 'R331 #96 — toggle multi-tenant mode.', risk: 'high',                                   handler: async (_ws, p) => { const m = await import('./r331-rest.js'); return m.multiTenantToggle({ enabled: Boolean(p['enabled']) }) } },
  'product.pricing_tiers':   { description: 'R331 #97 — starter/growth/scale tiers.', risk: 'low',                                  handler: async () => { const m = await import('./r331-rest.js'); return m.pricingTiers() } },
  'product.tour':            { description: 'R331 #98 — onboarding video tour outline.', risk: 'low',                               handler: async () => { const m = await import('./r331-rest.js'); return m.onboardingVideoTour() } },
  'product.roadmap':         { description: 'R331 #99 — public roadmap items.', risk: 'low',                                        handler: async () => { const m = await import('./r331-rest.js'); return m.publicRoadmap() } },
  'product.self_host_export': { description: 'R331 #100 — self-hosting instructions.', risk: 'low',                                 handler: async (ws) => { const m = await import('./r331-rest.js'); return m.selfHostExport(ws) } },

  // ─── R146.330 ─────────────────────────────────────────────────
  'revenue.dashboard':       { description: 'R330 #9 — total + monthly revenue, per-business, monthly trend.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-value.js'); return m.revenueDashboard(ws) } },
  'time_saved.counter':      { description: 'R330 #10 — minutes saved estimate by op.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); return m.timeSavedCounter(ws, Number(p['windowDays'] ?? 30)) } },
  'content.shipped':         { description: 'R330 #11 — pieces of content shipped by type/platform.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); return m.contentShippedCount(ws, Number(p['windowDays'] ?? 30)) } },
  'weekly.recap':            { description: 'R330 #12 — revenue + time-saved + content + cost narrative.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-value.js'); return m.weeklyRecap(ws) } },
  'business.roi':            { description: 'R330 #13 — per-business revenue vs AI cost vs operator-time estimate.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-value.js'); return m.businessROI(ws) } },
  'cost.detail':             { description: 'R330 #14 — line-item AI spend (ts/provider/model/op/cost).', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); return m.costDetail(ws, Number(p['windowDays'] ?? 30)) } },
  'novan.pause':             { description: 'R330 #15 — flip ALL kill_switches to halt autonomous behavior.', risk: 'high',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); return m.pauseNovan(ws, String(p['reason'] ?? 'operator pause')) } },
  'novan.resume':            { description: 'R330 #15 — clear ALL kill_switches.', risk: 'high',
    handler: async (ws) => { const m = await import('./r330-value.js'); return m.resumeNovan(ws) } },
  'workspace.clone':         { description: 'R330 #16 — copy workspace_memory into a new workspaceId for sandbox.', risk: 'high',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); return m.workspaceClone(ws, String(p['newWorkspaceId'] ?? '')) } },
  'op.set_risk':             { description: 'R330 #17 — operator-defined risk override for an op.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); await m.setOpRisk(ws, String(p['op'] ?? ''), String(p['risk'] ?? 'low') as 'low' | 'medium' | 'high'); return { ok: true } } },
  'budget.set_breakdown':    { description: 'R330 #18 — partition cap across buckets {bucket: dollars}.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); await m.setBudgetBreakdown(ws, (p['buckets'] ?? {}) as Record<string, number>); return { ok: true } } },
  'budget.get_breakdown':    { description: 'R330 #18 — return current bucket allocation.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-value.js'); return m.getBudgetBreakdown(ws) } },
  'daily_routine.override':  { description: 'R330 #19 — set skip/only lists for the next daily_routine tick.', risk: 'medium',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); await m.dailyRoutineOverride(ws, p as { skip?: string[]; only?: string[] }); return { ok: true } } },
  'data.purge':              { description: 'R330 #20 — DELETE all workspace data; requires confirm="PURGE:<ws>". Irreversible.', risk: 'high',
    handler: async (ws, p) => { const m = await import('./r330-value.js'); return m.dataPurge(ws, String(p['confirm'] ?? '')) } },

  'op.browse':               { description: 'R330 #21 — list ops with usage stats, filter by search/risk, sort by name/usage/recent.', risk: 'low',
    handler: async (_ws, p) => { const m = await import('./r330-discovery.js'); return m.opBrowse({ search: p['search'] ? String(p['search']) : undefined, risk: p['risk'] ? String(p['risk']) : undefined, sortBy: (p['sortBy'] as 'name' | 'usage' | 'recent') ?? 'name' }) } },
  'op.usage_snapshot':       { description: 'R330 #22 — in-memory op-call frequency snapshot.', risk: 'low',
    handler: async () => { const m = await import('./r330-discovery.js'); return m.opUsageSnapshot() } },
  'op.suggest':              { description: 'R330 #24 — heuristic op suggestions from a user message.', risk: 'low',
    handler: async (_ws, p) => { const m = await import('./r330-discovery.js'); return m.suggestOps(String(p['userMessage'] ?? '')) } },

  'novan.about_me':          { description: 'R330 #47 — narrative self-description: identity + capabilities + recent changes + gaps.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-discovery.js'); return m.aboutMe(ws) } },
  'persona.drift':           { description: 'R330 #48 — detect operator-energy drift from persona default.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-discovery.js'); return m.personaDrift(ws) } },
  'mistake.record':          { description: 'R330 #49 — record a "do not do this again" memory tier-3 with high importance.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-discovery.js'); return m.recordMistake({ workspaceId: ws, what: String(p['what'] ?? ''), correction: String(p['correction'] ?? '') }) } },
  'mistake.list':            { description: 'R330 #49 — list past corrections.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-discovery.js'); return m.listMistakes(ws, Number(p['limit'] ?? 50)) } },
  'reply.rate':              { description: 'R330 #50 — record operator rating on a reply (up/down/skip).', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-discovery.js'); return m.recordReplyRating({ workspaceId: ws, conversationId: p['conversationId'] ? String(p['conversationId']) : undefined, messageId: p['messageId'] ? String(p['messageId']) : undefined, rating: String(p['rating'] ?? 'skip') as 'up' | 'down' | 'skip', comment: p['comment'] ? String(p['comment']) : undefined }) } },
  'reply.rating_stats':      { description: 'R330 #50 — aggregated satisfaction rate over window.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-discovery.js'); return m.ratingStats(ws, Number(p['windowDays'] ?? 30)) } },

  'demo.trending_scripts':   { description: 'R330 #30 — plan: pull trending TikToks → draft scripts.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-demos.js'); return m.demoTrendingScripts({ workspaceId: ws, niche: String(p['niche'] ?? '') }) } },
  'demo.inbox_triage':       { description: 'R330 #31 — plan: read N emails → group → draft templates.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-demos.js'); return m.demoInboxTriage({ workspaceId: ws, maxMessages: Number(p['maxMessages'] ?? 50) }) } },
  'demo.landing_page':       { description: 'R330 #32 — plan: 3 landing variations + split test.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-demos.js'); return m.demoLandingPage({ workspaceId: ws, product: String(p['product'] ?? ''), variations: Number(p['variations'] ?? 3) }) } },
  'demo.competitor_watcher': { description: 'R330 #33 — plan: daily price scrape + diff alert.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-demos.js'); return m.demoCompetitorWatcher({ workspaceId: ws, competitorUrls: (p['urls'] ?? []) as string[] }) } },
  'demo.dm_reply_batch':     { description: 'R330 #34 — plan: read unanswered DMs + draft in operator voice.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-demos.js'); return m.demoDMReplyBatch({ workspaceId: ws, platform: String(p['platform'] ?? 'tiktok'), max: Number(p['max'] ?? 10) }) } },

  'all_providers.probe':     { description: 'R330 #26 — HEAD-probe Anthropic + OpenAI + Gemini to confirm fallback chain.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-resilience.js'); return m.allProvidersDownTest(ws) } },
  'pg.graceful_probe':       { description: 'R330 #27 — confirm Postgres responds; surface query latency.', risk: 'low',
    handler: async () => { const m = await import('./r330-resilience.js'); return m.pgGracefulProbe() } },
  'disk.usage':              { description: 'R330 #28 — disk-usage info (currently honest "container can\'t see host").', risk: 'low',
    handler: async () => { const m = await import('./r330-resilience.js'); return m.diskUsage() } },
  'soak.signal':             { description: 'R330 #29 — uptime + memory + restart recommendation.', risk: 'low',
    handler: async () => { const m = await import('./r330-resilience.js'); return m.soakSignal() } },
  'pentest.sketch':          { description: 'R330 #35 — list of pentest probes to run from outside loopback.', risk: 'low',
    handler: async () => { const m = await import('./r330-resilience.js'); return m.externalPentestSketch() } },
  'chat.latency_p95':        { description: 'R330 #39 — p50/p95/p99 latency on chat turns from in-memory sample.', risk: 'low',
    handler: async () => { const m = await import('./r330-resilience.js'); return m.latencyP95() } },
  'retention.first_day':     { description: 'R330 #40 — did the operator return after first session.', risk: 'low',
    handler: async (ws) => { const m = await import('./r330-resilience.js'); return m.firstDayRetention(ws) } },
  'cost.per_task':           { description: 'R330 #41 — avg $ per completed brain_task_execution.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-resilience.js'); return m.costPerTask(ws, Number(p['windowDays'] ?? 30)) } },
  'effectiveness.metric':    { description: 'R330 #42 — request → result rate + avg latency.', risk: 'low',
    handler: async (ws, p) => { const m = await import('./r330-resilience.js'); return m.effectivenessMetric(ws, Number(p['windowDays'] ?? 7)) } },

  // ─── R146.329 ─────────────────────────────────────────────────
  'cost.cap_enforcement_check': {
    description: 'R329 #4 — verify spend tracking, kill-switch presence, and surface gaps in the budget enforcement chain.',
    risk: 'low',
    handler: async (ws) => {
      const { costCapEnforcementCheck } = await import('./r329-extras.js')
      return costCapEnforcementCheck(ws)
    },
  },
  'workflow.attach_business': {
    description: 'R329 #7 — set workflow_runs.metadata.businessId so cost.by_business sees real numbers.',
    risk: 'medium',
    handler: async (_ws, p) => {
      const { attachWorkflowToBusiness } = await import('./r329-extras.js')
      return attachWorkflowToBusiness(String(p['workflowRunId'] ?? ''), String(p['businessId'] ?? ''))
    },
  },
  'export.all': {
    description: 'R329 #9 — single JSON blob of workspace data (memory + relationships + businesses + earnings + setup + clarify + 30d events).',
    risk: 'low',
    handler: async (ws) => {
      const { exportAll } = await import('./r329-extras.js')
      return exportAll(ws)
    },
  },
  'memory.promote_if_important': {
    description: 'R329 #10 — surface importance check on a user message (does it look like a commitment/fact worth remembering).',
    risk: 'low',
    handler: async (ws, p) => {
      const { promoteIfImportant } = await import('./r329-extras.js')
      return promoteIfImportant(ws, String(p['userMessage'] ?? ''))
    },
  },
  'browser.approval_token': {
    description: 'R329 #15 — generate a signed approval token for (domain, path-prefix) scope. Pass token to browser.action.',
    risk: 'low',
    handler: async (_ws, p) => {
      const { browserApprovalKey, signBrowserApproval } = await import('./r329-extras.js')
      const url = String(p['url'] ?? '')
      const depth = Number(p['depth'] ?? 1)
      const key = browserApprovalKey(url, depth)
      return { key, token: signBrowserApproval(key) }
    },
  },

  // ─── R146.328 ─────────────────────────────────────────────────
  'cost.by_business': {
    description: 'R328 #14 — per-business cost rollup over a window. Joins ai_usage → workflow_runs → businessId.',
    risk: 'low',
    handler: async (ws, p) => {
      const { costByBusiness } = await import('./r328-extras.js')
      return costByBusiness(ws, Number(p['windowDays'] ?? 30))
    },
  },
  'chat.failover_test': {
    description: 'R328 #15 — exercise the LLM provider fallback chain (Anthropic → OpenAI → Gemini). Catches silent fallback breakage.',
    risk: 'low',
    handler: async (ws) => {
      const { chatFailoverTest } = await import('./r328-extras.js')
      return chatFailoverTest(ws)
    },
  },
  'recap.summarize': {
    description: 'R328 #10 — narrative summary of the last N hours (prose + bullets).',
    risk: 'low',
    handler: async (ws, p) => {
      const { summarizeTimeline } = await import('./r328-extras.js')
      return summarizeTimeline(ws, Number(p['windowHours'] ?? 24))
    },
  },
  'clarify.outcomes': {
    description: 'R328 #11 — clarify question resolve-rate. Tells you if the heuristic is asking useful questions.',
    risk: 'low',
    handler: async (ws, p) => {
      const { clarifyOutcomes } = await import('./r328-extras.js')
      return clarifyOutcomes(ws, Number(p['windowDays'] ?? 14))
    },
  },
  'persona.preference': {
    description: 'R328 #12 — learned operator energy preference (terse/warm/analytical) and turn count.',
    risk: 'low',
    handler: async (ws) => {
      const { getPersonaPreference } = await import('./r328-extras.js')
      return getPersonaPreference(ws)
    },
  },
  'calendar.upcoming': {
    description: 'R328 #20 — upcoming calendar events from the connected Google Calendar.',
    risk: 'low',
    handler: async (ws, p) => {
      const { upcomingEvents } = await import('./r328-calendar.js')
      return upcomingEvents(ws, Number(p['windowHours'] ?? 24))
    },
  },
  'browser.action': {
    description: 'R327 #1 — request a browser action (fill/click/submit/wait_for) via the worker. First call per domain returns {needsApproval:true, approvalKey}; re-call with that token to authorize.',
    risk: 'high',
    handler: async (ws, p) => {
      const { browserAction } = await import('./r327-misc.js')
      return browserAction({
        workspaceId: ws,
        url: String(p['url'] ?? ''),
        action: String(p['action'] ?? '') as 'fill' | 'click' | 'submit' | 'wait_for',
        ...(p['selector'] ? { selector: String(p['selector']) } : {}),
        ...(p['value']    ? { value:    String(p['value']) }    : {}),
        ...(p['approvalToken'] ? { approvalToken: String(p['approvalToken']) } : {}),
      })
    },
  },
  'retention.sweep': {
    description: 'R276 — manually trigger the daily retention sweep (external_knowledge >30d, platform_smoke_runs >14d). Returns {ek, sr} row counts deleted. Idempotent.',
    risk: 'low',
    handler: async () => {
      const { runRetentionSweeps } = await import('./r276-retention-sweeps.js')
      return runRetentionSweeps()
    },
  },
  'memory.kv.decay': {
    description: 'R252 — run the workspace_memory decay sweep now (normally daily). Returns {decayed, pruned} row counts. Idempotent within a 7-day window per row.',
    risk: 'low',
    handler: async () => {
      const { runMemoryDecay } = await import('./r252-memory-decay.js')
      return runMemoryDecay()
    },
  },
  'backup.health': {
    description: 'R218 — newest *.sql.gz freshness in /backups (or BACKUP_DIR). Returns {dir, newestFilename, ageHours, status} where status ∈ fresh|stale|missing|unreachable.',
    risk: 'low',
    handler: async () => {
      const { backupHealth } = await import('./r218-backup-health.js')
      return backupHealth()
    },
  },
  'workflows.seedStarterPack': {
    description: 'R234 — seed 3 starter workflows (health-sweep, skill-audit, memory-condense). Operator can run via wf.run after.',
    risk: 'low',
    handler: async (ws) => {
      const { seedStarterWorkflows } = await import('./r234-starter-workflows.js')
      return seedStarterWorkflows(ws)
    },
  },
  'skills.seedStarterPack': {
    description: 'R217 — seed 8 starter skills (platform-status-check, cron-health-triage, cost-investigation, self-dev-review, memory-search, capability-discovery, event-pattern-analysis, workflow-author). Idempotent.',
    risk: 'low',
    handler: async (ws) => {
      const { seedStarterPack } = await import('./r217-starter-pack.js')
      return seedStarterPack(ws)
    },
  },

  // ─── R146.211 Workspace memory + chapters ───────────────────────
  'memory.remember': {
    description: 'Store a memory key→value with optional scope + importance(0-100). Params: { key, value, scope?, importance? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { memoryRemember } = await import('./r211-workplace.js')
      await memoryRemember(ws, params as { key: string; value: string; scope?: string; importance?: number })
      return { ok: true }
    },
  },
  'memory.kv.recall': {
    description: 'Recall R211 workspace KV memories, sorted by importance. Params: { scope?, limit? }. (Semantic embedding recall is `memory.recall`.)',
    risk: 'low',
    handler: async (ws, params) => {
      const { memoryRecall } = await import('./r211-workplace.js')
      const p = params as { scope?: string; limit?: number }
      return memoryRecall(ws, p.scope, p.limit)
    },
  },
  'memory.forget': {
    description: 'Delete a memory by key. Params: { key }',
    risk: 'low',
    handler: async (ws, params) => {
      const { memoryForget } = await import('./r211-workplace.js')
      await memoryForget(ws, (params as { key: string }).key)
      return { ok: true }
    },
  },
  'chapter.mark': {
    description: 'Add a chapter marker on the current conversation. Params: { title, summary?, conversationId?, messageAnchorId? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { chapterMark } = await import('./r211-workplace.js')
      return chapterMark(ws, params as { title: string; summary?: string; conversationId?: string; messageAnchorId?: string })
    },
  },
  'chapter.list': {
    description: 'List chapters for a conversation (or workspace). Params: { conversationId?, limit? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { chapterList } = await import('./r211-workplace.js')
      const p = params as { conversationId?: string; limit?: number }
      return chapterList(ws, p.conversationId, p.limit)
    },
  },

  // ─── R146.212 Hooks + NL schedules ──────────────────────────────
  'hook.create': {
    description: 'Subscribe an op to an event pattern (e.g. "feed.poll_failed" or "cron.*"). Params: { name, eventPattern, opName, opParams? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { hookCreate } = await import('./r211-workplace.js')
      return hookCreate(ws, params as { name: string; eventPattern: string; opName: string; opParams?: Record<string, unknown> })
    },
  },
  'hook.list': {
    description: 'List event hooks for the workspace.',
    risk: 'low',
    handler: async (ws) => {
      const { hookList } = await import('./r211-workplace.js')
      return hookList(ws)
    },
  },
  'hook.setEnabled': {
    description: 'Enable/disable a hook by name. Params: { name, enabled }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { hookSetEnabled } = await import('./r211-workplace.js')
      const p = params as { name: string; enabled: boolean }
      await hookSetEnabled(ws, p.name, p.enabled)
      return { ok: true }
    },
  },
  'schedule.nl.create': {
    description: 'Create an NL-described recurring schedule. Params: { description, opName, opParams? } (e.g. description="daily at 09:00")',
    risk: 'medium',
    handler: async (ws, params) => {
      const { scheduleCreate } = await import('./r211-workplace.js')
      return scheduleCreate(ws, params as { description: string; opName: string; opParams?: Record<string, unknown> })
    },
  },
  'schedule.nl.list': {
    description: 'List NL schedules for the workspace.',
    risk: 'low',
    handler: async (ws) => {
      const { scheduleList } = await import('./r211-workplace.js')
      return scheduleList(ws)
    },
  },

  // ─── R146.213 Spawn-task chips + operator questions ─────────────
  'spawnTask.create': {
    description: 'Flag a side-task for later dispatch. Params: { title, tldr?, prompt }',
    risk: 'low',
    handler: async (ws, params) => {
      const { spawnTaskCreate } = await import('./r211-workplace.js')
      return spawnTaskCreate(ws, params as { title: string; tldr?: string; prompt: string })
    },
  },
  'spawnTask.list': {
    description: 'List spawn-task chips. Params: { status? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { spawnTaskList } = await import('./r211-workplace.js')
      return spawnTaskList(ws, (params as { status?: string }).status)
    },
  },
  'spawnTask.dismiss': {
    description: 'Dismiss a spawn task. Params: { id }',
    risk: 'low',
    handler: async (ws, params) => {
      const { spawnTaskDismiss } = await import('./r211-workplace.js')
      await spawnTaskDismiss(ws, (params as { id: string }).id)
      return { ok: true }
    },
  },
  'operator.ask': {
    description: 'Ask the operator a structured question (2-4 options). Params: { question, options:[{label,description?}], multiSelect?, context? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { operatorAsk } = await import('./r211-workplace.js')
      return operatorAsk(ws, params as { question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean; context?: string })
    },
  },
  'operator.answer': {
    description: 'Submit an answer to a pending question. Params: { id, answer }',
    risk: 'low',
    handler: async (ws, params) => {
      const { operatorAnswer } = await import('./r211-workplace.js')
      const p = params as { id: string; answer: unknown }
      await operatorAnswer(ws, p.id, p.answer)
      return { ok: true }
    },
  },
  'operator.pending': {
    description: 'List pending operator questions.',
    risk: 'low',
    handler: async (ws) => {
      const { operatorQuestionsPending } = await import('./r211-workplace.js')
      return operatorQuestionsPending(ws)
    },
  },

  // ─── R146.214 MCP connector marketplace ─────────────────────────
  'mcp.register': {
    description: 'Register an MCP-style external connector in the R214 marketplace. Params: { name, category, description?, endpointUrl?, authKind?, meta? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { connectorRegister } = await import('./r211-workplace.js')
      return connectorRegister(ws, params as { name: string; category: string; description?: string; endpointUrl?: string; authKind?: string; meta?: Record<string, unknown> })
    },
  },
  'mcp.list': {
    description: 'List registered MCP marketplace connectors. (Legacy R141 connectors are `connector.list`.)',
    risk: 'low',
    handler: async (ws) => {
      const { connectorList } = await import('./r211-workplace.js')
      return connectorList(ws)
    },
  },
  'mcp.set': {
    description: 'Toggle installed/enabled on an MCP marketplace connector. Params: { name, installed?, enabled? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { connectorSet } = await import('./r211-workplace.js')
      const p = params as { name: string; installed?: boolean; enabled?: boolean }
      await connectorSet(ws, p.name, { ...(p.installed !== undefined ? { installed: p.installed } : {}),
                                       ...(p.enabled   !== undefined ? { enabled:   p.enabled   } : {}) })
      return { ok: true }
    },
  },
  'workplace.counts': {
    description: 'Aggregate R211-R214 counts for platform.status.',
    risk: 'low',
    handler: async (ws) => {
      const { workplaceCounts } = await import('./r211-workplace.js')
      return workplaceCounts(ws)
    },
  },

  // ─── R146.215 Brain agentic loop ────────────────────────────────
  // ─── R146.216 — 10× routing/diversity/learning ─────────────────
  'routing.healthCheck': {
    description: 'R216 — show current provider chains per task type with health-aware ordering.',
    risk: 'low',
    handler: async () => {
      const { routingHealthSnapshot } = await import('./r216-routing.js')
      return routingHealthSnapshot()
    },
  },
  'routing.diverseProviders': {
    description: 'R216 — return N healthy, distinct providers for adversarial voters. Params: { n, task? }',
    risk: 'low',
    handler: async (_ws, params) => {
      const { diverseProviders } = await import('./r216-routing.js')
      const p = params as { n: number; task?: string }
      const task = (p.task ?? 'adversarial') as Parameters<typeof diverseProviders>[1]
      return { providers: await diverseProviders(p.n, task) }
    },
  },
  'cron.presence.check': {
    description: 'R245 — scan EXPECTED cron event types, return {missing, issuesOpened}. Opens issues for crons silent >2× interval. Cron-driven every 5min.',
    risk: 'low',
    handler: async () => {
      const { checkCronPresence } = await import('./r245-cron-presence-watch.js')
      return checkCronPresence()
    },
  },
  'skill.evolve': {
    description: 'R243 — auto-rewrite instructions of skills with low win rate (≥10 uses, <40% overall AND >60% recent losses, 24h cooldown). Resets wins/uses to give the new prompt a fresh bandit run. Returns {evolved, candidates, details}.',
    risk: 'medium',
    handler: async (ws) => {
      const { evolveLosingSkills } = await import('./r243-skill-evolution.js')
      return evolveLosingSkills(ws)
    },
  },
  'skill.thompsonPick': {
    description: 'R216 — sample a skill via Thompson sampling (Beta(wins+1, losses+1)). Params: { candidates? }',
    risk: 'low',
    handler: async (ws, params) => {
      const { thompsonPickSkill } = await import('./r216-routing.js')
      const p = params as { candidates?: string[] }
      return { name: await thompsonPickSkill(ws, p.candidates) }
    },
  },

  'brain.loop.run': {
    description: 'Run the R215 agentic chat loop. Auto-picks skill, runs low-risk ops inline up to maxSteps, writes salient memories, marks chapter on topic shift. Params: { messages:[{role,content}], conversationId?, maxSteps?, autoSkill?, autoMemory?, autoChapter? }',
    risk: 'medium',
    handler: async (ws, params) => {
      const { runBrainLoopCollect } = await import('./r215-brain-loop.js')
      const p = params as { messages: Array<{ role: 'system'|'user'|'assistant'; content: string }>; conversationId?: string; maxSteps?: number; autoSkill?: boolean; autoMemory?: boolean; autoChapter?: boolean }
      return runBrainLoopCollect(ws, p.messages, {
        ...(p.conversationId !== undefined ? { conversationId: p.conversationId } : {}),
        ...(p.maxSteps       !== undefined ? { maxSteps:       p.maxSteps       } : {}),
        ...(p.autoSkill      !== undefined ? { autoSkill:      p.autoSkill      } : {}),
        ...(p.autoMemory     !== undefined ? { autoMemory:     p.autoMemory     } : {}),
        ...(p.autoChapter    !== undefined ? { autoChapter:    p.autoChapter    } : {}),
      })
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
  // R359: local-agent ops bypass classifier when operator-provenance + risk=low.
  // The external URLs they pass (cyzorcreations.gumroad.com/...) are the operator's
  // OWN storefront, not untrusted page-derived input.
  'upload_queue.next', 'upload_queue.stats', 'upload_queue.mark_uploaded',
  'agent.heartbeat', 'agent.report_event', 'agent.report_failure',
  'account.birthdays', 'design.get',
  'selector.improve', 'selector.outcome', 'selector.stored',
  'sales.sync_gumroad', 'sales.last_tier_unlock', 'winner.generate_variants',
  'sales.record', 'sales.cross_platform_mrr', 'capability.self_test',
  'listing.record_upload', 'listing.record_sale', 'listing.best_template', 'listing.rankings',
  'pacing.check_or_acquire', 'pacing.snapshot', 'pacing.auto_loosen', 'daily_cron.run', 'next_actions.list', 'next_actions.push', 'failures.cluster', 'variants.generate_for_design', 'queue.stuck',
  'pinterest.enqueue', 'pinterest.next', 'pinterest.mark_posted',
  'pinterest.mark_failed', 'pinterest.stats', 'pinterest.bulk_load',
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
        // R333 — capability mirror + provider health ops. Descriptions
        // mention 'bank/SSN' as illustrative blockedBy hard-policy fields,
        // which legitimately surface to operator.
        'capability.list', 'capability.gaps',
        'capability.parity_report', 'capability.next_target',
        'provider.health.probe_all', 'provider.health.snapshot',
        'privacy.check_submit', 'brand.dba_propagation_plan',
        'art.public_domain_fetch', 'decide.image_gen_fallback',
        'decide.return_address', 'lesson.applicable_for',
        'clarify.score_ambiguity', 'report.revenue_by_business',
        'report.capability_parity', 'memory.recall',
        'policy.check_action', 'confidence.score_op',
        'platform.state_probe', 'closer.tick', 'platform.poll_all',
        'verify.claim', 'review.source',
        'skill.list', 'skill.rank_for_request', 'mcp.plan_invocation',
        'prestaged.list', 'pod.account_kit',
        'pod.revenue_projection', 'pod.portfolio_plan',
        'gumroad.whoami', 'gumroad.list_products', 'gumroad.publish_first_three',
        'publish.mechanism_report', 'publish.route_for_platform', 'publish.list_ready',
        'design.generate_batch', 'design.suggest_subjects', 'design.list', 'design.get',
        'listing.generate', 'listing.generate_multi',
        'upload_queue.add', 'upload_queue.next', 'upload_queue.stats', 'upload_queue.mark_uploaded',
        'agent.heartbeat', 'agent.report_event', 'agent.report_failure', 'account.birthdays',
        'selector.improve', 'selector.outcome', 'selector.stored',
        'sales.sync_gumroad', 'sales.last_tier_unlock', 'winner.generate_variants',
        'sales.record', 'sales.cross_platform_mrr', 'capability.self_test',
        'listing.record_upload', 'listing.record_sale', 'listing.best_template', 'listing.rankings',
        'pacing.check_or_acquire', 'pacing.snapshot', 'pacing.auto_loosen', 'daily_cron.run', 'next_actions.list', 'next_actions.push', 'failures.cluster', 'variants.generate_for_design', 'queue.stuck',
        'pinterest.enqueue', 'pinterest.next', 'pinterest.mark_posted',
        'pinterest.mark_failed', 'pinterest.stats', 'pinterest.bulk_load',
        'briefing.daily_uploads', 'briefing.velocity_status',
        'goal.ladder', 'goal.classify_tier', 'goal.business_status',
        'trends.list_all', 'trends.pick_batch', 'trends.run_pipeline',
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
