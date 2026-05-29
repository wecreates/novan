/**
 * capability-gap-detector.ts — Capability registry + presence detector.
 *
 * 30 named capabilities spanning the platform. For each, the detector
 * checks real signals (service file, schema table, route prefix,
 * recent events) and computes a maturity bucket. Output is a structured
 * gap list — no auto-build, no fake "self-built" claims.
 *
 * Build-vs-buy scoring is a transparent matrix per capability, not
 * fabricated by a model.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname }               from 'node:path'
import { fileURLToPath }               from 'node:url'
import { db }                          from '../db/client.js'
import { events }                      from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICES_DIR = HERE   // same dir as this file
const ROUTES_DIR   = join(HERE, '..', 'routes')
// apps/api/src/services -> apps/web/src
const WEB_SRC_DIR  = join(HERE, '..', '..', '..', '..', 'web', 'src')

export type CapabilityDimension =
  | 'engineering' | 'security' | 'image_generation' | 'research'
  | 'memory' | 'ui_ux' | 'infrastructure' | 'provider_routing'
  | 'runtime_stability' | 'agent_orchestration' | 'business_operations'

export type Maturity = 'missing' | 'scaffolded' | 'basic' | 'healthy' | 'mature'

export interface CapabilityDef {
  id:           string
  dimension:    CapabilityDimension
  title:        string
  description:  string
  signals: {
    serviceFile?: string    // expected file under services/
    routeFile?:   string    // expected file under routes/
    webFiles?:    string[]  // expected files under apps/web/src/ (any-match)
    eventPrefix?: string    // expected event type prefix
    minEventsLastWeek?: number
  }
  buildVsBuy: {
    costToBuild:    number  // 0..1 (1 = expensive)
    speedToBuy:     number  // 0..1 (1 = fast)
    qualityIfBuilt: number  // 0..1
    securityIfBuilt: number // 0..1 (1 = better than buying)
    vendorLockRisk: number  // 0..1 (1 = high)
    runtimeRiskIfBuilt: number // 0..1
    notes: string
  }
}

// ─── Capability registry (hand-curated, transparent) ────────────────────────

export const CAPABILITY_REGISTRY: CapabilityDef[] = [
  // Engineering
  { id: 'patch_executor', dimension: 'engineering', title: 'Patch executor', description: 'Apply file diffs with rollback safety',
    signals: { serviceFile: 'patch-executor.ts', eventPrefix: 'patch.' },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.1, qualityIfBuilt: 0.9, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'Always build internally — touches your own code' } },
  { id: 'verification_engine', dimension: 'engineering', title: 'Verification engine', description: 'Validate patches via typecheck/lint/tests',
    signals: { serviceFile: 'verification-engine.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.2, qualityIfBuilt: 0.9, securityIfBuilt: 0.9, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.3, notes: 'Build — depends on local toolchain' } },
  { id: 'autonomous_orchestrator', dimension: 'engineering', title: 'Autonomous orchestrator', description: 'Drive multi-step autonomous runs',
    signals: { serviceFile: 'autonomous-orchestrator.ts', eventPrefix: 'orchestrator.' },
    buildVsBuy: { costToBuild: 0.5, speedToBuy: 0.4, qualityIfBuilt: 0.85, securityIfBuilt: 0.95, vendorLockRisk: 0.6, runtimeRiskIfBuilt: 0.4, notes: 'Build — core control plane' } },

  // Security
  { id: 'governance_core', dimension: 'security', title: 'Governance core', description: 'Hard boundary for autonomous actions',
    signals: { serviceFile: 'governance-core.ts', eventPrefix: 'governance.' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.1, qualityIfBuilt: 0.95, securityIfBuilt: 1.0, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'MUST build — security boundary cannot be outsourced' } },
  { id: 'secrets_vault', dimension: 'security', title: 'Secrets vault', description: 'AES-256-GCM at-rest encryption',
    signals: { serviceFile: 'secrets-vault.ts' },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.8, qualityIfBuilt: 0.85, securityIfBuilt: 0.85, vendorLockRisk: 0.5, runtimeRiskIfBuilt: 0.2, notes: 'Hybrid OK — internal vault for low-stakes, AWS KMS for high-stakes when needed' } },
  { id: 'risk_classifier', dimension: 'security', title: 'Risk classifier', description: 'Score risk of patches/operations',
    signals: { serviceFile: 'risk-classifier.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.2, qualityIfBuilt: 0.85, securityIfBuilt: 0.9, vendorLockRisk: 0.2, runtimeRiskIfBuilt: 0.3, notes: 'Build — domain-specific' } },
  { id: 'red_team_runtime', dimension: 'security', title: 'Red team runtime', description: 'Adversarial testing harness',
    signals: { serviceFile: 'security-team.ts', eventPrefix: 'red_team.' },
    buildVsBuy: { costToBuild: 0.6, speedToBuy: 0.5, qualityIfBuilt: 0.7, securityIfBuilt: 0.95, vendorLockRisk: 0.3, runtimeRiskIfBuilt: 0.5, notes: 'Build, but seed with public pentest frameworks' } },

  // Image generation
  { id: 'image_generation', dimension: 'image_generation', title: 'Image generation', description: 'Text → image via provider router',
    signals: { serviceFile: 'image-generator.ts', eventPrefix: 'image.' },
    buildVsBuy: { costToBuild: 0.95, speedToBuy: 0.95, qualityIfBuilt: 0.4, securityIfBuilt: 0.7, vendorLockRisk: 0.7, runtimeRiskIfBuilt: 0.95, notes: 'BUY — training own image model needs GPUs + dataset. Route through providers; consider internal fine-tune later.' } },
  { id: 'image_studio', dimension: 'image_generation', title: 'Image Studio UI', description: 'Operator workspace for generation',
    signals: { routeFile: 'image-studio.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.5, qualityIfBuilt: 0.9, securityIfBuilt: 0.9, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — UX is differentiator' } },
  { id: 'image_router', dimension: 'image_generation', title: 'Smart image router', description: 'Provider selection by cost/quality/health',
    signals: { serviceFile: 'image-router.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.2, qualityIfBuilt: 0.85, securityIfBuilt: 0.9, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'Build — routing logic is operator-specific' } },
  { id: 'private_image_model', dimension: 'image_generation', title: 'Private image model endpoint', description: 'Self-hosted fine-tuned model serving',
    signals: { eventPrefix: 'private_model.' },
    buildVsBuy: { costToBuild: 0.95, speedToBuy: 0.6, qualityIfBuilt: 0.6, securityIfBuilt: 0.85, vendorLockRisk: 0.4, runtimeRiskIfBuilt: 0.85, notes: 'Defer — needs GPU infra + brand dataset. Provider-backed until then. NEVER claim self-built when calling Replicate/etc.' } },

  // Research
  { id: 'research_engine', dimension: 'research', title: 'Research engine', description: 'Topic → findings pipeline',
    signals: { serviceFile: 'research-engine.ts', eventPrefix: 'research.' },
    buildVsBuy: { costToBuild: 0.4, speedToBuy: 0.5, qualityIfBuilt: 0.8, securityIfBuilt: 0.9, vendorLockRisk: 0.3, runtimeRiskIfBuilt: 0.3, notes: 'Build — orchestrates external search + summarisation' } },
  { id: 'web_search_provider', dimension: 'research', title: 'Web search provider', description: 'Tavily/Serper/Brave adapter',
    signals: { serviceFile: 'search-providers.ts' },
    buildVsBuy: { costToBuild: 0.9, speedToBuy: 0.95, qualityIfBuilt: 0.3, securityIfBuilt: 0.5, vendorLockRisk: 0.6, runtimeRiskIfBuilt: 0.8, notes: 'BUY — running a search index is years of work' } },
  { id: 'js_rendering_fetcher', dimension: 'research', title: 'JS-rendering fetcher', description: 'Playwright-backed crawler for SPAs',
    signals: { serviceFile: 'playwright-fetcher.ts' },
    buildVsBuy: { costToBuild: 0.4, speedToBuy: 0.5, qualityIfBuilt: 0.85, securityIfBuilt: 0.7, vendorLockRisk: 0.3, runtimeRiskIfBuilt: 0.5, notes: 'Build — needed because plain fetch fails on JS-heavy modern blogs' } },
  { id: 'feed_ingester', dimension: 'research', title: 'RSS/Atom feed ingester', description: 'Scheduled feed polling',
    signals: { serviceFile: 'feed-ingester.ts', eventPrefix: 'feed.' },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.4, qualityIfBuilt: 0.9, securityIfBuilt: 0.9, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — trivial and avoids vendor lock' } },

  // Memory
  { id: 'embedding_provider', dimension: 'memory', title: 'Embeddings provider', description: 'Vector embedding driver',
    signals: { serviceFile: 'embeddings.ts' },
    buildVsBuy: { costToBuild: 0.85, speedToBuy: 0.9, qualityIfBuilt: 0.4, securityIfBuilt: 0.7, vendorLockRisk: 0.5, runtimeRiskIfBuilt: 0.7, notes: 'BUY (or local Ollama) — training own embedding model not practical' } },
  { id: 'memory_compression', dimension: 'memory', title: 'Memory compression', description: 'Decay-aware ranking + relevance',
    signals: { serviceFile: 'memory-compression.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.2, qualityIfBuilt: 0.85, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'Build — workspace-specific logic' } },
  { id: 'continuity_engine', dimension: 'memory', title: 'Continuity engine', description: 'Past incidents/fixes/failures aggregator',
    signals: { serviceFile: 'continuity-engine.ts' },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.1, qualityIfBuilt: 0.9, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — pure read-side over local tables' } },

  // UI/UX
  { id: 'strategic_home', dimension: 'ui_ux', title: 'Strategic Home page', description: 'First-screen operational view',
    signals: { webFiles: ['pages/StrategicHomePage.tsx', 'pages/TodayPage.tsx', 'pages/HomeDashboardPage.tsx'] },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.0, qualityIfBuilt: 1.0, securityIfBuilt: 1.0, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — operator UX is the product' } },
  { id: 'image_studio_ui', dimension: 'ui_ux', title: 'Image Studio UI', description: 'Premium generation workspace',
    signals: { webFiles: ['pages/ImageStudioPage.tsx'] },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.4, qualityIfBuilt: 0.9, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — UX differentiator' } },
  { id: 'voice_command', dimension: 'ui_ux', title: 'Voice command bar', description: 'Browser-native STT/TTS',
    signals: { webFiles: ['components/VoiceCommandBar.tsx'] },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.5, qualityIfBuilt: 0.7, securityIfBuilt: 1.0, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — Web Speech API is free' } },

  // Infrastructure
  { id: 'cron_scheduler', dimension: 'infrastructure', title: 'Cron scheduler', description: 'In-process scheduled tasks',
    signals: { serviceFile: 'learning-cron.ts', eventPrefix: 'cron.' },
    buildVsBuy: { costToBuild: 0.1, speedToBuy: 0.7, qualityIfBuilt: 0.85, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'Build — already done with setInterval' } },
  { id: 'image_storage', dimension: 'infrastructure', title: 'Image storage', description: 'S3 + local disk fallback',
    signals: { serviceFile: 'image-storage.ts' },
    buildVsBuy: { costToBuild: 0.4, speedToBuy: 0.9, qualityIfBuilt: 0.6, securityIfBuilt: 0.7, vendorLockRisk: 0.5, runtimeRiskIfBuilt: 0.3, notes: 'BUY (S3) — running own object store not practical' } },
  { id: 'notification_dispatcher', dimension: 'infrastructure', title: 'Notification dispatcher', description: 'webhook/Pushover/Slack/Discord',
    signals: { serviceFile: 'notifications.ts' },
    buildVsBuy: { costToBuild: 0.2, speedToBuy: 0.6, qualityIfBuilt: 0.85, securityIfBuilt: 0.9, vendorLockRisk: 0.2, runtimeRiskIfBuilt: 0.2, notes: 'Build — multiple drivers thin wrap' } },
  { id: 'gpu_inference_endpoint', dimension: 'infrastructure', title: 'GPU inference endpoint', description: 'Self-hosted model serving',
    signals: { eventPrefix: 'inference.' },
    buildVsBuy: { costToBuild: 0.95, speedToBuy: 0.95, qualityIfBuilt: 0.5, securityIfBuilt: 0.85, vendorLockRisk: 0.5, runtimeRiskIfBuilt: 0.9, notes: 'DEFER — operator is single-user, GPU infra not justified yet' } },

  // Provider routing
  { id: 'ai_provider_router', dimension: 'provider_routing', title: 'AI provider router', description: 'Route LLM calls by cost/health/task',
    signals: { serviceFile: 'provider-router.ts' },
    buildVsBuy: { costToBuild: 0.4, speedToBuy: 0.2, qualityIfBuilt: 0.85, securityIfBuilt: 0.9, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.3, notes: 'Build — routing logic is operator-specific' } },
  { id: 'token_stretcher', dimension: 'provider_routing', title: 'Token stretcher', description: 'Cache + compression for LLM calls',
    signals: { serviceFile: 'token-stretcher.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.0, qualityIfBuilt: 0.9, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — no third-party exists' } },

  // Runtime stability
  { id: 'resource_governor', dimension: 'runtime_stability', title: 'Resource governor', description: 'Rate limits + emergency throttle',
    signals: { serviceFile: 'resource-governor.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.1, qualityIfBuilt: 0.9, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'Build — must be in-process for chokepoint enforcement' } },
  { id: 'stability_monitor', dimension: 'runtime_stability', title: 'Stability monitor', description: 'Event-spam + failure-rate detection',
    signals: { serviceFile: 'stability-monitor.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.5, qualityIfBuilt: 0.85, securityIfBuilt: 0.95, vendorLockRisk: 0.2, runtimeRiskIfBuilt: 0.2, notes: 'Build — operator-specific signal definitions' } },

  // Agent orchestration
  { id: 'agent_coordinator', dimension: 'agent_orchestration', title: 'Agent coordinator', description: 'Dedup leases + event-collapse',
    signals: { serviceFile: 'agent-coordinator.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.2, qualityIfBuilt: 0.85, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.2, notes: 'Build — internal coordination primitive' } },
  { id: 'division_system', dimension: 'agent_orchestration', title: 'Divisions', description: '8 logical operational divisions',
    signals: { serviceFile: 'divisions.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.1, qualityIfBuilt: 0.9, securityIfBuilt: 0.95, vendorLockRisk: 0.0, runtimeRiskIfBuilt: 0.1, notes: 'Build — domain-specific taxonomy' } },

  // Business operations
  { id: 'plan_features', dimension: 'business_operations', title: 'Plan features', description: 'Plan-gated feature accessors',
    signals: { serviceFile: 'plan-features.ts' },
    buildVsBuy: { costToBuild: 0.3, speedToBuy: 0.6, qualityIfBuilt: 0.85, securityIfBuilt: 0.9, vendorLockRisk: 0.3, runtimeRiskIfBuilt: 0.2, notes: 'Build — feature gates are domain-specific' } },
  { id: 'stripe_billing', dimension: 'business_operations', title: 'Stripe billing integration', description: 'Subscription + payment',
    signals: { serviceFile: 'billing.ts', eventPrefix: 'stripe.' },
    buildVsBuy: { costToBuild: 0.95, speedToBuy: 0.95, qualityIfBuilt: 0.2, securityIfBuilt: 0.4, vendorLockRisk: 0.6, runtimeRiskIfBuilt: 0.9, notes: 'BUY — running own payments needs PCI compliance' } },
]

// ─── Detection ───────────────────────────────────────────────────────────────

export interface CapabilityStatus {
  id:          string
  dimension:   CapabilityDimension
  title:       string
  description: string
  exists:      boolean
  maturity:    Maturity
  evidence:    string[]
  recentEventCount: number
  buildVsBuy: {
    score:       number       // -1..+1 (negative = buy, positive = build)
    verdict:     'build' | 'buy' | 'hybrid' | 'defer'
    rationale:   string
    notes:       string
  }
}

function fileExists(dir: string, name: string): boolean {
  try {
    if (!existsSync(dir)) return false
    return readdirSync(dir).includes(name)
  } catch { return false }
}

/**
 * Substantial = file exists and is >100 source lines (implementation, not stub).
 * Used to treat a real service as 'basic' instead of 'scaffolded' even when
 * it emits no prefixed events — many services are inline-callable and never
 * touch the events table.
 */
