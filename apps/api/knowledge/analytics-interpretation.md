# Analytics interpretation — making numbers tell you something

Most businesses drown in numbers and act on none of them. Dashboards become wallpaper. The point of analytics is decisions — if a metric won't change a decision, don't measure it; if it will, measure it carefully and respond to changes meaningfully. The brain's role is to surface the signals that matter and ignore the noise that doesn't.

## What the operator should remember

- Almost every metric moves on its own. Distinguishing real change from noise requires statistical rigor.
- A 20% week-over-week drop in a metric with 100 daily samples could easily be noise. The same drop with 10,000 samples is signal.
- Lagging indicators (revenue, retention) feel important but you can't fix what happened last quarter. Leading indicators (engagement, activation) tell you what's coming.
- Composite metrics (NPS, "customer health") hide what's driving them. Always decompose before acting.

## The five analytics layers, ordered by leverage

### 1. Acquisition (top of funnel)
- Sessions, unique visitors, traffic by source
- Cost per visitor by channel
- Brand search vs. discovery search ratio
- Time-on-page and bounce rate by source (signal of intent)

### 2. Activation (visitor → engaged user)
- Signup conversion rate by source
- % of new signups completing first key action (the activation event)
- Time-to-activation distribution
- Onboarding drop-off by step

### 3. Engagement (engaged → habitual user)
- Weekly active users / monthly active users (WAU/MAU)
- Session frequency by cohort
- Feature breadth (number of distinct features used)
- Time to second value event

### 4. Revenue
- MRR / ARR
- Average revenue per user (ARPU) by cohort
- Expansion vs. churn revenue
- Customer LTV (cohort-based)
- Revenue per visitor (RPV)

### 5. Retention
- Logo retention (% of customers retained)
- Net revenue retention
- Cohort retention curves at month 1, 3, 6, 12
- Churn reason taxonomy (when available)

The brain's auto-rollup pipeline (R71) generates this stack daily; the briefings highlight the 3-5 metrics that moved significantly.

## What "significantly" actually means

A metric "moved" if:
- The change exceeds 2 standard deviations from rolling 4-week mean, OR
- The change is sustained over 3+ consecutive measurement periods, OR
- The change correlates with a known intervention (campaign launch, product change, market event)

If none of those apply, it's noise. Move on. The brain enforces this via the experiments framework — claims about "X went up" require effect-size + statistical-confidence reporting, not just direction.

## The seven analytics traps

### 1. Vanity metrics
- "Total signups since launch" — backwards-looking, can't act on
- "Total app downloads" — most never open the app
- "Social media reach" — most never engaged
- Replacement: actively-engaged users, paying customers, returned visitors

### 2. Survivorship bias
- "Our retained customers love us" — yes, that's why they're retained; the churned ones already left
- "Customers using feature X have higher LTV" — could be self-selection, not causation
- Fix: look at random sample including churned + non-feature-users for honest comparison

### 3. Simpson's paradox
- Overall conversion rate looks fine, but each cohort is declining
- Aggregated by industry across regions but each region has different mix
- Fix: always disaggregate before acting; segment by source/cohort/region

### 4. Correlation as causation
- "Users who watch the tutorial retain better" — could be that motivated users both watch tutorials AND retain
- "Adding feature X drove revenue up" — could be a seasonal effect that coincided
- Fix: only causality claims with controlled experiments (R146.86)

### 5. Goodhart's law in action
- Optimizing for "session count" → users open the app to chase a streak
- Optimizing for "messages sent" → bots, spam, low-quality interactions
- Fix: combine the metric you optimize with a quality counter-metric

### 6. Recency bias
- "Last week's numbers tell us everything"
- "The cohort that started last month is so different from previous"
- Fix: always include 4-12 week historical context; recent data has higher variance

### 7. Survivor presentation
- Dashboard shows only successful cohorts because failures were sunsetted
- Conversion funnel reports only on completers
- Fix: explicit failure inclusion; report alongside denominator carefully

## Reading a funnel correctly

### Visitor → signup
- Healthy conversion: 1-5% B2C, 0.2-1% B2B
- If you're outside this range, check: source quality, headline clarity, signup form length, social proof
- The brain investigates via conversion-optimization patterns first, not pricing

### Signup → activation
- Healthy conversion: 40-60% within 7 days
- If lower, check: onboarding flow, first-session friction, value-clarity
- This is the single biggest predictor of long-term retention

