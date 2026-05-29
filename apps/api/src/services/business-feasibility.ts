/**
 * business-feasibility.ts — Does the math close to $10k/mo on this niche?
 *
 * Every brain decision about a business should pass through this check
 * before the brain commits operator time or budget. The arithmetic is
 * deterministic — it's not an LLM guess, it's the per-platform unit
 * economics from the playbooks applied to the operator's stated numbers.
 *
 * Outputs include the gap to $10k and the SPECIFIC missing factor (more
 * views, higher RPM, larger basket, lower CAC) so the brain's next
 * suggestion is targeted instead of vague.
 *
 * This service is the single source of truth for the $10k floor. Any
 * route / brain-task op / autonomous loop that decides "should we
 * commit resources to this" reads it from here.
 */

export const FLOOR_USD = 10_000

export type BusinessCategory =
  | 'youtube'
  | 'pod'
  | 'social'        // pure social-platform business (TikTok Shop, X/Threads → newsletter funnel)
  | 'newsletter'
  | 'saas'
  | 'mixed'

export interface FeasibilityInput {
  category:  BusinessCategory
  /** Best-guess niche RPM in USD per 1000 views/impressions/reads.
   *  Pull from playbook tables when uncertain. */
  estRpmUsd?:        number
  /** For ad-share (youtube, social): expected monthly views/impressions.
   *  For POD: expected monthly sales (units).
   *  For newsletter: expected paying subscribers × ARPU. */
  estMonthlyVolume?: number
  /** POD only: average order value in USD. */
  avgOrderValueUsd?: number
  /** POD only: average unit margin after base cost. */
  marginPerUnitUsd?: number
  /** Channels in the portfolio (youtube category). Multi-channel math
   *  divides the target across N channels. */
  channelCount?:     number
  /** Working capital cap — caps the suggestable ad spend so the brain
   *  doesn't propose a $5k/mo Meta ads burn an operator can't fund. */
  workingCapitalUsd?: number
}

export interface FeasibilityResult {
  category:            BusinessCategory
  feasible:            boolean
  monthlyRevenueProjUsd: number
  gapToFloorUsd:       number      // floor - projected; 0 if on/over
  pctOfFloor:          number      // proj / floor, capped at 2.0
  bottleneck:          string      // the single weakest input
  /** Concrete numbers showing the path to close the gap. Each entry
   *  is one lever the operator could pull, with the magnitude required. */
  closers: Array<{
    lever:        string
    currentValue: number
    requiredValue: number
    deltaRequired: number
    /** Rough estimate of operator months to deliver, given known
     *  industry norms (e.g. "+50k YouTube subs takes ~3 months at
     *  3 vids/week if format works"). */
    estMonthsToDeliver: number
  }>
  /** Refusal reason if the input is so far off the floor that no
   *  realistic closer brings it home — brain refuses to start. */
  refusalReason?: string
  /** Honest caveats. */
  caveats: string[]
}

/** Default RPMs / margins / volumes the brain should assume when the
 *  operator hasn't supplied better numbers. These reflect the playbook
 *  tables (apps/api/knowledge/youtube-automation.md §3, §7;
 *  print-on-demand.md §6, etc.). */
const DEFAULTS = {
  youtube:    { rpm: 5,    monthlyViews: 200_000, channels: 1 },
  pod:        { aov: 24,   margin: 9, monthlyUnits: 100 },
  social:     { rpm: 1,    monthlyViews: 500_000 },          // TikTok Shorts-tier
  newsletter: { arpu: 8,   payingSubs: 600 },                 // $8/mo × 600 = $4800
  saas:       { mrr: 5_000 },                                 // baseline MRR estimate
  mixed:      { monthlyRev: 5_000 },
}

