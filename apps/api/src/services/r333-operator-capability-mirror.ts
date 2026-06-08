/**
 * R146.333 — Operator Capability Mirror
 *
 * The mandate: "Everything being done in this chat I want Novan to be able
 * to do also, but 10x better."
 *
 * This file is the registry: every operator-facing action demonstrated in
 * the R332 revenue session, paired with the Novan-autonomous version.
 *
 * Each capability has:
 *   - id:              stable slug
 *   - operatorAction:  what a human (or Claude-in-chat) did manually
 *   - novanAutoOp:     the brain-task op name that does it autonomously
 *   - tenXLeverage:    what "10x better" means concretely for this capability
 *   - blockedBy:       hard prohibitions (SSN / banking / ID / signatures)
 *                      that ALWAYS require operator-in-the-loop
 *   - status:          'implemented' | 'partial' | 'planned'
 */

export type CapabilityStatus = 'implemented' | 'partial' | 'planned'

export interface Capability {
  id:             string
  category:       string
  operatorAction: string
  novanAutoOp:    string
  tenXLeverage:   string
  blockedBy?:     string[]
  status:         CapabilityStatus
  evidenceFromR332?: string
}

export const CAPABILITIES: Capability[] = [
  // ─── Provider resilience ──────────────────────────────────────────────────
  {
    id:             'provider.health_probe',
    category:       'reliability',
    operatorAction: 'Manually discover FAL is 403, Replicate is 402, Gemini is 429 — burning hours sequentially',
    novanAutoOp:    'provider.health.probe_all',
    tenXLeverage:   'Continuous 5-min health probes across every wired provider, classified by failure type (auth_revoked / billing_exhausted / rate_limited / network), surfaces ONE canonical status before operator hits a wall',
    status:         'implemented',
    evidenceFromR332: 'R332 burned 90 min on image gen attempts that were all going to fail',
  },
  {
    id:             'provider.auto_failover',
    category:       'reliability',
    operatorAction: 'Try FAL, fail, switch to Replicate, fail, switch to Gemini, fail',
    novanAutoOp:    'image.generate (uses filterHealthy from provider-health-monitor)',
    tenXLeverage:   'Image-router calls filterHealthy() before selection — known-dead providers are skipped instantly, only healthy ones enter the cost/quality scoring',
    status:         'partial',
  },

  // ─── OAuth / connector resilience ─────────────────────────────────────────
  {
    id:             'oauth.printful_redirect_url',
    category:       'connectors',
    operatorAction: 'Discover Printful uses non-standard `redirect_url` (not `redirect_uri`) by trial and error',
    novanAutoOp:    'startFlow with redirectParamName config',
    tenXLeverage:   'OAuth provider registry has per-provider param-name overrides; new provider quirks captured once and applied forever',
    status:         'implemented',
    evidenceFromR332: 'R332 added redirectParamName to OAuthConfig',
  },
  {
    id:             'oauth.pkce',
    category:       'connectors',
    operatorAction: 'Learn Etsy v3 requires PKCE the hard way (token exchange fails)',
    novanAutoOp:    'startFlow with cfg.pkce=true auto-generates verifier + challenge, embeds in state, threads to exchangeCode',
    tenXLeverage:   'PKCE wired generically — any future provider needing it gets it by setting one flag',
    status:         'implemented',
  },

  // ─── Platform onboarding ──────────────────────────────────────────────────
  {
    id:             'platform.tiktok_shop_onboard',
    category:       'onboarding',
    operatorAction: 'Operator clicks through 8 TikTok Shop pages, types SSN/bank/ID',
    novanAutoOp:    'channel.tiktok_shop.assist_onboarding',
    tenXLeverage:   'Novan pre-stages every non-personal field (DBA, business type, shop description, category, return policy text), opens correct browser tab via MCP, fills everything safe, halts with clear instructions on the 4 personal fields',
    blockedBy:      ['SSN', 'bank_routing', 'bank_account', 'drivers_license_upload', 'selfie_liveness', 'W9_signature'],
    status:         'partial',
  },
  {
    id:             'platform.printful_store_link',
    category:       'onboarding',
    operatorAction: 'Click Sync → Install Printful → accept On-hold warning → Confirm → Authorize → log into Printful',
    novanAutoOp:    'channel.printful.link_to(tiktok_shop)',
    tenXLeverage:   'Novan drives the entire Printful↔channel link flow via browser MCP. Operator only signs into Printful once.',
    status:         'partial',
    evidenceFromR332: 'R332 Claude-in-Chrome drove this exact flow end-to-end',
  },
  {
    id:             'platform.plot_twist_detector',
    category:       'onboarding',
    operatorAction: 'Spend 20 min preparing TikTok signup walkthrough then discover the account was already approved',
    novanAutoOp:    'platform.state.probe_before_setup',
    tenXLeverage:   'Before any onboarding workflow, Novan probes target state. TikTok Shop already approved? Skip to product publish. Printful store linked? Skip to product sync. Never waste a step.',
    status:         'planned',
    evidenceFromR332: 'R332 discovered CYZOR CREATIONS was already approved AFTER preparing the walkthrough',
  },

  // ─── Policy / privacy enforcement ─────────────────────────────────────────
  {
    id:             'policy.no_home_address_publicly',
    category:       'privacy',
    operatorAction: 'Manually remember not to use home address; tell Claude every platform',
    novanAutoOp:    'policy.enforce.no_home_address (runtime gate on every form submit)',
    tenXLeverage:   'Importance-99 memory rule enforced at runtime by an action-dispatcher hook. Any op that would put home address into a public field is blocked + alternative proposed (virtual mailbox tier triggered by MRR).',
    status:         'planned',
    evidenceFromR332: 'R332 locked rule.never_use_home_address_publicly at importance 99',
  },
  {
    id:             'policy.financial_hard_blocks',
    category:       'privacy',
    operatorAction: 'Claude refuses to enter SSN/bank/ID — explains every time',
    novanAutoOp:    'policy.enforce.financial_credentials',
    tenXLeverage:   'Same hard-block enforced at Novan op layer — no op can submit SSN/bank/govID. Surfaced once in a single clear chat message instead of relitigated per platform.',
    status:         'implemented',
  },

  // ─── Memory + lessons compounding ─────────────────────────────────────────
  {
    id:             'memory.lesson_capture',
    category:       'learning',
    operatorAction: 'Manually decide a failure is a lesson and write SQL to insert into workspace_memory',
    novanAutoOp:    'lesson.capture_from_failure',
    tenXLeverage:   'Every classified failure (provider 4xx, OAuth ban, platform rejection) auto-generates a candidate lesson, scored for generalizability, persisted with importance based on impact × applicability scope.',
    status:         'planned',
    evidenceFromR332: 'R332 manually locked 6 lessons via raw SQL',
  },
  {
    id:             'memory.lesson_propagation',
    category:       'learning',
    operatorAction: 'Hope I remember the Etsy ban pattern when registering Instagram',
    novanAutoOp:    'lesson.apply_to_op (pre-flight hook)',
    tenXLeverage:   'Every dev-app-registration op runs a pre-flight check against memory.lessons.platform_registration. Found a relevant lesson? Apply: age account first, sandbox scope first, etc. No human recall required.',
    status:         'planned',
  },

  // ─── Decision compilation ────────────────────────────────────────────────
  {
    id:             'strategy.free_first_compiler',
    category:       'cost',
    operatorAction: 'Repeatedly say "try free first", manually evaluate options A/B/C',
    novanAutoOp:    'strategy.free_first.decide',
    tenXLeverage:   'For any requirement, Novan compiles a decision tree: free option exists? Use it. Free exhausted? Cheap (<$10) option? Propose with cost projection. Else escalate. Records decision + outcome in prompt-evolution for learning.',
    status:         'planned',
    evidenceFromR332: 'R332 manually walked Path A/B/C three times (image gen, return address, store choice)',
  },
  {
    id:             'strategy.phase_trigger',
    category:       'cost',
    operatorAction: 'Manually decide "at $200 MRR switch to virtual mailbox"',
    novanAutoOp:    'strategy.phase.evaluate (cron daily)',
    tenXLeverage:   'Phase triggers are persisted as workspace_memory.strategy.* entries with explicit MRR thresholds. Daily cron evaluates against business_revenue table and proposes phase transitions when triggers cross.',
    status:         'planned',
  },

  // ─── Content generation fallback ─────────────────────────────────────────
  {
    id:             'content.public_domain_router',
    category:       'content',
    operatorAction: 'Pivot from AI-generated art to public domain when image-gen dies',
    novanAutoOp:    'content.public_domain.fetch',
    tenXLeverage:   'Wired pipelines to Met Museum (492k works), NYPL (900k), Smithsonian (4.5M), Library of Congress, Rijksmuseum. Auto-trigger when canGenerateImagesNow() returns false. Filter by niche-relevance + INPRNT bestseller patterns.',
    status:         'planned',
    evidenceFromR332: 'R332 pivoted strategy from pickleball original art to public domain when 3 providers died',
  },

  // ─── Brand consistency ───────────────────────────────────────────────────
  {
    id:             'brand.dba_propagation',
    category:       'brand',
    operatorAction: 'Type "CYZOR CREATIONS" into every form field across platforms',
    novanAutoOp:    'brand.dba.propagate_to_all_connected',
    tenXLeverage:   'workspace_memory.brand.dba.primary is the source of truth. Op auto-fills DBA in every connected platform setting where allowed (store name, artist name, return address line 1, packing slip, brand profile). One change updates everything.',
    status:         'planned',
  },

  // ─── Fulfillment monitoring ───────────────────────────────────────────────
  {
    id:             'fulfillment.printful_on_hold_monitor',
    category:       'fulfillment',
    operatorAction: 'Acknowledge "On hold not supported" risk once, hope it doesn\'t bite',
    novanAutoOp:    'fulfillment.tiktok.lag_sweep (cron 4x daily)',
    tenXLeverage:   'Cross-references TikTok orders (Awaiting shipment) against Printful production status. Any order >48h in Awaiting without Printful confirmation → auto-DM operator + propose refund-or-reprint decision. Prevents TikTok penalty escalation.',
    status:         'planned',
    evidenceFromR332: 'R332 acknowledged risk.printful_tiktok.on_hold_status at importance 90',
  },
]

export interface CapabilityReport {
  total:           number
  implemented:     number
  partial:         number
  planned:         number
  byCategory:      Record<string, { implemented: number; partial: number; planned: number }>
  gaps:            Capability[]
}

export function capabilityReport(): CapabilityReport {
  const r: CapabilityReport = {
    total:       CAPABILITIES.length,
    implemented: 0,
    partial:     0,
    planned:     0,
    byCategory:  {},
    gaps:        [],
  }
  for (const c of CAPABILITIES) {
    r[c.status]++
    if (!r.byCategory[c.category]) r.byCategory[c.category] = { implemented: 0, partial: 0, planned: 0 }
    r.byCategory[c.category][c.status]++
    if (c.status !== 'implemented') r.gaps.push(c)
  }
  return r
}

export function findCapability(id: string): Capability | undefined {
  return CAPABILITIES.find(c => c.id === id)
}

export function capabilitiesByCategory(category: string): Capability[] {
  return CAPABILITIES.filter(c => c.category === category)
}