function fileIsSubstantial(dir: string, name: string | undefined): boolean {
  if (!name) return false
  try {
    if (!fileExists(dir, name)) return false
    const path = join(dir, name)
    // Cheap line-count read — these files are <2k lines.
    const txt = readFileSync(path, 'utf8')
    return txt.split('\n').length >= 100
  } catch { return false }
}

function computeBuildScore(c: CapabilityDef): { score: number; verdict: CapabilityStatus['buildVsBuy']['verdict']; rationale: string } {
  // Higher = prefer build. Weighted combination of inverted cost,
  // quality/security advantage, vendor-lock avoidance, runtime risk.
  const b = c.buildVsBuy
  const score =
      (1 - b.costToBuild)      * 0.2
    + b.qualityIfBuilt         * 0.2
    + b.securityIfBuilt        * 0.25
    + b.vendorLockRisk         * 0.2     // higher lock risk → prefer build
    + (1 - b.runtimeRiskIfBuilt) * 0.15
    - b.speedToBuy             * 0.2     // fast-to-buy reduces build preference
  const normalized = Math.max(-1, Math.min(1, score - 0.5))

  let verdict: CapabilityStatus['buildVsBuy']['verdict']
  if (b.runtimeRiskIfBuilt >= 0.85) verdict = 'defer'        // GPU/training infra etc.
  else if (normalized >= 0.2)        verdict = 'build'
  else if (normalized <= -0.2)       verdict = 'buy'
  else                               verdict = 'hybrid'

  const rationale =
    verdict === 'build' ? 'Internal build advantages dominate (security/control/no lock-in)' :
    verdict === 'buy'   ? 'External provider faster + cheaper; manageable lock-in' :
    verdict === 'defer' ? 'High runtime risk — defer until justified by usage' :
                          'Mixed signals — build core, buy commodity layer'
  return { score: Number(normalized.toFixed(2)), verdict, rationale }
}

