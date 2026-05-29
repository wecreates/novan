/**
 * financial-model.ts — Implements Part 3 of the spec.
 *
 * The spec's honest framing: "Building this is expensive, slow to
 * pay off, and only economical in specific configurations." This
 * service produces a realistic financial projection so the operator
 * can see whether their plan actually pencils.
 *
 * Inputs: business count, model-inference scale, team size, infra spend.
 * Outputs: burn rate, payback timeline, unit economics by configuration,
 * cost destroyers checklist, payback-acceleration options.
 */

export type Configuration = 'many_small_businesses' | 'one_high_volume' | 'specific_functions' | 'sell_the_platform'

export interface FinancialInputs {
  /** Current month index (1-based). Used to position projections. */
  monthIndex:           number
  /** People on the team. Burn = sum of comp ranges. */
  teamSize:             number
  averageTotalCompUsd:  number
  /** Active businesses operated by the brain. */
  businessCount:        number
  /** Monthly model inference cost (frontier + mid + small mix). */
  monthlyInferenceUsd:  number
  /** Monthly cloud + observability + SaaS. */
  monthlyInfraUsd:      number
  /** Monthly average revenue per business. */
  avgMonthlyRevenuePerBusinessUsd: number
  /** Configuration the operator is targeting. */
  configuration:        Configuration
}

export interface FinancialProjection {
  monthlyBurn: {
    personnelUsd:      number
    inferenceUsd:      number
    infraUsd:          number
    complianceUsd:     number
    totalUsd:          number
  }
  monthlyRevenue:      number
  monthlyNet:          number
  /** Months to break-even given current trajectory. Null if no path. */
  monthsToBreakEven:   number | null
  /** Estimated cumulative burn through break-even. */
  cumulativeBurnAtBreakEven: number | null
  /** Per-business unit economics. */
  unitEconomics: {
    revenuePerBusinessUsd: number
    opCostPerBusinessUsd:  number
    marginPerBusinessUsd:  number
    /** Marginal cost of business N+1. */
    marginalCostAdditionalBusiness: number
  }
  /** Comparison to traditional operating cost. */
  leverageComparison: {
    traditionalHeadcountForSameWork:  number
    brainHeadcountInUse:              number
    annualSavingsUsd:                 number
  }
  warnings:           string[]
}

const COMPLIANCE_MONTHLY = 8_000   // amortised SOC 2 + legal + insurance

export function projectFinancials(input: FinancialInputs): FinancialProjection {
  const warnings: string[] = []
  const personnelMonthly = (input.teamSize * input.averageTotalCompUsd) / 12
  const totalBurn = personnelMonthly + input.monthlyInferenceUsd + input.monthlyInfraUsd + COMPLIANCE_MONTHLY
  const monthlyRevenue = input.businessCount * input.avgMonthlyRevenuePerBusinessUsd
  const monthlyNet = monthlyRevenue - totalBurn

  // Months to break-even — depend on configuration trajectory.
  // Many-small: marginal cost per business low, revenue scales linearly with N.
  // One-high-volume: single business needs enough throughput.
  // Specific-functions: faster — apply brain to high-leverage functions across many ventures without full architecture.
  // Sell-platform: SaaS-like economics, different math.
  let monthsToBreakEven: number | null = null
  if (monthlyNet >= 0) {
    monthsToBreakEven = 0
  } else {
    // Assume revenue grows at configuration-specific rate; burn relatively flat.
    const monthlyRevGrowthPct = ({
      many_small_businesses: 0.10,   // 10%/mo (adding businesses + each compounds)
      one_high_volume:        0.05,
      specific_functions:     0.15,
      sell_the_platform:      0.20,
    })[input.configuration]
    if (monthlyRevGrowthPct === 0 || monthlyRevenue === 0) {
      monthsToBreakEven = null
      warnings.push('current revenue trajectory cannot reach break-even — re-examine configuration or accept this is permanent loss territory')
    } else {
      // Solve: revenue * (1+g)^m >= burn
      // m = log(burn/revenue) / log(1+g)
      const ratio = totalBurn / Math.max(1, monthlyRevenue)
      const months = Math.log(ratio) / Math.log(1 + monthlyRevGrowthPct)
      monthsToBreakEven = Math.min(60, Math.max(0, Math.round(months)))
      if (monthsToBreakEven > 36) {
        warnings.push(`break-even ${monthsToBreakEven} months out — that's > 3 years; configuration may not be viable without capital injection`)
      }
    }
  }

  const cumulativeBurnAtBreakEven = monthsToBreakEven !== null && monthsToBreakEven > 0
    ? Math.round(monthsToBreakEven * Math.abs(monthlyNet) * 0.6)   // 0.6 = revenue ramps so actual cumulative loss is < flat assumption
    : null

  // Unit economics.
  const opCostPerBusiness = (totalBurn - personnelMonthly * 0.4) / Math.max(1, input.businessCount)   // 0.4 = platform allocation
  const marginPerBusiness = input.avgMonthlyRevenuePerBusinessUsd - opCostPerBusiness
  // Marginal cost = mostly the per-business product owner + inference share.
  const marginalCostAdditionalBusiness = (200_000 / 12)                        // PM-owner monthly
                                       + (input.monthlyInferenceUsd / Math.max(1, input.businessCount)) * 0.5  // half the per-business inference

  // Leverage comparison vs traditional headcount.
  // Spec: a traditional 5-business operator might need 100-150 people;
  // brain-operated might need 30-50 across businesses + 15-25 platform.
  const traditionalHeadcountForSameWork = Math.round(input.businessCount * 20)   // 20/business is mid of 15-30
  const brainHeadcountInUse = input.teamSize
  const annualSavingsUsd = Math.max(0, (traditionalHeadcountForSameWork - brainHeadcountInUse) * input.averageTotalCompUsd)

  // Warning patterns from the spec.
  if (input.businessCount < 3 && input.configuration === 'many_small_businesses') {
    warnings.push('multi-business platform overhead doesn\'t amortise until ~3-5 businesses; break-even sits at ~5')
  }
  if (input.monthlyInferenceUsd > personnelMonthly * 0.5) {
    warnings.push(`inference spend $${input.monthlyInferenceUsd.toFixed(0)}/mo > 50% of personnel — investigate model-tier routing + caching; spec says 5-10x reduction possible`)
  }
  if (input.teamSize < 5 && input.monthIndex > 12) {
    warnings.push('team under 5 past month 12 — under-staffed teams ship slower, more fragile systems; apparent savings get consumed by remediation later')
  }
  if (input.businessCount === 1 && input.configuration === 'many_small_businesses') {
    warnings.push('one business with many-small-business configuration is wildly uneconomical compared to just hiring operators')
  }

  return {
    monthlyBurn: {
      personnelUsd:  Math.round(personnelMonthly),
      inferenceUsd:  input.monthlyInferenceUsd,
      infraUsd:      input.monthlyInfraUsd,
      complianceUsd: COMPLIANCE_MONTHLY,
      totalUsd:      Math.round(totalBurn),
    },
    monthlyRevenue: Math.round(monthlyRevenue),
    monthlyNet:     Math.round(monthlyNet),
    monthsToBreakEven,
    cumulativeBurnAtBreakEven,
    unitEconomics: {
      revenuePerBusinessUsd: Math.round(input.avgMonthlyRevenuePerBusinessUsd),
      opCostPerBusinessUsd:  Math.round(opCostPerBusiness),
      marginPerBusinessUsd:  Math.round(marginPerBusiness),
      marginalCostAdditionalBusiness: Math.round(marginalCostAdditionalBusiness),
    },
    leverageComparison: {
      traditionalHeadcountForSameWork,
      brainHeadcountInUse,
      annualSavingsUsd,
    },
    warnings,
  }
}

