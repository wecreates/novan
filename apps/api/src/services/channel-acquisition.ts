/**
 * channel-acquisition.ts — Part 2 of the spec: channel acquisition vs.
 * building from scratch, valuation math, and due diligence.
 *
 * Implements:
 *   - Valuation calculator: TTM-earnings multiples, asset-component
 *     decomposition (audience / brand / cash flow / operating system /
 *     SEO positioning)
 *   - Build-vs-buy decision framework based on capital, time horizon,
 *     niche maturity, operational capacity
 *   - Due diligence checklist with red-flag detector
 *   - Acquisition-target scoring (good targets vs anti-targets)
 *   - Post-acquisition risk assessment (decline projection, talent risk)
 *
 * Honest scope: this engine produces analysis + checklists. The actual
 * acquisition (broker engagement, legal review, escrow, transfer of
 * platform-account ownership) is operator work. Novan provides the
 * structured framework.
 */

// ── Valuation ─────────────────────────────────────────────────────
export interface ChannelFinancials {
  /** Trailing twelve months — net profit AFTER all costs. */
  ttmNetProfitUsd:      number
  /** Last 12 months revenue. */
  ttmRevenueUsd:        number
  /** Revenue streams + their TTM share. */
  revenueStreams: Array<{
    kind:  'ad_revenue' | 'sponsorship' | 'affiliate' | 'merch' | 'course' | 'membership' | 'licensing' | 'other'
    ttmUsd: number
  }>
  /** Most recent 3-month trend: 'growing' | 'flat' | 'declining'. */
  trend90d:             'growing' | 'flat' | 'declining'
  /** Subscribers + 30d unique viewers. */
  subscribers:          number
  monthlyUniqueViewers: number
  /** Engagement quality. */
  returningViewerPct:   number      // 0..1
  avgEngagementRate:    number      // 0..1
}

export interface ChannelOperationalProfile {
  /** Is the channel built around a single creator's personality? */
  isCreatorDependent:   boolean
  /** Is the creator staying post-acquisition? */
  creatorStaysAfterSale: boolean
  /** Documented production system + transferable accounts? */
  hasDocumentedSops:    boolean
  hasTransferableAccounts: boolean
  /** Niche health. */
  nicheCategory:        'finance' | 'business' | 'tech' | 'real_estate' | 'education' | 'health' | 'gaming' | 'music' | 'entertainment' | 'lifestyle' | 'other'
  nicheTrend:           'growing' | 'stable' | 'declining'
  /** Strike history — copyright + community-guidelines. */
  copyrightStrikes:     number
  communityGuidelinesStrikes: number
  /** Audience geography mix. US/UK/CA/AU pays much more than other regions. */
  highCpmAudiencePct:   number      // 0..1
}

export interface Valuation {
  multipleAppliedTtmEarnings: number   // months of TTM net profit
  estimatedSalePriceUsd:      number
  /** Asset-component breakdown — sum approximates total price. */
  components: {
    audienceUsd:        number
    brandAndIpUsd:      number
    cashFlowUsd:        number
    operatingSystemUsd: number
    seoPositioningUsd:  number
  }
  riskAdjustmentPct:    number       // -ve discount, +ve premium
  reasoning:            string[]
}

/** Apply 2024-2026 channel multiples — 24-48 months of TTM net profit.
 *  High-quality stable niches at the high end; volatile/single-creator
 *  channels at the low end. */
