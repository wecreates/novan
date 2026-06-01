# Pricing psychology — getting paid what you're worth

Pricing is the single highest-leverage variable in a business after product-market fit. A 10% price increase often produces zero churn and 10% more revenue dropping straight to bottom line. A 10% increase poorly executed produces 30% churn and a wrecked relationship with the market. The difference is psychology and execution, not the number itself.

## What the operator should remember

- Most operators systematically underprice. They benchmark against competitors who are also underpricing.
- Price is signal of value. A $9/mo SaaS is perceived as 1/10 the quality of a $99/mo SaaS, even when functionally equivalent. Customers self-select by tier.
- Anchoring beats absolute pricing. A $99 plan presented next to a $299 plan looks cheap; presented alone it looks expensive.
- Decision fatigue at checkout is real. 4 plan options = too many; 3 is the sweet spot; 2 is fine for simple offers.

## The five pricing models (pick one cleanly)

### 1. Per-seat / per-user
- Best for: B2B SaaS, team-collaboration tools, anything with linear value per user
- Example: $15/user/month
- Strength: scales naturally with customer growth
- Weakness: incentivizes account sharing; large teams underbuy

### 2. Per-usage / metered
- Best for: AI/API products, infrastructure, anything with variable cost
- Example: $0.01 per request, $5 per hour of compute
- Strength: pay-for-value; low entry cost
- Weakness: bill-shock risk; harder to forecast; sticker shock on power users

### 3. Tiered (Good-Better-Best)
- Best for: Mass-market SaaS, ecommerce, courses, almost everything
- Example: $29 / $99 / $299 per month
- Strength: customers self-select; anchoring effect
- Weakness: requires thoughtful tier-differentiation; tier-creep is real

### 4. Flat / single price
- Best for: Info-products, single-purpose tools, services
- Example: $497 one-time for a course
- Strength: dead simple; no decision fatigue
- Weakness: leaves money on the table from high-budget customers

### 5. Value-based / custom
- Best for: Enterprise B2B, consulting, anything with $100k+ deal sizes
- Example: "let's talk" pricing, negotiated per customer
- Strength: maximum price extraction; relationship-based
- Weakness: doesn't scale; sales-heavy; longer cycles

The brain's `business.feasibility` analyzer assumes Model 3 by default and shifts to Model 5 only for explicit B2B/enterprise positioning.

## The Good-Better-Best architecture

For most operators, three tiers wins:

### Good (entry / individual)
- Price: 30-40% of Better
- Target: solo operators, small users, first-time customers
- Feature set: enough to deliver real value standalone; clearly missing features expected at the next tier
- Conversion role: low barrier to entry, allows market education

### Better (the intended choice)
- Price: anchor here. This is where 60-70% of customers should land.
- Target: mainstream of your audience
- Feature set: everything an average customer needs; the "good enough" tier
- Conversion role: this is the tier the page is designed to sell

### Best (the anchor)
- Price: 3-5x Better
- Target: power users + price-insensitive segment
- Feature set: everything in Better + unlimited-something + concierge-something + early-access
- Conversion role: makes Better look reasonable by comparison; captures top 10-20% with high willingness-to-pay

The Best tier matters even if few customers pick it. Without it, Better looks like "the expensive option." With it, Better looks like "the smart choice."

## Pricing psychology levers

### Anchoring
- Always show the original price next to discounted price
- Show monthly equivalent of annual plans next to monthly price
- Place high-tier first or in the visual middle (not last) to anchor perception

### Reference pricing
- "Most popular" or "Best value" badges shift selection toward that tier by 20-40%
- Comparison to other industries / costs ("less than a coffee per day") works for low prices
- For higher prices, compare to ROI not cost ("pays for itself in 2 weeks")

### Charm pricing ($X.99 vs $X)
- Real effect: $29 vs $30 reads ~5-15% cheaper psychologically
- BUT: charm pricing signals "budget" — premium brands round
- Use $X.99 for entry tier; round prices for premium tier

### Decoy effect
- Add a deliberately bad-value option to make your intended option look better
- Example: 3 plans at $9, $24, $25 → most pick $25 because it's barely more than $24 for much more
- The brain flags decoys during plan design via `experiment.create` so the effect is measured

### Loss aversion
- "Save $X" outperforms "Get $X off" — people fear losing more than they enjoy gaining
- "Cancel anytime" reduces commitment anxiety more than long money-back guarantee

### Trial vs. money-back guarantee
- Free trial works for SaaS where credit card capture is fine
- 30-day money-back guarantee works better for info-products / digital goods where capture > trial
- Both reduce friction but for different reasons: trial = no commitment; guarantee = no risk

## When and how to raise prices

### Signals to raise:
- Conversion rate >7% on cold paid traffic = leaving money on table
- Customer comments containing "this should cost more" or "I'd pay 3x for this"
- Major feature additions since last price change
- Comparable competitors charging 1.5-2x
- Inflation / cost increases on your side
- 12+ months since last price change