/** Common cost-destruction patterns from the spec. Surfaces the
 *  patterns + their fixes so operator can audit against current spend. */
export const COST_DESTROYERS: Array<{ pattern: string; signal: string; fix: string }> = [
  {
    pattern: 'Premature scaling',
    signal:  'Infrastructure provisioned for 10 businesses when you have one',
    fix:     'Architect for ≤2× current scale; refactor when you actually hit limits',
  },
  {
    pattern: 'Tool sprawl',
    signal:  '$20k+/mo on SaaS subscriptions; team can\'t name what half of them do',
    fix:     'Quarterly ruthless audit — anything unused for 90 days gets cancelled',
  },
  {
    pattern: 'Frontier-model default',
    signal:  'Routing every task to frontier models; cost 10-50× higher than necessary',
    fix:     'Use ai_product.recommend_tier (round 114) — cheapest passing tier per task',
  },
  {
    pattern: 'Unbounded experimentation',
    signal:  'AI inference spend spikes correlated with research / eval runs',
    fix:     'Apply cron-budget caps + experiment-specific kill-switch + cost-per-experiment budget',
  },
  {
    pattern: 'Premature human reduction',
    signal:  'Letting operational staff go in anticipation of automation that turns out not to work yet',
    fix:     'Wait for automation to PROVE itself for 90 days at full scope before reducing humans',
  },
]

/** Configurations the spec calls out as where this actually pays off. */
export const VIABLE_CONFIGURATIONS = [
  {
    id: 'many_small_businesses' as Configuration,
    name: 'Many small businesses',
    breakEvenPoint: '3-5 businesses depending on complexity',
    rationale: 'Platform overhead amortises across N. Running one business is wildly uneconomical; running ten is dramatically cheaper than hiring 200 operators.',
  },
  {
    id: 'one_high_volume' as Configuration,
    name: 'One business with very high operational volume',
    breakEvenPoint: 'Volume threshold where automation cost < replaced headcount cost',
    rationale: 'Enormous throughput that would otherwise need huge teams — brain pays off on volume alone.',
  },
  {
    id: 'specific_functions' as Configuration,
    name: 'Specific high-leverage functions across many ventures',
    breakEvenPoint: 'Faster than full automation',
    rationale: 'Apply the brain to lead qualification, content production, customer success across many businesses — without building the full architecture.',
  },
  {
    id: 'sell_the_platform' as Configuration,
    name: 'Build the brain as the product',
    breakEvenPoint: 'SaaS/services-business math',
    rationale: 'Sell the platform or operational capability to other businesses. Different economics entirely.',
  },
]

/** Configurations the spec calls out as NOT paying off. */
export const NON_VIABLE_CONFIGURATIONS = [
  'Single small business with modest operational needs',
  'Highly regulated industries where human accountability is legally required for most operations',
  'Businesses where the moat is taste/relationship/creativity and operational efficiency is not the constraint',
  'Operations where the cost of automation failure is catastrophic and the safety margin destroys the efficiency gains',
]

/** Payback-acceleration options from the spec. */
export const PAYBACK_ACCELERATORS = [
  {
    name: 'Start with successful businesses to migrate',
    tradeoff: 'Higher capital outlay (you bought businesses) but revenue exists from day one',
  },
  {
    name: 'Aggressive use of frontier capabilities with risk acceptance',
    tradeoff: 'Faster economics but additional failure risk; needs bankroll to absorb mistakes',
  },
  {
    name: 'Build the platform itself as the product',
    tradeoff: 'Different business model — SaaS/services rather than portfolio',
  },
  {
    name: 'Hybrid with substantial outsourcing',
    tradeoff: 'License much of the platform from emerging vendors; less ambitious technically, faster to economic viability',
  },
]
