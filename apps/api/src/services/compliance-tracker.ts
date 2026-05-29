/**
 * compliance-tracker.ts — Part 4 of the spec: legal + tax compliance
 * monitoring for content businesses.
 *
 * The spec's framing: "The brain's role here is mostly coordination
 * and compliance monitoring: tracking obligations, deadlines, and
 * requirements; maintaining documentation; flagging issues for
 * professional review. The brain doesn't replace lawyers and
 * accountants for content businesses — it makes them more efficient
 * by handling the operational compliance work that surrounds their
 * advice."
 *
 * Implements:
 *   - Entity structure recommender (LLC / S-Corp / C-Corp by revenue
 *     threshold per the spec's $80-100K trigger for S-Corp)
 *   - FTC disclosure compliance checker (in-video clear-and-conspicuous
 *     + hashtag-only is insufficient warning)
 *   - Music + image rights audit
 *   - Tax obligation tracker (quarterly estimates, sales-tax nexus,
 *     state-residence implications, 1099 reconciliation)
 *   - International tax flags (W-8BEN, withholding, residency arbitrage)
 *   - IP register (trademarks, copyright registrations, music licenses)
 *
 * Honest disclaimer baked into every output: "general guidance — needs
 * a qualified professional in your jurisdiction." Brain refuses to give
 * jurisdiction-specific legal advice.
 */

// ── Entity recommendations ────────────────────────────────────────
export type Jurisdiction = 'US' | 'UK' | 'EU' | 'CA' | 'AU' | 'other'

export interface EntityRecommendation {
  recommendedEntity:   'sole_proprietor' | 'single_member_llc' | 'llc_partnership' | 'llc_with_s_corp_election' | 'c_corp'
  rationale:           string
  whenToRevisit:       string
  caveats:             string[]
  /** Always required — operator MUST consult a qualified attorney in
   *  their jurisdiction. */
  professionalReviewRequired: true
}

export function recommendEntity(input: {
  annualNetIncomeUsd:    number
  jurisdiction:          Jurisdiction
  multiOwner:            boolean
  seekingVentureCapital: boolean
  planningExit:          boolean
}): EntityRecommendation {
  const caveats = [
    'This is general guidance based on common 2024-2026 US practice. Your jurisdiction, state, scale, and specific structure may all change the answer.',
    'Engage a qualified attorney + CPA before forming or changing entity structure. Mistakes here are expensive.',
  ]

  if (input.jurisdiction !== 'US') {
    return {
      recommendedEntity:   'single_member_llc',
      rationale:           `Non-US jurisdiction (${input.jurisdiction}) — equivalent entity types vary substantially. This recommender is calibrated for US structures only. Consult local counsel.`,
      whenToRevisit:       'before forming any entity',
      caveats:             [...caveats, 'this recommender does NOT cover your jurisdiction — output is for US comparison only'],
      professionalReviewRequired: true,
    }
  }

  if (input.seekingVentureCapital) {
    return {
      recommendedEntity:   'c_corp',
      rationale:           'venture investors typically require Delaware C-Corp structure for equity rounds + investor protections',
      whenToRevisit:       'before raising any equity round',
      caveats,
      professionalReviewRequired: true,
    }
  }

  if (input.multiOwner) {
    return {
      recommendedEntity:   'llc_partnership',
      rationale:           'multi-owner operations typically structure as LLC taxed as partnership — flow-through taxation + flexible governance',
      whenToRevisit:       'if approaching VC funding OR significant exit; partnership doesn\'t scale into venture path',
      caveats,
      professionalReviewRequired: true,
    }
  }

  if (input.annualNetIncomeUsd < 30_000) {
    return {
      recommendedEntity:   'sole_proprietor',
      rationale:           'below entity-formation overhead break-even — sole proprietorship simpler. BUT consider single-member LLC for liability protection alone (small overhead, real protection).',
      whenToRevisit:       'at $30k+ net income OR when content business creates meaningful liability exposure',
      caveats:             [...caveats, 'spec: "Operating a content business as a sole proprietorship is a mistake almost immediately" — liability exposure alone justifies LLC even below $30k'],
      professionalReviewRequired: true,
    }
  }

  if (input.annualNetIncomeUsd < 80_000) {
    return {
      recommendedEntity:   'single_member_llc',
      rationale:           'liability protection + entity boundary + transferability without the S-Corp overhead. Treated as disregarded entity for tax (still flows to your 1040).',
      whenToRevisit:       'at $80-100k+ net income — S-Corp election starts saving self-employment tax',
      caveats,
      professionalReviewRequired: true,
    }
  }

  if (input.planningExit) {
    return {
      recommendedEntity:   'c_corp',
      rationale:           'planning exit at scale — C-Corp facilitates buyer due-diligence + clean equity structure. Some buyers prefer LLC for tax reasons; CPA + M&A attorney advise',
      whenToRevisit:       '6-12 months before active exit process',
      caveats,
      professionalReviewRequired: true,
    }
  }

  return {
    recommendedEntity:   'llc_with_s_corp_election',
    rationale:           `at $${input.annualNetIncomeUsd.toLocaleString()} net income, S-Corp election typically saves $5-15k/yr in self-employment tax by splitting income between reasonable salary + distributions`,
    whenToRevisit:       'annually; revisit if planning VC raise OR exit',
    caveats:             [...caveats, 'S-Corp election requires reasonable-compensation discipline + payroll setup + additional ongoing compliance'],
    professionalReviewRequired: true,
  }
}