export function valuateChannel(input: {
  financials:   ChannelFinancials
  operations:   ChannelOperationalProfile
}): Valuation {
  const { financials: f, operations: o } = input
  // Base multiple — 36 months (3yr TTM) for mid-quality.
  let multiple = 36
  const reasoning: string[] = []

  // Niche adjustment
  const highCpmNiches: ChannelOperationalProfile['nicheCategory'][] = ['finance', 'business', 'tech', 'real_estate']
  if (highCpmNiches.includes(o.nicheCategory)) {
    multiple += 4
    reasoning.push(`high-CPM niche (${o.nicheCategory}) → +4 months`)
  }
  if (o.nicheCategory === 'gaming' || o.nicheCategory === 'music' || o.nicheCategory === 'entertainment') {
    multiple -= 6
    reasoning.push(`commodity-CPM niche (${o.nicheCategory}) → -6 months`)
  }
  if (o.nicheTrend === 'declining') {
    multiple -= 12
    reasoning.push('niche in structural decline → -12 months')
  }
  if (o.nicheTrend === 'growing') {
    multiple += 4
    reasoning.push('niche growing → +4 months')
  }

  // Trend
  if (f.trend90d === 'declining') {
    multiple -= 8
    reasoning.push('90d trend declining → -8 months (seller exits before it gets worse)')
  }
  if (f.trend90d === 'growing') {
    multiple += 4
    reasoning.push('90d trend growing → +4 months')
  }

  // Operational quality
  if (o.isCreatorDependent && !o.creatorStaysAfterSale) {
    multiple -= 12
    reasoning.push('creator-dependent + creator NOT staying → -12 months (major transfer risk)')
  }
  if (o.isCreatorDependent && o.creatorStaysAfterSale) {
    multiple -= 4
    reasoning.push('creator-dependent + creator staying (transition) → -4 months')
  }
  if (!o.hasDocumentedSops) {
    multiple -= 4
    reasoning.push('no documented production SOPs → -4 months (transferability risk)')
  }
  if (!o.hasTransferableAccounts) {
    multiple -= 6
    reasoning.push('non-transferable platform accounts → -6 months (operational risk)')
  }

  // Strikes
  if (o.copyrightStrikes >= 1) {
    multiple -= o.copyrightStrikes * 3
    reasoning.push(`${o.copyrightStrikes} copyright strike(s) → -${o.copyrightStrikes * 3} months`)
  }
  if (o.communityGuidelinesStrikes >= 1) {
    multiple -= o.communityGuidelinesStrikes * 4
    reasoning.push(`${o.communityGuidelinesStrikes} community-guidelines strike(s) → -${o.communityGuidelinesStrikes * 4} months`)
  }

  // Engagement quality
  if (f.returningViewerPct > 0.4) {
    multiple += 3
    reasoning.push(`high return-viewer rate (${(f.returningViewerPct * 100).toFixed(0)}%) → +3 months`)
  }
  if (f.returningViewerPct < 0.15) {
    multiple -= 3
    reasoning.push(`low return-viewer rate (${(f.returningViewerPct * 100).toFixed(0)}%) → -3 months (weak audience relationship)`)
  }

  // Audience geography
  if (o.highCpmAudiencePct > 0.7) {
    multiple += 2
    reasoning.push(`${(o.highCpmAudiencePct * 100).toFixed(0)}% high-CPM-region audience → +2 months`)
  }

  // Revenue diversity
  const adShare = f.revenueStreams.find(s => s.kind === 'ad_revenue')?.ttmUsd ?? 0
  const adPct = f.ttmRevenueUsd > 0 ? adShare / f.ttmRevenueUsd : 0
  if (adPct > 0.85) {
    multiple -= 4
    reasoning.push(`>85% revenue from ad share → -4 months (volatile single-stream dependency)`)
  }
  if (adPct < 0.5 && f.revenueStreams.length >= 3) {
    multiple += 3
    reasoning.push(`diverse revenue (${f.revenueStreams.length} streams, ${(adPct * 100).toFixed(0)}% ads) → +3 months`)
  }

  // Clamp to realistic range 12-60 months
  multiple = Math.max(12, Math.min(60, multiple))

  const monthlyNet = f.ttmNetProfitUsd / 12
  const totalPrice = monthlyNet * multiple
  const baselinePrice = monthlyNet * 36
  const riskAdjustmentPct = baselinePrice > 0 ? Number(((totalPrice - baselinePrice) / baselinePrice).toFixed(3)) : 0

  // Component decomposition — heuristic split (varies in real deals).
  const components = {
    audienceUsd:        Math.round(totalPrice * 0.35),
    brandAndIpUsd:      Math.round(totalPrice * 0.15),
    cashFlowUsd:        Math.round(totalPrice * 0.30),
    operatingSystemUsd: Math.round(totalPrice * 0.10),
    seoPositioningUsd:  Math.round(totalPrice * 0.10),
  }

  return {
    multipleAppliedTtmEarnings: multiple,
    estimatedSalePriceUsd:      Math.round(totalPrice),
    components,
    riskAdjustmentPct,
    reasoning,
  }
}

// ── Due diligence checklist ───────────────────────────────────────
export interface DiligenceItem {
  category:   'analytics' | 'revenue' | 'engagement' | 'audience' | 'library' | 'algorithm_risk' | 'team' | 'niche' | 'operations' | 'legal'
  question:   string
  redFlag:    string
  /** Operator-recorded status after diligence. */
  status?:    'pass' | 'concern' | 'fail' | 'not_checked'
  notes?:     string
}

