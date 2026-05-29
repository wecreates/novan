# Operator Runbook

The day-by-day routine that produces $10k/mo per business when followed for 6–9 months. This is the file the brain references when an operator asks "what should I do today" or when the Monday briefing composes its action list.

Read this together with `multi-channel-operations.md` (the strategic picture) and `youtube-automation.md` / `social-media-playbook.md` / `print-on-demand.md` (the channel-specific tactics).

---

## 0. The honest sequence

Operators who hit $10k/mo per business almost always follow this sequence — not because it's magical, but because skipping steps causes specific failure modes the brain has already documented:

1. **Week 0 (planning)**: pick exactly ONE business category. Resist the multi-stream temptation.
2. **Weeks 1–4 (setup)**: build the infrastructure for that one business. Brain seeds prompts + connects platforms.
3. **Weeks 5–12 (signal building)**: produce on cadence. Don't chase metrics. The first measurable signal lands at week 8–10.
4. **Weeks 13–24 (optimization)**: prune losers, scale winners. Use the weekly Monday review religiously.
5. **Weeks 25–36 (target approach)**: first business is at $5–15k/mo gross. Start a second business in a different category.
6. **Weeks 36–52 (portfolio)**: 2–3 businesses, total >$30k/mo. Brain begins prompt-evolution loops; operator becomes strategic.

Operators who try to compress this into months 1–3 fail. Operators who pause for 3 weeks in months 4–5 fail. The brain enforces consistency by surfacing the weekly briefing whether the operator opens it or not.

---

## 1. Daily routine (15–30 min/day)

The brain composes a Daily Brief at 06:00 in the operator's local timezone. It contains exactly four sections:

### 1.1 What needs your eyes (5 min)
- Comments awaiting reply (drafts ready, you approve or edit)
- Reviews / ratings on your shop or channel that need a response
- Failed publishes / ToS notices / monetization status changes

### 1.2 What's queued for approval (5 min)
- 1–3 brain-drafted videos / listings / posts ready to ship
- 1-click approve OR edit-then-approve OR skip
- The brain shipped no auto-published content overnight — every publish needs your sign-off until you explicitly enable per-platform autopilot

### 1.3 Yesterday's signal (5 min)
- Top-performing content (which video, which listing, which post — and why the brain thinks it worked)
- Bottom-performing content (and what the brain proposes changing)
- Revenue events recorded (sales / ad-share / sponsorship)

### 1.4 Today's planned production (15 min)
- 2–4 items the brain is producing in the background
- You can re-prioritize or pause any of them

**Operators who skip the daily routine for > 5 days in a row** trigger an automated brain alert. The system never punishes — it just notices and asks if anything is wrong.

---

## 2. Weekly routine (1–2 hours, Monday morning)

The brain runs `portfolio.improve` automatically at 07:00 Monday. The output is the weekly action plan.

### 2.1 Read the Monday briefing (15 min)

The briefing has four blocks:
1. **Portfolio status**: per-business gap to $10k/mo, on-track vs. underperforming
2. **Top-decile content**: what worked best across all surfaces, with the brain's analysis of WHY
3. **Bottom-decile content**: what failed, with proposed format / niche / format pivots
4. **3–5 concrete action items** for the week, ranked by priority

### 2.2 Approve the production schedule (15 min)
- Brain proposes a publish schedule for each channel / shop / platform
- You approve the batch (default schedule) or override specific slots
- Production fires automatically from this approval — you don't touch it again until next Monday unless something fails

### 2.3 Review prompt evolution (10 min)
- The brain has been A/B-testing prompt variants across the week
- One slot got mutated this morning; review the new variant
- Mark "use" if it's better, "discard" if it's worse, or "no opinion" to let the score data decide

### 2.4 Strategic decisions (15–45 min)
- Any business at >120 days with no monetization: brain proposes sunset OR niche pivot
- Any business at 80%+ of target: brain proposes raising the target OR opening a second business in the same vertical
- Cross-business synergies the brain spotted (e.g., your YouTube finance channel could feed your nascent finance newsletter)

### 2.5 Ad spend review (10 min, only if you run ads)
- Brain shows per-listing / per-channel CAC + ROAS for the week
- Approve increases on winners, decreases on losers
- Hard cap: brain refuses to push ad spend above the configured weekly ceiling without your explicit override

---

## 3. Monthly routine (3–4 hours, first Sunday of the month)

### 3.1 Revenue reconciliation
- Compare brain-recorded revenue (from `business_revenue` ledger) against actual platform payouts
- Flag any discrepancies > $5 for investigation
- Update the next-month's expected runway

### 3.2 Niche / format audit
- For every business, review the 30-day top-3 vs bottom-3
- Decide on format pivots that need to happen
- Brain produces 5 format-pivot proposals per underperforming business — you pick at most 1