### How to raise:
1. **Announce 30-60 days in advance** to existing customers — gives them choice + reduces shock
2. **Grandfather existing customers** for a defined period (typically 12 months) — preserves trust
3. **Frame around added value** — "since last year we shipped X, Y, Z; pricing now reflects expanded scope"
4. **Test on new customers first** — run the new price for 30 days against a holdout cohort before universalizing
5. **Measure the right thing** — conversion may drop 10-20% short-term; revenue per visitor is the real metric

### Common mistakes:
- Doing it silently (creates bill-shock + churn)
- Doing it for new customers only forever (eventually grandfathering creates a 2-tier system)
- Doing it during a market downturn or competitor crisis (badly timed)
- Doing it without grandfathering (kills trust + word-of-mouth)

## Discounts — when they work and when they kill you

### Work:
- One-time annual prepay discount (10-20% off for prepayment): improves cash flow, mild commitment
- New-customer first-month discount (capped at 50%): acquisition tool, controlled
- Loyalty discount for 12+ month customers: retention tool, signals appreciation
- Volume discounts on per-seat (10+ seats): scales with customer commitment
- Sunset clearance pricing on deprecated products: clean inventory exit

### Kill you:
- Universal coupon codes on the public site (race to the bottom)
- Anchoring permanent discount of "50% off forever" (training customers to wait for sales)
- "Last chance" pressure tactics with no actual deadline (destroys trust on second exposure)
- Cohort-specific discounts that leak between cohorts ("my friend got 30% off; can I?")
- Coupons larger than your gross margin

## Free tiers — strategic considerations

Free tiers work when:
- Network effects: each user makes the product more valuable for everyone (Slack, Notion)
- Loss-leader: free product drives paid upsell to related services (Hubspot CRM → marketing tools)
- Viral / referral: free users invite paid users (Calendly, Loom)

Free tiers fail when:
- Heavy infrastructure cost per free user (AI products, video, storage)
- Free tier eats core paid use case (free customers don't upgrade)
- Free users dominate support load (1% conversion + 99% support cost)

The brain's `business.feasibility` analyzer requires explicit modeling of free-tier economics before recommending one.

## Pricing pages — what converts

### Above the fold:
- 3 plan options, "Most Popular" badge on middle
- Annual/Monthly toggle (default to annual to anchor higher reference)
- One-line plan descriptions (5-8 words each)
- Primary CTA per plan that's outcome-language ("Start growing")

### Below the fold:
- Feature comparison table — limit to 12-15 rows max
- Social proof (testimonials, logos, "10,000+ businesses use this")
- FAQ section addressing real objections (refund policy, cancel anytime, support response time)
- Trust elements (security badges, guarantees, vendor logos like Stripe)

### What to A/B test (in priority order):
1. Price points themselves (do NOT fear testing higher)
2. Annual vs. monthly default
3. Plan name and positioning
4. Most-popular badge placement
5. Number of plans (2 vs 3 vs 4)
6. Charm pricing vs. round pricing

The brain's `prompt_ab` framework (R146.90) can be used to A/B-test pricing pages, but plan-architecture changes warrant longer test windows (4+ weeks each).

## What the brain MUST NOT do

- Change prices on existing customers without explicit operator approval, even within autonomy budget (price is sacred)
- Show different prices to different visitors based on detected wealth signals (dark pattern; backlash + legal risk)
- Run "limited-time" countdowns that reset on page reload (fake scarcity)
- Hide pricing behind contact-sales when target market expects self-serve (kills top-of-funnel)
- Bury cancellation/refund mechanisms in fine print

## Cost economics

Pricing-page work is essentially free in materials; the cost is:
- Test cycle time (4-12 weeks per real test)
- Risk of getting it wrong on existing customers (churn cost)
- Operator decision fatigue (recommend max 2 pricing tests per quarter)

ROI: a single successful price increase of 10% can produce $1k-$50k+/mo in extra revenue depending on scale, sustained forever, with effort measured in days.

## Integration with the rest of the stack

- **Business-feasibility** — pricing assumptions drive LTV projections; small changes cascade significantly
- **Conversion-optimization** — pricing page IS a conversion surface
- **Customer-retention** — pricing changes cause known churn; retention strategy must account
- **Experiments framework (R146.86)** — every pricing change is logged as an experiment with predicted churn + revenue impact
- **CEO-strategic** — pricing is part of capital allocation reasoning; underpriced products attract underpriced customers

## What "good" looks like

- Operator confidence in the price (not apologetic)
- Conversion rate 2-5% on cold paid traffic for B2C, 0.5-2% for B2B
- "Better" tier captures 60-70% of paid customers
- Top tier captures 5-15% of paid customers
- Annual prepay rate >40% if offered with 10-20% discount
- Price increase every 12-18 months (matched to value delivery)
- Net Revenue Retention >100% (expansion exceeds churn)
