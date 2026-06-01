# Customer retention — defending the cash you've already earned

Acquisition is expensive. Retention is where margin compounds. A business with 5% monthly churn loses half its customers every 14 months and has to refill the bucket constantly. A business with 1% monthly churn doubles its LTV at the same revenue scale and can spend 3-4x more on acquisition profitably. Retention is not a separate function — it is the lever that makes everything else economic.

## What the operator should remember

- A 5% lift in retention rate is worth more than a 50% lift in conversion for most subscription businesses past month 6.
- Most churn happens in the first 30 days. If you can keep a customer 30 days, you usually keep them 6+ months.
- The biggest cause of churn is not pricing — it's failure to reach the "aha moment" in the first session.
- Customers who use a feature within 7 days of signup are 4-8x more likely to be active at 90 days.

## The retention funnel

Five stages, each with its own intervention. Loss at any stage kills LTV.

### 1. Activation (signup → first value)
- Operator target: 60%+ of new signups complete the activation event (first key action) within 24 hours
- Common interventions: onboarding email sequence (covered in email-marketing.md), in-app tutorial, hand-holding first session, "did you mean to do X?" nudges after 30 minutes of inactivity
- The brain monitors: % activated, time-to-first-key-action, drop-off points in onboarding flow

### 2. Habit formation (week 1-4)
- Operator target: 40%+ of activated users complete 3+ sessions in the first 14 days
- Common interventions: daily/weekly value-reminder emails, first-week milestone celebrations, social proof of other users' progress, community invitations
- The brain monitors: session frequency, feature breadth, segment leading indicators of long-term retention

### 3. Habit consolidation (month 1-3)
- Operator target: 60%+ of week-1-engaged users return in week 4
- Common interventions: progress reports, comparative analytics ("you've achieved X% more than last month"), feature deepening prompts, peer connection
- The brain monitors: 30-day retention by acquisition cohort, feature-usage breadth, customer-success-correlated patterns

### 4. Maturity (month 3+)
- Operator target: <2% monthly churn for mature cohorts
- Common interventions: case-study features, beta-program invitations, expansion offers (upgrade tier, add seats), advisory-board invites, anniversary recognition
- The brain monitors: NPS by tenure, expansion revenue %, advocacy actions (referrals, reviews, mentions)

### 5. Re-engagement (dormant → returned)
- Operator target: 15-25% of dormant (30d+ inactive) users return after a re-engagement campaign
- Common interventions: win-back email sequence (see email-marketing.md), specific feature-update notification matching their previous usage pattern, one-time discount with expiration
- The brain monitors: re-engagement rate by trigger, depth of return engagement, second-chance churn rate

## Segmentation by retention pattern

Not all customers are equal. The brain auto-categorizes:

- **Champions** — top 10% by activity + revenue. Treat as advisors. Survey them quarterly. Feature their stories. They drive the case studies that drive new acquisition.
- **Stable Core** — 30-40% of base, steady usage, on-time payments. Don't disturb them. Monthly value-recap is enough.
- **At Risk** — recently dropped session frequency or last login >14d ago. Triggered intervention immediately: usage check-in, support outreach, problem-solving help.
- **Dormant** — 30-90d inactive but still paying. Re-engagement sequence. If no response after 3 attempts in 21 days, accept the loss and stop sending (deliverability).
- **Lost** — 90d+ inactive and not paying. Annual win-back attempt only. Don't waste effort.

The brain runs this segmentation weekly via `segment.list` (R146.89) and surfaces the at-risk segment in the Monday briefing.

## The metrics that matter (in priority order)

1. **Net Revenue Retention (NRR)** — most important single metric for subscription. 100%+ = revenue from existing customers grows over time (expansion exceeds churn). World-class SaaS targets 120%+; 100-110% is sustainable.
2. **Logo retention** — % of customers (not revenue) retained over a period. Useful for spotting tiered-pricing distortion (big customers stay, small ones churn).
3. **Cohort retention curve** — month 1, 3, 6, 12 retention by signup cohort. Surfaces whether interventions actually shifted the curve over time.
4. **Time to second value event** — proxy for whether the product is sticky beyond initial novelty. Watching it shorten = positive signal.
5. **Feature breadth** — number of distinct features used. Customers using 4+ features have dramatically higher retention than 1-2 feature users.

Avoid: vanity metrics like "total customers ever", "average session duration" (without distinguishing engaged from confused).

## Pricing and retention

Pricing changes drive churn at predictable rates:
- 10-15% price increase: 2-5% churn spike in the next 30-60 days, then stabilization
- 20-30% increase: 8-15% churn — only do this if you have data showing customers underprice the value
- Grandfathering existing customers: avoids the churn spike but trains future ones to wait for grandfathering
- Tiered upgrades vs. flat increase: tiered loses fewer customers but extracts less revenue per customer

The brain models pricing changes via `economic.simulatePricing` before recommending.

## Service-quality drivers of retention

These have larger effect on retention than most operators expect:

- **Response time to support tickets:** <4h response correlates with 2-3x lower 60-day churn than 24h+ response
- **First-contact resolution rate:** >70% FCR correlates with NRR 5-10% higher than <50% FCR
- **Proactive outreach:** customers reached out to before they raise a complaint churn at half the rate of those who reach out first
- **Resolution within 48h:** even unresolved-but-actively-worked tickets retain better than slow-or-silent ones

The brain monitors support-ticket lifecycle when connected to the operator's CRM or helpdesk.

## What the brain MUST NOT do

- Manipulate retention by adding friction to cancellation flows (dark pattern; backlash damages NPS more than it saves churn)
- Spam dormant users to "remind them" they're still paying — they know, and the reminder triggers cancellation
- Move customers between tiers without explicit consent (always operator-approved)
- Suppress refund requests; an immediate refund preserves the relationship better than a hostile decline
- Run loyalty surveys that ask for testimonials; they're transparent extraction and produce nothing useful

## Integration with the rest of the stack

- **Email-marketing** — flow templates for activation, abandonment, post-purchase, win-back
- **Customer-segments (R146.89)** — defines who gets which intervention
- **Business-architecture** — runway calculation includes retention as input to LTV projection
- **CEO-strategic** — retention degradation triggers capital reallocation toward existing-customer ops
- **Experiments framework (R146.86)** — every retention intervention is logged as an experiment with a falsifiable prediction; outcomes feed calibration

The Monday operator-briefing surfaces: retention trend by cohort, at-risk segment size + recommended intervention, NRR vs target, top 3 churn-driver hypotheses with evidence.

## What "good" looks like

For a $10k-MRR business:
- Logo retention: 90%+ monthly (10% or less monthly churn)
- NRR: 105%+ (expansion exceeds churn)
- Time to 2nd-value event: <14 days
- At-risk segment: <15% of active base
- Support response: <8h median, <24h p95

A business below those bars is leaking. Fix retention before increasing acquisition spend, or the spend just refills the bucket without growing the base.