### 3.3 Prompt registry cleanup
- Review the bottom-10% of prompt versions
- Retire any that have > 30 uses + mean score below the slot median × 0.7
- Brain handles 80% of this automatically; you spot-check

### 3.4 Knowledge file edits
- Did the brain learn something operationally important this month? (e.g., a new thumbnail style that's working, a new POD platform that's converting)
- Edit the relevant playbook in `apps/api/knowledge/` and run `playbook.reload`
- The next chat the brain has will reflect the update

### 3.5 Tax + bookkeeping handoff
- Export the month's revenue ledger as CSV (the brain has an op for this)
- Send to your accountant / bookkeeping software
- Brain never touches your tax filing — this is operator-only

---

## 4. Quarterly routine (one full day, every 3 months)

### 4.1 Strategy review
- Are you on track for $10k/mo per business in your stated timeline?
- If yes by > 20%, raise targets and open a new business
- If short by > 30%, consider whether your input (hours/week) needs to change or whether the niche selection was wrong

### 4.2 Brand voice + DNA audit
- Read 10 random pieces of brain-produced content from the last 30 days
- Does it sound like your brand? Or has the brain drifted toward generic LLM voice?
- Update brand_dna for each business; flag drift to the brain

### 4.3 Cost audit
- AI calls (Anthropic / OpenAI / Gemini / Groq) — is the cost-per-business sustainable?
- Tool subscriptions (ElevenLabs, Erank, Canva, Printify) — what's the actual ROI?
- Brain runs `economic.health` automatically each quarter; you read the output

### 4.4 ToS posture review
- Check each platform for policy changes since last quarter
- Brain monitors the major changes automatically but quarterly human review catches the subtler ones
- Update the brain's hard-refusal rules if a platform tightened automation policy

---

## 5. When things go wrong

### 5.1 A channel gets a strike
- **Do not** appeal yourself in the heat of the moment
- Brain queues a 24h cooldown then drafts the appeal for your review
- If the strike was from a video the brain produced, brain auto-pauses production for that channel until you re-enable

### 5.2 A platform de-monetizes a niche
- Brain re-classifies every business in that niche from active → at-risk
- Brain produces a niche-pivot proposal within 48h
- You decide whether to pivot or sunset

### 5.3 Cash flow tightens
- If working capital drops below 60-day forward burn, brain alerts and proposes the cheapest possible production schedule
- Brain never auto-pauses your business; it asks first
- Recommended action: pause low-RPM tier-3 channels first, preserve tier-1

### 5.4 Burnout signals
- Brain tracks operator login frequency, time spent reviewing, and approval-rate decay
- If approval rate drops > 30% week-over-week, brain assumes operator overload and proposes (a) skipping the next day's production, (b) reducing publish cadence by 30% for two weeks, or (c) shutting down the lowest-priority channel
- The brain ALWAYS lets you keep going if you say so. It just asks.

---

## 6. What the brain will never do (so you know what's still on you)

- Touch your bank account / payment methods / cards
- Sign tax forms
- Reply to legal threats / DMCA / takedowns
- File appeals on its own behalf (drafts only)
- Make a hire / fire / contractor decision
- Promise revenue outcomes to anyone (you, advertisers, sponsors)
- Spend > $50/day in ads without operator approval
- Publish on a brand-new channel (< 5 prior publishes) without operator approval
- Sunset / delete a channel without operator approval (irreversible)
- Modify your operator credentials / passwords / OAuth scopes

The list of things the brain does on its own is long; the list of things it defers to you is short but absolute. Operators who internalize this trust the brain faster and use it more.

---

## 7. How the brain learns from you

Every operator approval or rejection updates the brain's model of what works for THIS operator:

- A thumbnail-prompt version you approve more than reject → its score climbs
- A content topic that consistently leads to brain-approved publishes → it gets recommended again
- A platform you ignore for 30+ days → the brain stops queuing production for it
- A type of post you always edit before approving → the brain learns your editing pattern and applies it preemptively

You don't have to do anything to make this happen. It happens because the brain records the outcome of every approval through `prompt.recordOutcome` and aggregates per operator over time.

The honest implication: if you use the brain for 4 weeks and then ghost it for 8, the brain's model is stale. Returning operators see a brief calibration period (1–2 weeks) where the brain's suggestions need more editing than they did before.

---

## 8. The single most important habit

**Approve the weekly briefing on Monday morning, every Monday morning, for 12 weeks straight.**

Operators who do this hit $5k/mo in their first business by week 16–20. Operators who skip 2–3 Mondays in those 12 weeks usually plateau before week 24 and quit. The brain's continuous-improvement loop only converges if you give it consistent signal — and the Monday review is the highest-density signal you produce all week.

Set a recurring calendar event. Treat it like payroll. The brain will do everything else.