export function feasibility(input: FeasibilityInput): FeasibilityResult {
  const caveats = [
    `The $${FLOOR_USD}/mo floor is platform-wide and non-negotiable. Lower targets are refused.`,
    `These projections use the playbook tables; real RPMs/conversion drift ±30% from niche to niche.`,
    `Working capital is required for months 1–6 before revenue catches up (see multi-channel-operations.md §6).`,
  ]
  const result: FeasibilityResult = {
    category: input.category,
    feasible: false,
    monthlyRevenueProjUsd: 0,
    gapToFloorUsd: FLOOR_USD,
    pctOfFloor: 0,
    bottleneck: '(uncomputed)',
    closers: [],
    caveats,
  }

  switch (input.category) {
    case 'youtube': {
      const rpm      = input.estRpmUsd        ?? DEFAULTS.youtube.rpm
      const views    = input.estMonthlyVolume ?? DEFAULTS.youtube.monthlyViews
      const channels = Math.max(1, input.channelCount ?? DEFAULTS.youtube.channels)
      // YouTube's revenue share after their 45% Shorts cut + AdSense fees
      // averages ~55% of gross RPM in operator's pocket.
      const youtubeShare = 0.55
      const grossPerChannel = (views / 1000) * rpm * youtubeShare
      const proj = grossPerChannel * channels
      result.monthlyRevenueProjUsd = proj
      result.gapToFloorUsd         = Math.max(0, FLOOR_USD - proj)
      result.pctOfFloor            = Math.min(2, proj / FLOOR_USD)
      result.feasible              = proj >= FLOOR_USD
      // Pick the single weakest factor — the smallest input as ratio to its target.
      // The "target" for each input is what would individually close the gap.
      const requiredViewsPerCh = ((FLOOR_USD / youtubeShare) * 1000 / rpm) / channels
      const requiredRpm        = (FLOOR_USD / youtubeShare) * 1000 / (views * channels)
      const requiredChannels   = Math.ceil(FLOOR_USD / Math.max(1, grossPerChannel))
      result.closers = [
        {
          lever:           'monthly views per channel',
          currentValue:    views,
          requiredValue:   Math.round(requiredViewsPerCh),
          deltaRequired:   Math.max(0, Math.round(requiredViewsPerCh - views)),
          estMonthsToDeliver: views < requiredViewsPerCh ? 3 : 0,
        },
        {
          lever:           'effective RPM ($/1k views)',
          currentValue:    rpm,
          requiredValue:   Number(requiredRpm.toFixed(2)),
          deltaRequired:   Math.max(0, Number((requiredRpm - rpm).toFixed(2))),
          // RPM moves on niche selection, not on operator effort over time.
          // Either you're in a $10+ RPM niche or you aren't; pivot is ~1mo.
          estMonthsToDeliver: rpm < requiredRpm ? 1 : 0,
        },
        {
          lever:           'channel count',
          currentValue:    channels,
          requiredValue:   requiredChannels,
          deltaRequired:   Math.max(0, requiredChannels - channels),
          // Each new channel = ~30 days warmup + ~120 days to YPP Phase 2.
          estMonthsToDeliver: channels < requiredChannels ? 4 * Math.max(1, requiredChannels - channels) : 0,
        },
      ]
      result.bottleneck = pickBottleneck(result.closers)
      if (proj < FLOOR_USD * 0.05 && channels === 1 && views < 5_000) {
        result.refusalReason = `Single channel at < 5k views/mo cannot reach $10k/mo at any realistic RPM. Recommend portfolio approach (see multi-channel-operations.md §3).`
      }
      break
    }

    case 'pod': {
      const aov    = input.avgOrderValueUsd  ?? DEFAULTS.pod.aov
      const margin = input.marginPerUnitUsd  ?? DEFAULTS.pod.margin
      const units  = input.estMonthlyVolume  ?? DEFAULTS.pod.monthlyUnits
      const proj   = units * margin
      result.monthlyRevenueProjUsd = proj
      result.gapToFloorUsd         = Math.max(0, FLOOR_USD - proj)
      result.pctOfFloor            = Math.min(2, proj / FLOOR_USD)
      result.feasible              = proj >= FLOOR_USD
      const requiredUnits  = Math.ceil(FLOOR_USD / Math.max(1, margin))
      const requiredMargin = Math.ceil(FLOOR_USD / Math.max(1, units))
      result.closers = [
        {
          lever:           'units sold per month',
          currentValue:    units,
          requiredValue:   requiredUnits,
          deltaRequired:   Math.max(0, requiredUnits - units),
          estMonthsToDeliver: units < requiredUnits ? 3 : 0,
        },
        {
          lever:           'margin per unit ($)',
          currentValue:    margin,
          requiredValue:   requiredMargin,
          deltaRequired:   Math.max(0, requiredMargin - margin),
          // Margin lifts via pricing test or product mix shift — fast.
          estMonthsToDeliver: margin < requiredMargin ? 1 : 0,
        },
        {
          lever:           'average order value',
          currentValue:    aov,
          requiredValue:   Math.max(aov, 35),  // bundle to $35+ AOV via cross-sell
          deltaRequired:   Math.max(0, 35 - aov),
          estMonthsToDeliver: 1,
        },
      ]
      result.bottleneck = pickBottleneck(result.closers)
      if (margin < 4) {
        result.refusalReason = `Per-unit margin < $4 cannot support paid traffic at any reasonable scale. Either raise pricing or change product mix (see print-on-demand.md §6).`
      }
      break
    }

    case 'social': {
      const rpm   = input.estRpmUsd        ?? DEFAULTS.social.rpm
      const views = input.estMonthlyVolume ?? DEFAULTS.social.monthlyViews
      const proj  = (views / 1000) * rpm
      result.monthlyRevenueProjUsd = proj
      result.gapToFloorUsd         = Math.max(0, FLOOR_USD - proj)
      result.pctOfFloor            = Math.min(2, proj / FLOOR_USD)
      result.feasible              = proj >= FLOOR_USD
      const requiredViews = Math.ceil(FLOOR_USD * 1000 / Math.max(0.5, rpm))
      result.closers = [
        {
          lever:           'monthly views/impressions',
          currentValue:    views,
          requiredValue:   requiredViews,
          deltaRequired:   Math.max(0, requiredViews - views),
          // Social volume needs 4–6 months of consistent posting + a hit.
          estMonthsToDeliver: views < requiredViews ? 5 : 0,
        },
        {
          lever:           'monetization path (add affiliate / sponsorship / direct product)',
          currentValue:    rpm,
          requiredValue:   Math.max(3, rpm),  // bare minimum sustainable RPM
          deltaRequired:   Math.max(0, 3 - rpm),
          estMonthsToDeliver: 2,
        },
      ]
      result.bottleneck = pickBottleneck(result.closers)
      caveats.push('Pure social-only businesses rarely hit $10k/mo without an external monetization layer (newsletter, course, product). Plan that layer at month 1, not month 6.')
      if (rpm < 0.5 && views < 100_000) {
        result.refusalReason = `Pure ad-share social at < $0.50 RPM × < 100k views cannot reach $10k/mo. Layer a monetization vector first.`
      }
      break
    }

    case 'newsletter': {
      const arpu = input.estRpmUsd        ?? DEFAULTS.newsletter.arpu       // re-using estRpmUsd as $/sub/mo for newsletter
      const subs = input.estMonthlyVolume ?? DEFAULTS.newsletter.payingSubs
      const proj = arpu * subs
      result.monthlyRevenueProjUsd = proj
      result.gapToFloorUsd         = Math.max(0, FLOOR_USD - proj)
      result.pctOfFloor            = Math.min(2, proj / FLOOR_USD)
      result.feasible              = proj >= FLOOR_USD
      const requiredSubs = Math.ceil(FLOOR_USD / Math.max(1, arpu))
      result.closers = [
        {
          lever:           'paying subscribers',
          currentValue:    subs,
          requiredValue:   requiredSubs,
          deltaRequired:   Math.max(0, requiredSubs - subs),
          // Paying subs grow ~30/month for a healthy newsletter at month 6+.
          estMonthsToDeliver: subs < requiredSubs ? Math.ceil((requiredSubs - subs) / 30) : 0,
        },
        {
          lever:           'average revenue per paying user ($/mo)',
          currentValue:    arpu,
          requiredValue:   Math.max(arpu, 15),
          deltaRequired:   Math.max(0, 15 - arpu),
          estMonthsToDeliver: 2,
        },
      ]
      result.bottleneck = pickBottleneck(result.closers)
      break
    }

    case 'saas': {
      const mrr = input.estMonthlyVolume ?? DEFAULTS.saas.mrr
      result.monthlyRevenueProjUsd = mrr
      result.gapToFloorUsd         = Math.max(0, FLOOR_USD - mrr)
      result.pctOfFloor            = Math.min(2, mrr / FLOOR_USD)
      result.feasible              = mrr >= FLOOR_USD
      result.closers = [{
        lever:           'monthly recurring revenue (MRR)',
        currentValue:    mrr,
        requiredValue:   FLOOR_USD,
        deltaRequired:   Math.max(0, FLOOR_USD - mrr),
        estMonthsToDeliver: mrr < FLOOR_USD ? 6 : 0,
      }]
      result.bottleneck = 'MRR'
      caveats.push('SaaS reaches $10k MRR via paid acquisition + retention; the brain can plan content + UX but cannot replace customer-development conversations.')
      break
    }

    case 'mixed':
    default: {
      const rev = input.estMonthlyVolume ?? DEFAULTS.mixed.monthlyRev
      result.monthlyRevenueProjUsd = rev
      result.gapToFloorUsd         = Math.max(0, FLOOR_USD - rev)
      result.pctOfFloor            = Math.min(2, rev / FLOOR_USD)
      result.feasible              = rev >= FLOOR_USD
      result.closers = [{
        lever:           'total monthly revenue',
        currentValue:    rev,
        requiredValue:   FLOOR_USD,
        deltaRequired:   Math.max(0, FLOOR_USD - rev),
        estMonthsToDeliver: rev < FLOOR_USD ? 6 : 0,
      }]
      result.bottleneck = 'total monthly revenue'
      break
    }
  }

  return result
}

function pickBottleneck(closers: FeasibilityResult['closers']): string {
  if (closers.length === 0) return '(none)'
  // The bottleneck is the lever requiring the LARGEST relative change.
  let worst = closers[0]!
  let worstRatio = -Infinity
  for (const c of closers) {
    const ratio = c.currentValue > 0 ? (c.deltaRequired / c.currentValue) : Infinity
    if (ratio > worstRatio) { worstRatio = ratio; worst = c }
  }
  return worst.lever
}