export function dueDiligenceChecklist(): DiligenceItem[] {
  return [
    // Analytics verification
    { category: 'analytics', question: 'YouTube Studio direct access provided + reconciled against reported viewership',                 redFlag: 'seller refuses platform access or only provides screenshots' },
    { category: 'analytics', question: 'Subscriber growth curve verified — no abrupt spikes suggesting bots',                              redFlag: 'subscriber count grew suddenly without corresponding view spike' },
    { category: 'analytics', question: 'Traffic sources match plausible audience growth (browse + suggested + search reasonable mix)',     redFlag: 'majority of traffic from single source that could disappear' },
    // Revenue verification
    { category: 'revenue',   question: 'Bank statements + platform revenue records reconciled',                                            redFlag: 'discrepancies between reported and verified revenue' },
    { category: 'revenue',   question: 'Sponsorship revenue verified via actual invoices + payment records',                               redFlag: 'sponsorship revenue claimed but no contracts or invoices' },
    { category: 'revenue',   question: 'Affiliate revenue verified via dashboard access',                                                  redFlag: 'affiliate revenue claimed but no Amazon Associates / network access provided' },
    { category: 'revenue',   question: 'No one-off revenue spikes inflating TTM (viral, product launch, single sponsor)',                  redFlag: 'TTM dominated by an event that won\'t repeat' },
    // Engagement quality
    { category: 'engagement', question: 'Comment review — quality + diversity, no bot-pattern comments',                                   redFlag: 'generic / templated / non-English-when-channel-is-English comment patterns' },
    { category: 'engagement', question: 'Engagement-to-view ratio consistent with niche peers',                                            redFlag: 'engagement-to-view ratio anomalously high or low' },
    // Audience quality
    { category: 'audience',   question: 'Demographics + geography match expected audience',                                                redFlag: 'audience heavily skewed to low-CPM geography (when not the operator\'s deliberate strategy)' },
    { category: 'audience',   question: 'Audience retention curves healthy across recent videos',                                          redFlag: 'retention declining across videos consistently' },
    { category: 'audience',   question: 'Returning viewer percentage > 25%',                                                                redFlag: 'returning viewer rate < 15%' },
    // Content library
    { category: 'library',    question: 'Full back-catalog audited for copyright + controversial content',                                 redFlag: 'unlicensed music, copyrighted footage, or controversial historical content not surfaced by seller' },
    { category: 'library',    question: 'Evergreen content share documented — what % of views from videos > 6mo old',                      redFlag: '< 20% from evergreen — channel depends on constant new uploads' },
    { category: 'library',    question: 'Reliance on specific trends or moments evaluated',                                                redFlag: 'big videos all from one trend that\'s now over' },
    // Algorithm risk
    { category: 'algorithm_risk', question: 'No demonetisation issues in past 12mo',                                                       redFlag: 'demonetised videos in library OR yellow-icon recent uploads' },
    { category: 'algorithm_risk', question: 'No community-guidelines strikes',                                                              redFlag: 'any active strike within 90 days' },
    { category: 'algorithm_risk', question: 'Niche not specifically subject to elevated platform penalties',                                redFlag: 'channel in news / health / firearms / gambling / similar niches with elevated risk' },
    // Talent + team
    { category: 'team',       question: 'Talent transferability — single-creator dependency assessed',                                     redFlag: 'creator leaving + channel built on their personality' },
    { category: 'team',       question: 'Key contributors under contract or staying through transition',                                   redFlag: 'editors / writers / designers leaving with no replacement' },
    // Niche + competition
    { category: 'niche',      question: 'Niche growth + competitive density evaluated',                                                    redFlag: 'niche declining OR competitive density rising sharply' },
    { category: 'niche',      question: 'Channel-specific moat (creator personality / unique access / brand) identified',                  redFlag: 'no defensible moat — competitors can replicate' },
    // Operations
    { category: 'operations', question: 'Documented production SOPs provided + transferable',                                              redFlag: 'no SOPs OR institutional knowledge concentrated in one person' },
    { category: 'operations', question: 'Software + tool accounts transferable (Adobe / CapCut Pro / Notion / etc.)',                       redFlag: 'tools tied to seller\'s personal accounts' },
    { category: 'operations', question: 'Music licensing accounts (Epidemic / Artlist / etc.) transferable',                               redFlag: 'music licenses tied to seller\'s personal account — risk of cancellation post-sale' },
    // Legal
    { category: 'legal',      question: 'Trademark registrations on channel name / brand assessed',                                        redFlag: 'channel name conflicts with existing trademarks' },
    { category: 'legal',      question: 'Sponsor contracts + obligations reviewed (any pending deliverables?)',                            redFlag: 'unfulfilled sponsor obligations transferring to buyer' },
    { category: 'legal',      question: 'Existing legal disputes / warnings / cease-and-desist letters',                                   redFlag: 'any open legal matter' },
    { category: 'legal',      question: 'Tax compliance history clean (no liens, no open audits)',                                         redFlag: 'tax issues that may transfer or affect business' },
    { category: 'legal',      question: 'YouTube account in good standing (no terminations / strike history beyond resolved)',             redFlag: 'history of strikes, even if resolved' },
  ]
}