// ── FTC disclosure compliance ────────────────────────────────────
export interface FtcDisclosureCheck {
  ok:                  boolean
  findings:            Array<{ severity: 'pass' | 'warning' | 'fail'; rule: string; detail: string }>
  recommendation:      string
}

export function checkFtcDisclosure(input: {
  /** Description text. Should contain explicit disclosure. */
  descriptionText:       string
  /** In-video disclosure timing — seconds from start. Null = none. */
  inVideoDisclosureSec:  number | null
  /** Has #ad or #sponsored hashtag? */
  hasAdHashtag:          boolean
  /** Is there a verbal disclosure clear + conspicuous in the video? */
  hasVerbalDisclosure:   boolean
  /** Is the sponsorship integration at the START of the sponsored segment? */
  disclosureBeforeSegment: boolean
  /** Affiliate links present? */
  hasAffiliateLinks:     boolean
  /** Targeting minors? COPPA + Made For Kids implications. */
  targetingMinors:       boolean
}): FtcDisclosureCheck {
  const findings: FtcDisclosureCheck['findings'] = []

  // Written description
  const desc = input.descriptionText.toLowerCase()
  const hasWrittenDisclosure = /\b(sponsored|paid partnership|paid promotion|in partnership with|brought to you by|#ad\b|#sponsored\b)/i.test(desc)
  if (hasWrittenDisclosure) {
    findings.push({ severity: 'pass', rule: 'written_disclosure', detail: 'explicit disclosure language in description' })
  } else {
    findings.push({ severity: 'fail', rule: 'written_disclosure', detail: 'description lacks clear sponsorship disclosure language — REQUIRED by FTC' })
  }

  // In-video disclosure
  if (input.inVideoDisclosureSec === null || !input.hasVerbalDisclosure) {
    findings.push({ severity: 'fail', rule: 'in_video_disclosure', detail: 'no clear in-video disclosure — FTC requires disclosure clear + conspicuous in the medium where the endorsement happens, not just description' })
  } else if (input.inVideoDisclosureSec > 30) {
    findings.push({ severity: 'warning', rule: 'in_video_timing', detail: `in-video disclosure at ${input.inVideoDisclosureSec}s — should be at start of sponsored segment per FTC guidance` })
  } else {
    findings.push({ severity: 'pass', rule: 'in_video_disclosure', detail: `clear in-video disclosure at ${input.inVideoDisclosureSec}s` })
  }

  // Disclosure timing relative to segment
  if (input.disclosureBeforeSegment) {
    findings.push({ severity: 'pass', rule: 'disclosure_timing', detail: 'disclosure precedes sponsored segment' })
  } else {
    findings.push({ severity: 'warning', rule: 'disclosure_timing', detail: 'disclosure after sponsored segment risks "buried" violation' })
  }

  // Hashtag-only
  if (input.hasAdHashtag && !input.hasVerbalDisclosure) {
    findings.push({ severity: 'warning', rule: 'hashtag_only', detail: 'FTC has indicated hashtag-only disclosure (#ad / #sponsored) is technically allowed but they prefer clearer disclosure — add verbal or text-overlay' })
  }

  // Affiliate links
  if (input.hasAffiliateLinks) {
    const affiliateDisclosed = /(affiliate|commission|i (?:earn|receive|get) (?:a |)(?:commission|small|kickback))/.test(desc)
    if (!affiliateDisclosed) {
      findings.push({ severity: 'fail', rule: 'affiliate_disclosure', detail: 'affiliate links require their own disclosure — separate from sponsorship disclosure' })
    } else {
      findings.push({ severity: 'pass', rule: 'affiliate_disclosure', detail: 'affiliate disclosure language present' })
    }
  }

  // COPPA
  if (input.targetingMinors) {
    findings.push({ severity: 'warning', rule: 'coppa', detail: 'content directed at minors triggers COPPA compliance + YouTube Made For Kids implications; consult specialised counsel' })
  }

  const failCount = findings.filter(f => f.severity === 'fail').length
  const warnCount = findings.filter(f => f.severity === 'warning').length
  const ok = failCount === 0
  const recommendation = failCount > 0
    ? 'DO NOT PUBLISH until failed items are fixed. FTC enforcement actions have targeted creators + brands for inadequate disclosure.'
    : warnCount > 0
      ? 'publishable but address warnings before next sponsored release'
      : 'disclosure compliant per common FTC interpretation (still recommend periodic compliance review)'

  return { ok, findings, recommendation }
}

// ── Music + image rights audit ────────────────────────────────────
export interface RightsAuditFinding {
  asset:       'music' | 'footage' | 'image' | 'ai_generated'
  source:      string
  status:      'licensed' | 'royalty_free' | 'fair_use_claimed' | 'unlicensed' | 'unknown'
  risk:        'low' | 'medium' | 'high' | 'critical'
  notes:       string
}

export function auditContentRights(items: Array<{
  asset:   'music' | 'footage' | 'image' | 'ai_generated'
  source:  string
  status:  RightsAuditFinding['status']
  details?: string
}>): { ok: boolean; findings: RightsAuditFinding[]; criticalCount: number; recommendation: string } {
  const findings: RightsAuditFinding[] = items.map(i => {
    let risk: RightsAuditFinding['risk']
    let notes = i.details ?? ''
    if (i.status === 'licensed' || i.status === 'royalty_free') {
      risk = 'low'
      if (!notes) notes = 'licensed asset — retain license proof + receipt'
    } else if (i.status === 'fair_use_claimed') {
      risk = 'medium'
      notes = 'fair use is fact-specific + jurisdiction-dependent; safer to license where possible. Have an attorney review the fair-use justification on file.'
    } else if (i.status === 'unlicensed') {
      risk = i.asset === 'music' ? 'critical' : 'high'
      notes = i.asset === 'music'
        ? 'unlicensed music = content-ID claims redirecting revenue + potential takedown. CRITICAL — replace with licensed library track (Epidemic / Artlist / Musicbed / Audiio).'
        : 'unlicensed asset — significant copyright exposure. Replace or license.'
    } else if (i.status === 'unknown') {
      risk = 'high'
      notes = 'source unknown — assume unlicensed until proven otherwise'
    } else {
      risk = 'medium'
    }
    if (i.asset === 'ai_generated') {
      notes += ' · AI-generated content rights are unsettled; the output may not be copyrightable + legal landscape evolving. Document training-data source if AI tool exposes it.'
    }
    return { asset: i.asset, source: i.source, status: i.status, risk, notes }
  })

  const criticalCount = findings.filter(f => f.risk === 'critical').length
  const highCount = findings.filter(f => f.risk === 'high').length
  const ok = criticalCount === 0 && highCount === 0

  const recommendation = criticalCount > 0
    ? 'DO NOT PUBLISH — critical rights issues must be resolved (typically: replace unlicensed music with library track)'
    : highCount > 0
      ? 'high-risk items present — resolve before publication or accept the risk + escrow the revenue at risk'
      : 'rights status acceptable'

  return { ok, findings, criticalCount, recommendation }
}

// ── Tax obligations tracker ───────────────────────────────────────
export interface TaxObligations {
  /** Quarterly estimated tax payments — US. */
  quarterlyEstimates: Array<{
    quarter:           'Q1' | 'Q2' | 'Q3' | 'Q4'
    dueDate:           string     // ISO YYYY-MM-DD
    estimatedAmountUsd: number
    paid:              boolean
  }>
  /** Sales tax nexus per US state. */
  salesTaxNexus: Array<{
    state:             string
    thresholdMetBy:    'revenue' | 'transactions' | 'physical_presence'
    registered:        boolean
    monthlyFilingDue:  string | null   // ISO date
  }>
  /** 1099 forms to reconcile against income recorded. */
  expected1099s: Array<{
    payerName:         string
    formType:          '1099-NEC' | '1099-MISC' | '1099-K'
    estimatedAmount:   number
    received:          boolean
  }>
  /** Retirement contribution opportunities not yet maxed. */
  retirementOpportunities: Array<{
    accountType:       'Solo_401k' | 'SEP_IRA' | 'Defined_Benefit'
    maxContributionUsd: number
    currentContributionUsd: number
    deadline:          string
  }>
  warnings: string[]
}

export function computeTaxObligations(input: {
  annualNetIncomeUsd:     number
  state:                  string
  effectiveTaxRate:       number   // 0..1
  revenueByState:         Record<string, number>
  transactionsByState?:   Record<string, number>
  expected1099s?:         Array<{ payerName: string; formType: '1099-NEC' | '1099-MISC' | '1099-K'; estimatedAmount: number }>
  retirementCurrentContributions?: { Solo_401k?: number; SEP_IRA?: number; Defined_Benefit?: number }
  year:                   number
}): TaxObligations {
  const warnings: string[] = [
    'General compliance estimates. Consult a qualified CPA in your jurisdiction.',
  ]

  // Quarterly estimates — IRS schedule: Apr 15, Jun 15, Sep 15, Jan 15 of next year.
  // Conservative split: 4 equal payments based on prior-year-equivalent.
  const annualLiability = input.annualNetIncomeUsd * input.effectiveTaxRate
  const quarterlyAmount = Math.round(annualLiability / 4)
  const quarterlyEstimates: TaxObligations['quarterlyEstimates'] = [
    { quarter: 'Q1', dueDate: `${input.year}-04-15`,     estimatedAmountUsd: quarterlyAmount, paid: false },
    { quarter: 'Q2', dueDate: `${input.year}-06-15`,     estimatedAmountUsd: quarterlyAmount, paid: false },
    { quarter: 'Q3', dueDate: `${input.year}-09-15`,     estimatedAmountUsd: quarterlyAmount, paid: false },
    { quarter: 'Q4', dueDate: `${input.year + 1}-01-15`, estimatedAmountUsd: quarterlyAmount, paid: false },
  ]

  // Sales tax nexus — most states use $100k revenue OR 200 transactions
  // as the economic nexus threshold (per Wayfair). California uses $500k.
  const salesTaxNexus: TaxObligations['salesTaxNexus'] = []
  for (const [state, revenue] of Object.entries(input.revenueByState)) {
    const transactions = input.transactionsByState?.[state] ?? 0
    const threshold = state === 'CA' ? 500_000 : 100_000
    const transactionThreshold = 200
    if (revenue > threshold) {
      salesTaxNexus.push({
        state, thresholdMetBy: 'revenue',
        registered: false, monthlyFilingDue: null,
      })
    } else if (transactions > transactionThreshold) {
      salesTaxNexus.push({
        state, thresholdMetBy: 'transactions',
        registered: false, monthlyFilingDue: null,
      })
    }
  }
  if (salesTaxNexus.length > 0) {
    warnings.push(`${salesTaxNexus.length} state(s) likely triggered sales-tax nexus — register + remit. Use Stripe Tax / TaxJar / Avalara.`)
  }

  // 1099 reconciliation
  const expected1099s: TaxObligations['expected1099s'] = (input.expected1099s ?? []).map(f => ({
    ...f, received: false,
  }))

  // Retirement opportunities — Solo 401k allows $66k + $7.5k catch-up
  // for 50+; SEP-IRA up to 25% of compensation (cap $66k); DB plans much
  // higher for older operators.
  const retirementOpportunities: TaxObligations['retirementOpportunities'] = []
  const solo401kMax = 66_000
  const solo401kCurrent = input.retirementCurrentContributions?.Solo_401k ?? 0
  if (solo401kCurrent < solo401kMax && input.annualNetIncomeUsd > solo401kMax) {
    retirementOpportunities.push({
      accountType: 'Solo_401k',
      maxContributionUsd: solo401kMax,
      currentContributionUsd: solo401kCurrent,
      deadline: `${input.year + 1}-01-15`,
    })
    warnings.push(`Solo 401k under-utilised: $${solo401kCurrent.toLocaleString()} of $${solo401kMax.toLocaleString()} max — spec calls this out as commonly under-utilised`)
  }

  // No-income-tax-state arbitrage flag
  const noIncomeStates = ['FL', 'TX', 'TN', 'WY', 'NV', 'SD', 'AK', 'NH', 'WA']
  if (input.annualNetIncomeUsd > 250_000 && !noIncomeStates.includes(input.state)) {
    warnings.push(`high earner ($${input.annualNetIncomeUsd.toLocaleString()}) in ${input.state} — no-income-tax-state arbitrage (FL/TX/TN/WY/NV/etc.) could save substantially; consult tax counsel`)
  }

  return { quarterlyEstimates, salesTaxNexus, expected1099s, retirementOpportunities, warnings }
}

// ── International tax flags ──────────────────────────────────────
export interface InternationalTaxFlag {
  flag:    'w8ben_required' | 'tax_treaty_eligible' | 'permanent_establishment_risk' | 'transfer_pricing_risk' | 'foreign_exchange_consideration' | 'cfc_implications'
  severity: 'info' | 'action_needed' | 'critical'
  description: string
  recommendedAction: string
}

export function checkInternationalTax(input: {
  operatorJurisdiction:   Jurisdiction
  earnsFromUsPlatforms:   boolean
  hasUsBusinessEntity:    boolean
  hasIntlContractors:     boolean
  intlAudiencePct:        number
}): InternationalTaxFlag[] {
  const flags: InternationalTaxFlag[] = []

  if (input.operatorJurisdiction !== 'US' && input.earnsFromUsPlatforms) {
    flags.push({
      flag: 'w8ben_required',
      severity: 'action_needed',
      description: 'Non-US person earning US-platform revenue — YouTube/TikTok withhold tax on US-source income',
      recommendedAction: 'file W-8BEN with each US platform; if your jurisdiction has a US tax treaty, claim reduced withholding rate',
    })
    flags.push({
      flag: 'tax_treaty_eligible',
      severity: 'info',
      description: `Operator jurisdiction ${input.operatorJurisdiction} likely has a tax treaty with US — withholding can drop from 30% to 0-15%`,
      recommendedAction: 'confirm treaty eligibility + file W-8BEN claiming treaty benefits',
    })
  }

  if (input.hasUsBusinessEntity && input.operatorJurisdiction !== 'US') {
    flags.push({
      flag: 'permanent_establishment_risk',
      severity: 'action_needed',
      description: 'Operating a US entity while resident elsewhere creates permanent-establishment + nexus questions',
      recommendedAction: 'engage international tax counsel before structuring',
    })
  }

  if (input.hasIntlContractors) {
    flags.push({
      flag: 'transfer_pricing_risk',
      severity: 'info',
      description: 'Cross-border payments to contractors trigger arm\'s-length pricing + documentation requirements',
      recommendedAction: 'maintain contractor agreements + invoices justifying fees as market rates',
    })
  }

  if (input.intlAudiencePct > 0.5) {
    flags.push({
      flag: 'foreign_exchange_consideration',
      severity: 'info',
      description: 'majority international audience — sponsor payments may arrive in foreign currencies',
      recommendedAction: 'multi-currency Stripe / Wise account; FX rate locks for large sponsor deals',
    })
  }

  return flags
}

// ── IP register ──────────────────────────────────────────────────
export interface IpRegisterEntry {
  kind:        'trademark' | 'copyright' | 'music_license' | 'image_license' | 'footage_license' | 'domain'
  asset:       string
  jurisdiction: string
  status:      'registered' | 'pending' | 'expired' | 'not_registered'
  registrationDate?: string
  expirationDate?:   string
  registrationNumber?: string
  /** Operator-attached notes (case references, vendor contact). */
  notes?:      string
}

/** Recommend IP actions based on operator scale + risk. */
export function recommendIpActions(input: {
  annualRevenueUsd:      number
  channelName:           string
  hasFlagshipBrand:      boolean
  usesMusic:             boolean
  usesStockFootage:      boolean
  currentRegister:       IpRegisterEntry[]
}): { actions: Array<{ priority: 'high' | 'medium' | 'low'; action: string; rationale: string }> } {
  const actions: Array<{ priority: 'high' | 'medium' | 'low'; action: string; rationale: string }> = []

  // Trademark
  const hasChannelTrademark = input.currentRegister.some(e => e.kind === 'trademark' && e.asset.toLowerCase().includes(input.channelName.toLowerCase()) && e.status === 'registered')
  if (input.hasFlagshipBrand && input.annualRevenueUsd > 100_000 && !hasChannelTrademark) {
    actions.push({
      priority: 'high',
      action: `register US trademark for "${input.channelName}"`,
      rationale: `revenue $${input.annualRevenueUsd.toLocaleString()} + flagship brand without trademark protection. $250-750 filing + legal assistance.`,
    })
  }

  // Music licensing
  if (input.usesMusic) {
    const hasMusicLib = input.currentRegister.some(e => e.kind === 'music_license' && e.status === 'registered')
    if (!hasMusicLib) {
      actions.push({
        priority: 'high',
        action: 'subscribe to a music library (Epidemic / Artlist / Musicbed / Audiio)',
        rationale: '$20-50/mo eliminates the largest single rights exposure for video content',
      })
    }
  }

  // Footage
  if (input.usesStockFootage) {
    const hasFootageLib = input.currentRegister.some(e => e.kind === 'footage_license' && e.status === 'registered')
    if (!hasFootageLib) {
      actions.push({
        priority: 'medium',
        action: 'subscribe to stock footage library (Storyblocks / Envato / Artgrid / Pond5)',
        rationale: 'consistent licensed footage source for B-roll',
      })
    }
  }

  // Expired licenses
  const now = Date.now()
  for (const e of input.currentRegister) {
    if (e.expirationDate && new Date(e.expirationDate).getTime() < now + 30 * 86_400_000 && e.status === 'registered') {
      actions.push({
        priority: 'high',
        action: `renew ${e.kind} for ${e.asset}`,
        rationale: `expires ${e.expirationDate} — within 30 days`,
      })
    }
  }

  // Copyright registration for high-value content
  if (input.annualRevenueUsd > 250_000) {
    const hasCopyrightReg = input.currentRegister.some(e => e.kind === 'copyright' && e.status === 'registered')
    if (!hasCopyrightReg) {
      actions.push({
        priority: 'medium',
        action: 'register copyright on flagship content',
        rationale: 'registration enables statutory damages + attorney fees in infringement suits',
      })
    }
  }

  return { actions }
}