async function recentEventCount(prefix: string | undefined, workspaceId: string): Promise<number> {
  if (!prefix) return 0
  const weekAgo = Date.now() - 7 * 24 * 60 * 60_000
  return db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} like ${prefix + '%'}`, gte(events.createdAt, weekAgo)))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}

export async function detectCapabilities(workspaceId: string): Promise<CapabilityStatus[]> {
  const out: CapabilityStatus[] = []
  for (const c of CAPABILITY_REGISTRY) {
    const evidence: string[] = []
    const hasService = c.signals.serviceFile ? fileExists(SERVICES_DIR, c.signals.serviceFile) : false
    const hasRoute   = c.signals.routeFile   ? fileExists(ROUTES_DIR,   c.signals.routeFile)   : false
    // Web file check: any-match against a list of relative paths
    // (e.g. ['pages/VoiceBar.tsx','components/VoiceCommandBar.tsx']).
    const hasWeb = (c.signals.webFiles ?? []).some(rel => {
      const slash = rel.replace(/\\/g, '/')
      const idx   = slash.lastIndexOf('/')
      const dir   = idx >= 0 ? join(WEB_SRC_DIR, slash.slice(0, idx)) : WEB_SRC_DIR
      const name  = idx >= 0 ? slash.slice(idx + 1) : slash
      return fileExists(dir, name)
    })
    if (hasService) evidence.push(`service: ${c.signals.serviceFile}`)
    if (hasRoute)   evidence.push(`route: ${c.signals.routeFile}`)
    if (hasWeb)     evidence.push(`web: ${c.signals.webFiles?.find(rel => {
      const slash = rel.replace(/\\/g, '/')
      const idx   = slash.lastIndexOf('/')
      const dir   = idx >= 0 ? join(WEB_SRC_DIR, slash.slice(0, idx)) : WEB_SRC_DIR
      const name  = idx >= 0 ? slash.slice(idx + 1) : slash
      return fileExists(dir, name)
    })}`)
    const eventCount = await recentEventCount(c.signals.eventPrefix, workspaceId)
    if (eventCount > 0) evidence.push(`${eventCount} events/7d with prefix '${c.signals.eventPrefix}'`)

    const substantial = fileIsSubstantial(SERVICES_DIR, c.signals.serviceFile)
                     || fileIsSubstantial(ROUTES_DIR,   c.signals.routeFile)
    if (substantial) evidence.push('substantial implementation (>=100 LOC)')
    const exists = hasService || hasRoute || hasWeb || eventCount > 0
    const min = c.signals.minEventsLastWeek ?? 1
    let maturity: Maturity
    if (!exists) maturity = 'missing'
    // A substantial file with no events is still 'basic' (real impl, just
    // doesn't emit prefixed events). Only treat as 'scaffolded' when the
    // file is small/stubby.
    else if (eventCount === 0 && (hasService || hasRoute || hasWeb) && !substantial) maturity = 'scaffolded'
    else if (eventCount < min) maturity = 'basic'
    else if (eventCount < 50)   maturity = 'healthy'
    else                        maturity = 'mature'

    // UI/UX capabilities don't have backend signals; assume scaffolded if registered
    if (c.dimension === 'ui_ux' && !exists) { maturity = 'scaffolded'; evidence.push('frontend page (assumed present — not API-detectable)') }

    const bvb = computeBuildScore(c)
    out.push({
      id: c.id, dimension: c.dimension, title: c.title, description: c.description,
      exists, maturity, evidence, recentEventCount: eventCount,
      buildVsBuy: { score: bvb.score, verdict: bvb.verdict, rationale: bvb.rationale, notes: c.buildVsBuy.notes },
    })
  }
  return out
}

export async function detectGaps(workspaceId: string): Promise<CapabilityStatus[]> {
  const all = await detectCapabilities(workspaceId)
  return all.filter(c => c.maturity === 'missing' || c.maturity === 'scaffolded')
}

export interface DimensionSummary {
  dimension:   CapabilityDimension
  total:       number
  missing:     number
  scaffolded:  number
  basic:       number
  healthy:     number
  mature:      number
}

export async function dimensionSummary(workspaceId: string): Promise<DimensionSummary[]> {
  const caps = await detectCapabilities(workspaceId)
  const byDim = new Map<CapabilityDimension, DimensionSummary>()
  for (const c of caps) {
    const d = byDim.get(c.dimension) ?? { dimension: c.dimension, total: 0, missing: 0, scaffolded: 0, basic: 0, healthy: 0, mature: 0 }
    d.total++; d[c.maturity]++
    byDim.set(c.dimension, d)
  }
  return [...byDim.values()]
}