/** Aggregate diligence findings into a verdict. */
export function summariseDiligence(items: DiligenceItem[]): {
  totalItems:      number
  passed:          number
  concerns:        number
  failed:          number
  notChecked:      number
  verdict:         'proceed' | 'proceed_with_caveats' | 'renegotiate' | 'walk_away'
  topConcerns:     string[]
} {
  const totalItems  = items.length
  const passed      = items.filter(i => i.status === 'pass').length
  const concerns    = items.filter(i => i.status === 'concern').length
  const failed      = items.filter(i => i.status === 'fail').length
  const notChecked  = items.filter(i => !i.status || i.status === 'not_checked').length
  const topConcerns = items.filter(i => i.status === 'fail' || i.status === 'concern').slice(0, 5).map(i => `[${i.category}] ${i.question}: ${i.redFlag}${i.notes ? ` — ${i.notes}` : ''}`)

  let verdict: 'proceed' | 'proceed_with_caveats' | 'renegotiate' | 'walk_away'
  if (failed >= 3) verdict = 'walk_away'
  else if (failed >= 1) verdict = 'renegotiate'
  else if (concerns >= 5) verdict = 'renegotiate'
  else if (concerns >= 1) verdict = 'proceed_with_caveats'
  else if (notChecked > totalItems * 0.3) verdict = 'proceed_with_caveats'
  else verdict = 'proceed'

  return { totalItems, passed, concerns, failed, notChecked, verdict, topConcerns }
}

// ── Build vs. Buy framework ───────────────────────────────────────
export interface BuildVsBuyInputs {
  /** Capital available for the venture, USD. */
  capitalAvailableUsd:        number
  /** Target time-to-meaningful-revenue, in months. */
  targetTimeToRevenueMonths:  number
  /** Operator-defined creative-control importance, 0..1. */
  creativeControlImportance:  number
  /** Niche maturity — is the niche underserved (build) or established (buy)? */
  nicheMaturity:              'underserved' | 'emerging' | 'established' | 'saturated'
  /** Existing operational capacity? Can the operator absorb an acquired channel? */
  existingOperationalCapacity: boolean
  /** Does the operator already run channels in adjacent niches? */
  hasAdjacentOperations:       boolean
}

export interface BuildVsBuyVerdict {
  recommendation:    'build' | 'buy' | 'hybrid'
  rationale:         string[]
  buildAssumptions:  { capitalNeededUsd: [number, number]; timelineMonths: [number, number]; failureRiskPct: number }
  buyAssumptions:    { capitalNeededUsd: [number, number]; timelineMonths: [number, number]; postAcqDeclineRiskPct: number }
}

export function buildVsBuy(input: BuildVsBuyInputs): BuildVsBuyVerdict {
  const rationale: string[] = []
  let buildScore = 0
  let buyScore = 0

  // Spec ranges for building from scratch
  const buildAssumptions = {
    capitalNeededUsd: [50_000, 300_000] as [number, number],
    timelineMonths:   [18, 36] as [number, number],
    failureRiskPct:   0.6,   // "meaningful portion never succeeds"
  }

  if (input.capitalAvailableUsd < 200_000) {
    buildScore += 2
    rationale.push('capital constrained — build path requires less upfront')
  } else {
    buyScore += 1
    rationale.push('capital available — buy is feasible')
  }
  if (input.targetTimeToRevenueMonths < 12) {
    buyScore += 3
    rationale.push('short time-horizon — build can\'t deliver in <12mo, buy can')
  }
  if (input.targetTimeToRevenueMonths > 24) {
    buildScore += 1
    rationale.push('long time-horizon — build can mature')
  }
  if (input.creativeControlImportance > 0.7) {
    buildScore += 2
    rationale.push('high creative-control priority — build preserves vision; acquired channels carry seller voice')
  }
  if (input.nicheMaturity === 'underserved' || input.nicheMaturity === 'emerging') {
    buildScore += 2
    rationale.push('underserved / emerging niche — buying is hard (no targets); building captures first-mover')
  }
  if (input.nicheMaturity === 'established' || input.nicheMaturity === 'saturated') {
    buyScore += 2
    rationale.push('established / saturated niche — building from cold start is very hard; buying skips it')
  }
  if (input.existingOperationalCapacity) {
    buyScore += 2
    rationale.push('existing operational capacity — can absorb acquired channel + apply infrastructure')
  } else {
    buildScore += 1
    rationale.push('no existing operational capacity — acquired channel would burn out the operator')
  }
  if (input.hasAdjacentOperations) {
    buyScore += 2
    rationale.push('adjacent operations create synergies — sponsorship rolodex, production infra apply to acquired channel')
  }

  const buyAssumptions = {
    capitalNeededUsd:        [200_000, 5_000_000] as [number, number],
    timelineMonths:          [3, 6] as [number, number],
    postAcqDeclineRiskPct:   0.4,   // most acquired channels see some decline post-sale
  }

  let recommendation: 'build' | 'buy' | 'hybrid'
  if (buildScore - buyScore >= 3) recommendation = 'build'
  else if (buyScore - buildScore >= 3) recommendation = 'buy'
  else recommendation = 'hybrid'

  if (recommendation === 'hybrid') {
    rationale.push('scores close — most sophisticated operators do BOTH: acquire for immediate cash flow + build for growth optionality')
  }

  return { recommendation, rationale, buildAssumptions, buyAssumptions }
}

