# Affiliate marketing — leveraging other people's audiences

Affiliate marketing turns the audience-acquisition problem into a payments-and-attribution problem. Instead of paying upfront for traffic, you pay a percentage of revenue only when a sale closes. Done well, it's the highest-ROI acquisition channel that exists. Done badly, it attracts spammy partners who damage brand trust and produce low-quality buyers who refund.

## What the operator should remember

- Affiliate revenue compounds slowly but durably. A good affiliate program produces 15-40% of total revenue at maturity.
- The wrong incentive structure produces the wrong partners. 50%+ commission attracts list-spammers; 5-10% commission attracts thoughtful curators.
- Cookie windows matter. 30-day attribution is industry standard; 90-day is partner-friendly; 24-hour is hostile and gets you few partners.
- Top affiliates are rare. Out of 100 active partners, typically 5-10 produce 80%+ of the revenue. Manage those 5-10 like employees, not affiliates.

## Affiliate types — recognize and treat differently

### 1. Content creators
- Bloggers, YouTubers, newsletter authors, podcasters, social-media personalities
- Higher buyer quality (audience already knows the partner's voice/judgment)
- Need: persuasive content + clear product education
- Compensation: 10-30% commission, 30-90 day cookie, occasional flat-fee for featured placement

### 2. Niche aggregators
- Comparison sites, review aggregators, deals/coupon sites
- Lower-intent buyers but higher volume
- Need: data feeds (pricing, features, in-stock), competitive positioning
- Compensation: 5-15% commission, 7-30 day cookie

### 3. Coupon / cashback platforms
- Honey, Rakuten, RetailMeNot, Capital One Shopping
- Largely intercept buyers who would have purchased anyway — last-click attribution
- Often a net cost rather than acquisition channel
- Decision: only join if competitor presence forces you to (or fully exclude from your affiliate program)

### 4. Industry influencers
- Specific authority in niche (e.g., a developer-tooling YouTuber for a SaaS dev tool)
- Highest conversion rate, lowest volume
- Need: relationship building, product fit, comp creative latitude
- Compensation: revenue share + occasional flat retainer for major launches

### 5. Power users / customer-advocates
- Existing customers who refer enough that they earn affiliate revenue
- Cheapest, highest-quality leads
- Need: easy referral mechanism + meaningful reward
- Compensation: cash credit toward their account OR a small flat per referral

The brain auto-categorizes partners via `influencer.add` (R146.92) when adding to the affiliate program.

## Commission structures — what actually works

| Product type | Commission | Cookie | Notes |
|---|---|---|---|
| Digital info-product / course | 30-50% | 30-90 days | High margin; affiliates expect a real cut |
| Physical product / POD | 5-15% | 30 days | Lower margin; volume play |
| SaaS subscription | 20-30% of first 12 months | 60 days | Revshare model standard |
| Annual or one-time SaaS | 15-25% | 60 days | One-time payout |
| Service business | 10-15% flat | 90 days | Reflect longer sales cycle |

Beyond the table:
- **Tiered commission**: $X for first 10 sales/mo, $Y for 11-30, $Z for 31+. Rewards partners who scale with you.
- **Bonus on cohort retention**: partner gets extra if their referrals are still customers at month 6. Aligns incentives with quality, not just volume.
- **Anti-self-referral**: explicit terms preventing partners from referring themselves or family. Audit randomly.

## The program launch sequence

### Phase 1: Foundation (week 1-2)
- Pick a network/platform: Impact, PartnerStack, Rewardful, Tapfiliate for SaaS; ShareASale or CJ for ecommerce; LemonSqueezy or Lemon Squeezy's built-in for digital products
- Define commission tiers + cookie window
- Write partner-facing materials: program description, swipe-copy, banner library, product feed
- Set up tracking: ensure every checkout properly captures the affiliate cookie
- Configure payouts: minimum threshold ($50 typical), payout cadence (monthly typical), PayPal/Stripe-Connect/wire options

### Phase 2: Seed (week 3-6)
- Recruit 5-10 existing customers as founding affiliates (they already love you; pay them well)
- Recruit 5-10 nano/micro influencers in your exact niche (don't go broad)
- Provide premium materials + 1:1 onboarding for the first 10 partners
- Track every signup, sale, and payout meticulously — the program's reputation forms in this phase

### Phase 3: Scale (month 2-6)
- Open broader recruitment via your blog/email/social
- List in 2-3 affiliate-program directories (specific to your category)
- Launch a partner newsletter (monthly) with: top-performers spotlights, conversion-rate tips, new product/launch heads-up, fresh creative assets
- Run a referral contest 2x/year for additional motivation

### Phase 4: Optimize (month 6+)
- Quarterly partner-performance review
- Deprecate dormant partners (no sales in 6 months) to reduce noise
- Double down on top 10% via direct relationship building
- Launch new tiers / bonus structures based on data

## Fraud prevention

Affiliate fraud takes real money. Detect:

- Self-referral (partner buying through own link): check for IP match, payment-method match, address match
- Cookie stuffing (force-loading affiliate cookies on unrelated traffic): audit traffic source quality monthly
- Trademark bidding on paid search: forbid in TOS; spot-check via brand-name SERP audits
- Coupon-leak (partners posting "exclusive" codes publicly to capture all traffic): require unique tracking per partner instead of shared codes

The brain monitors via `social.audienceOverlap` patterns + payment-method anomalies + traffic-source review when an attribution payment exceeds typical thresholds.

## Compliance + legal

- FTC disclosure: every partner must disclose the affiliate relationship in posts/videos/etc. Make it a requirement; provide template disclosure language.
- Tax forms: collect W-9 (US) or W-8 (international) from partners exceeding $600/year in earnings (US threshold).
- Terms of service: forbid trademark bidding, cookie-stuffing, spam, misleading claims. Reserve right to clawback fraudulent payments.
- GDPR/CCPA: respect partner-region data laws; offer EU-compliant tracking option (cookieless attribution if needed)

## Cost economics

For a business at $10k MRR with an affiliate program:
- Setup: $0-$500 (platform free tier or first-month fee)
- Ongoing platform cost: $50-$500/mo (scales with partner count + GMV)
- Average commission paid: 15-25% of affiliate-attributed revenue
- Typical affiliate contribution at maturity: 15-30% of total revenue (so paying 3-7% blended commission across all revenue)
- Net margin impact: substantially positive vs. paid ads at equivalent CAC

A well-run affiliate program is one of the few channels where Year 2 produces 3-5x Year 1 results at the same effort level — partners compound.

## What the brain MUST NOT do

- Sign up customers as affiliates without operator approval
- Pay out commissions before standard verification window (typically 30 days for refund-period coverage)
- Lower commission rates for active partners without explicit notice + grandfathering
- Run affiliate programs alongside coupon/cashback intermediaries without explicit attribution rules — double-pay is a real risk
- Take down affiliate links during a sale without warning partners (destroys trust + reduces future participation)

## Integration with the rest of the stack

- **Influencer-discovery (R146.92)** — affiliate prospects come from the same pipeline as paid-influencer outreach; the brain treats the affiliate path as a non-cash version of the same relationship
- **Email-marketing** — affiliates often manage their own list; provide a "partner newsletter you can forward" each month
- **Conversion-optimization** — landing pages for affiliate traffic often perform better with custom headlines that reference the referring source's voice
- **Attribution tracking** — affiliate revenue must show in `business_revenue` with `source='affiliate'` for proper LTV-per-channel comparison
- **Autonomy-budget (R146.97)** — commission payouts can be automated within operator-set ceilings without per-payout approval

## What "good" looks like

For a mature affiliate program at a $30k+ MRR business:
- 50-200 active partners (those producing at least one sale per quarter)
- 5-10 top partners producing 60-80% of revenue
- Average partner LTV (referrals retained × commission): >5x acquisition cost
- Time-to-first-sale for new partners: <60 days
- Refund rate on affiliate-driven sales: within 1-2% of direct sales (proves quality of traffic)