### Activation → habitual user (3+ sessions in 14 days)
- Healthy conversion: 30-50% of activated users
- If lower, check: in-product reminders, email sequence, social/competitive features
- Critical for compound retention

### Habitual → paying customer (where applicable)
- Healthy conversion: 5-20% of habitual users in first 60 days
- If lower, check: pricing perception, upgrade-prompt timing, value-vs-cost framing
- Pricing-psychology playbook applies

### Paying → expansion / advocacy
- Healthy: 20%+ of paid base in expansion or referral motion
- Mature businesses derive 40%+ of growth from existing customers

## Cohort analysis — the analyst's best friend

Cohort analysis groups customers by start date and tracks each cohort's behavior over time. The brain runs cohort analyses by:

- Signup month (most common): are recent cohorts retaining as well as older ones?
- Acquisition source: do paid customers retain differently from organic?
- First product purchased: does the initial product predict LTV?
- Pricing tier: do top-tier customers retain better (validating premium positioning)?
- Operator intervention: did a specific change (onboarding, feature, email) shift the curve?

Cohort tables read like:

```
Cohort     | M1   | M2   | M3   | M6   | M12
2025-Q1    | 100% | 75%  | 65%  | 50%  | 42%
2025-Q2    | 100% | 78%  | 68%  | 55%  | 46%
2025-Q3    | 100% | 82%  | 72%  | --   | --
```

If recent cohorts are retaining better than older ones, something is working. If worse, something broke.

## The 80/20 of dashboards

A dashboard the operator should look at daily should contain at most:
- 1 acquisition metric (sessions or signups)
- 1 activation metric (% activating in 7 days)
- 1 engagement metric (DAU/WAU)
- 1 revenue metric (MRR or weekly bookings)
- 1 retention metric (NRR or rolling churn)

Five numbers. Each with a 4-week sparkline showing trend. Each with a target.

A weekly dashboard adds:
- Top 3 cohorts' retention progress
- Top 5 acquisition sources by quality (LTV/CAC)
- Pipeline metrics (if applicable)
- Active experiments status
- Anomalies flagged

A quarterly review goes deeper. Daily dashboards should NOT.

## Anomaly detection patterns

The brain monitors for:
- Step changes (level shift): something changed permanently
- Trend reversals: previously growing → declining (or vice versa)
- Variance changes: smoothness changed (could indicate measurement issue)
- Seasonality breaks: usual pattern didn't hold
- Cohort divergence: recent cohort behaving very differently

When detected:
1. Quantify the anomaly (effect size + duration)
2. Cross-reference with known events (launches, changes, market news)
3. Generate hypotheses for cause via `hypothesis.create`
4. Surface to operator with severity classification

## What the brain MUST NOT do

- Present aggregate metrics without offering disaggregation when changes occur
- Conclude causation from correlation without controlled experiment
- Suppress or smooth-over bad numbers in briefings (honest reporting required)
- Optimize for a metric without paired counter-metric
- Run experiments without pre-registering hypothesis + success criteria

## Cost economics

Analytics infrastructure is mostly fixed cost:
- PostHog/Mixpanel/Amplitude: $0-200/mo at small scale
- Google Analytics 4: free
- Internal event logging: free (already in Novan)
- Custom dashboards: time investment, mostly one-time

The cost is mostly attention — knowing what to ignore is harder than knowing what to track.

## Integration with the rest of the stack

- **Experiments framework (R146.86)** — analytics provide the outcome measurement for every experiment
- **Hypotheses (R146.86)** — anomalies become hypotheses with predicted causes
- **Calibration (R146.86)** — brain's predictions about metric movements get scored against reality
- **CEO-strategic (R146.87)** — prioritization uses retention + revenue per business
- **Customer-retention** — the retention metrics live here, but the response patterns live in the retention playbook
- **Conversion-optimization** — funnel reads guide where to test

## What "good" looks like

- Operator can name 5 metrics off-the-cuff with current value and target
- Briefing surfaces 3-5 anomalies per week, not 30
- Each anomaly has a hypothesized cause and either confirmation or refutation within 14 days
- Experiments running against hypotheses with predefined success criteria
- Cohort tables visible, recent vs older cohort comparison ready
- No vanity metrics in the dashboard