// ── Acquisition target scoring (good vs anti-target) ──────────────
export interface TargetScoring {
  goodTargetScore:   number    // 0..1
  goodTargetSignals: string[]
  antiTargetSignals: string[]
  /** Final advisory. */
  advisory:          'strong_target' | 'acceptable_target' | 'avoid'
}

export function scoreAcquisitionTarget(input: {
  financials:  ChannelFinancials
  operations:  ChannelOperationalProfile
}): TargetScoring {
  const goodSignals: string[] = []
  const antiSignals: string[] = []

  // Good signals
  if (!input.operations.isCreatorDependent) goodSignals.push('faceless / production-systematic — value not tied to one person')
  const goodNiches = ['finance', 'business', 'tech', 'real_estate', 'education'] as const
  if ((goodNiches as readonly string[]).includes(input.operations.nicheCategory)) {
    goodSignals.push(`high-CPM stable niche (${input.operations.nicheCategory})`)
  }
  if (input.financials.revenueStreams.length >= 3) goodSignals.push(`diverse revenue (${input.financials.revenueStreams.length} streams)`)
  if (input.financials.returningViewerPct > 0.3) goodSignals.push(`engaged audience (${(input.financials.returningViewerPct * 100).toFixed(0)}% return rate)`)
  if (input.operations.hasDocumentedSops) goodSignals.push('documented operations')
  if (input.financials.subscribers >= 100_000 && input.financials.subscribers <= 1_000_000) {
    goodSignals.push(`sweet-spot scale (${input.financials.subscribers.toLocaleString()} subs — proven PMF + room for improvement)`)
  }

  // Anti-target signals
  if (input.operations.isCreatorDependent && !input.operations.creatorStaysAfterSale) {
    antiSignals.push('CRITICAL: single creator leaving + channel built on their personality')
  }
  if (input.financials.trend90d === 'declining') antiSignals.push('declining performance — seller exits before it gets worse')
  if (input.operations.nicheTrend === 'declining') antiSignals.push(`niche in structural decline (${input.operations.nicheCategory})`)
  if (input.operations.copyrightStrikes >= 1 || input.operations.communityGuidelinesStrikes >= 1) {
    antiSignals.push(`strike history: ${input.operations.copyrightStrikes} copyright + ${input.operations.communityGuidelinesStrikes} CG`)
  }
  if (input.operations.highCpmAudiencePct < 0.3) antiSignals.push(`audience demographics don't monetise well (${(input.operations.highCpmAudiencePct * 100).toFixed(0)}% in high-CPM regions)`)

  // Score normalised
  const positive = goodSignals.length
  const negative = antiSignals.length * 1.5   // anti-signals weigh more
  const goodTargetScore = positive > 0 || negative > 0
    ? Math.max(0, Math.min(1, (positive - negative) / 6))
    : 0.5

  let advisory: 'strong_target' | 'acceptable_target' | 'avoid'
  if (antiSignals.some(s => s.startsWith('CRITICAL'))) advisory = 'avoid'
  else if (goodTargetScore >= 0.6) advisory = 'strong_target'
  else if (goodTargetScore >= 0.3) advisory = 'acceptable_target'
  else advisory = 'avoid'

  return {
    goodTargetScore: Number(goodTargetScore.toFixed(3)),
    goodTargetSignals: goodSignals,
    antiTargetSignals: antiSignals,
    advisory,
  }
}
