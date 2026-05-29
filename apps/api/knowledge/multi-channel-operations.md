# Multi-Channel Operations Playbook

How Novan runs 10+ channels / 5+ shops / 3+ brands in parallel without violating ToS, getting accounts banned, or burning the operator out. Reality-grounded.

---

## 1. The honest framing

To hit $10k/mo per business from organic content, almost every operator runs a **portfolio of channels**, not a single mega-channel. Single-channel mega-success exists (MrBeast, Veritasium, etc.) but the path requires either (a) generational talent, (b) 5+ years of compounding, or (c) capital + team. None of those are what Novan optimizes for. Novan optimizes for the **diversified portfolio path**: 10 channels × $1k/mo each = $10k/mo per business.

This playbook covers the operational mechanics of that path.

---

## 2. What runs the operator out of business (the failure curve)

In every failed multi-channel operator post-mortem, one of these is the cause:

1. **Production debt**: operator launched 8 channels in month 1, can't sustain 16 scripts/week, every channel stalls, none reach monetization. **Cause: enthusiasm > capacity.**
2. **Account bans**: operator violated ToS through bulk automation (auto-comment, sub4sub, fingerprint reuse), 3 channels banned in one week, AdSense account terminated, 6 months of work erased. **Cause: ToS shortcut.**
3. **Niche cosplay**: operator picked all 8 niches because they were "hot in 2024", has no insight into any of them, all 8 produce surface-level content. **Cause: no information edge per niche.**
4. **Single-point-of-failure**: all 8 channels on one Google account, one strike = all 8 demonetized. **Cause: account concentration.**
5. **Cash-flow timing**: month 1 of revenue lands in month 4 (90-day AdSense payout cycle); operator can't fund ad spend / asset costs until then, gives up at month 3. **Cause: didn't model cash flow.**

The brain should explicitly check for each of these failure modes weekly and flag the operator.

---

## 3. The 10-channel portfolio template

This is the recommended starting structure for a new business unit:

```
business: "Hearth"  (target: $10k/mo)
│
├── tier-1 channels (high RPM, high effort)
│     ├── channel-1: "Hearth Finance"     (personal finance, $15 RPM, target 150k v/mo)
│     ├── channel-2: "Hearth Tech"         (productivity software, $8 RPM, target 250k v/mo)
│     └── channel-3: "Hearth AI"           (AI tool reviews, $12 RPM, target 200k v/mo)
│
├── tier-2 channels (medium RPM, medium effort)
│     ├── channel-4: "Hearth Cooking"      ($5 RPM, target 400k v/mo)
│     ├── channel-5: "Hearth Home"         ($4 RPM, target 500k v/mo)
│     └── channel-6: "Hearth Travel"       ($6 RPM, target 350k v/mo)
│
└── tier-3 channels (low RPM, low effort — pure volume)
      ├── channel-7: "Hearth Sleep"        ($1 RPM, target 2M v/mo)
      ├── channel-8: "Hearth Stoic"        ($2 RPM, target 1.5M v/mo)
      ├── channel-9: "Hearth History"      ($3 RPM, target 800k v/mo)
      └── channel-10: "Hearth Animals"     ($2 RPM, target 1M v/mo)
```

Math: even if **5 of 10 channels fail** (realistic attrition), the remaining 5 hit $10k/mo combined. **The portfolio is the strategy, not any single channel.**

---

## 4. Account hygiene rules (ToS-critical)

### 4.1 Google account distribution

| Channels per Google account | Risk | Use case |
|---|---|---|
| 1 | Lowest | Tier-1 channels (your most valuable) |
| 2–3 | Low | Tier-2 channels |
| 4–5 | Medium | Tier-3 channels only |
| 6+ | High | Don't |

**Best practice**: 4–5 Google accounts for a 10-channel portfolio. The brain should track which channel is on which account in `channel_manager`.

### 4.2 AdSense

**One AdSense account per operator** — multiple AdSense accounts per person is a ToS violation and gets all of them banned. All 10 channels in the portfolio share the same AdSense.

### 4.3 IP / device hygiene

YouTube's anti-multi-account detection is **behavior-based**, not IP-based, for normal operators. A residential ISP is fine for 5+ Google accounts. Heuristics that DO trigger detection:

- Logging in and out of 5+ accounts on the same device in a single hour
- Posting from the same exact device fingerprint with conflicting timezone signals (logged in as "Tokyo" account from Toronto)
- Anti-detect / virtual browser tools (Multilogin, GoLogin) — paradoxically, these trip detection more often than they avoid it
- Mass-uploading > 10 videos/day from a single device

**Solutions**:
- Use Chrome profiles (1 per Google account)
- Use the same residential IP consistently per profile (don't rotate)
- Stagger uploads — never 5 uploads in 5 minutes from the same device
- If working in a team, divide the portfolio so each team member owns specific accounts

### 4.4 What Novan should NEVER do

- Bulk-create channels (> 1 channel per Google account in the same day)
- Auto-respond to comments / DMs / messages
- Auto-follow / sub-for-sub / view exchanges
- Bulk-edit titles across 10 channels simultaneously
- Anti-detect browser automation against Google services

The brain enforces these as hard refusals. The operator can override, but the system warns and logs.

---

## 5. Production capacity model

For a 10-channel portfolio at 3 videos/week per channel = **30 videos/week = ~4.5/day**.

### Per-video time budget (with Novan automation)

| Task | Manual time | Novan-assisted | Saving |
|---|---|---|---|
| Niche research | 60 min | 5 min | 55 min |
| Topic + outline | 30 min | 3 min | 27 min |
| Script draft | 90 min | 2 min | 88 min |
| Script edit + approval | 30 min | 15 min (operator review) | 15 min |
| Voiceover | 20 min | 2 min (ElevenLabs) | 18 min |
| B-roll sourcing | 60 min | 5 min (auto-fetch + classify) | 55 min |
| Edit + assemble | 90 min | 10 min (template-based) | 80 min |
| Thumbnail + variants | 30 min | 5 min (5 variants auto-gen) | 25 min |
| Title + description + tags | 30 min | 2 min | 28 min |
| Final review (10-sec preview) | 5 min | 5 min | 0 |
| Publish + schedule | 5 min | 1 min | 4 min |
| Cross-platform repost | 30 min | 5 min | 25 min |
| **Total** | **480 min (8 h)** | **60 min (1 h)** | **7 h saved** |

At 1 hour of operator time per video × 30 videos/week = **30 hours/week of operator time**. That's the practical ceiling for a solo operator with Novan. Adding an editor (human) brings it to ~50 videos/week.

### Implication for the brain

The brain should NEVER plan more than ~30 videos/week for a single operator without confirming team capacity. Overplanning is the #1 cause of portfolio collapse.

---

## 6. Cash-flow model (real numbers)

For a new 10-channel YouTube portfolio:

| Month | Videos produced | Channels at YPP | Gross revenue | Expenses | Net |
|---|---|---|---|---|---|
| 1 | 60 | 0 | $0 | $400 | -$400 |
| 2 | 90 | 0 | $0 | $400 | -$400 |
| 3 | 120 | 0–2 | $200 | $400 | -$200 |
| 4 | 120 | 2–4 | $1,500 | $400 | +$1,100 |
| 5 | 120 | 4–6 | $3,500 | $400 | +$3,100 |
| 6 | 120 | 5–7 | $6,500 | $400 | +$6,100 |
| 7 | 120 | 6–8 | $9,000 | $400 | +$8,600 |
| 8 | 120 | 7–9 | $11,500 | $400 | +$11,100 |
| 9 | 120 | 8–9 | $13,000 | $400 | +$12,600 |

Notes:
- Expenses cover voice (ElevenLabs ~$22/mo), AI calls (~$150/mo at 4 videos/day), stock B-roll (~$50/mo), Canva/mockup tools (~$30/mo), one-time channel art ($150/mo amortized year 1)
- YouTube AdSense pays out **60 days after the month closes**. Month 4's $1,500 actually hits the operator's bank account at the end of month 6.
- Operator needs **$2k–$3k working capital** to survive months 1–6 cash-flow-wise

The brain should track this with the `business_portfolio` table and flag when the operator's runway approaches 60 days.

---

## 7. Cross-business synergies

Once an operator runs 2+ businesses (e.g. a YouTube portfolio AND a POD shop), Novan should plan cross-promotion:

| From | To | Mechanic |
|---|---|---|
| YouTube finance channel | POD finance-niche shop ("I'm a debt-free dad" mug) | Description link + pinned comment |
| YouTube cooking channel | POD kitchen shop | Same as above |
| TikTok account | Etsy shop | Bio link |
| Long-form video | Newsletter | End-screen CTA |
| Newsletter | Patreon / community | Weekly value drop |
| Patreon | Course / digital product | Membership tier ladder |

The brain should auto-detect these synergy opportunities by analyzing the operator's portfolio + identifying audience overlap. A finance channel + a finance POD shop is 30–50% higher LTV than either alone.

---

## 8. Sunsetting + pivoting

Not every channel succeeds. The brain should track channels against this rubric:

| Days since launch | Healthy signal | Action if failing |
|---|---|---|
| 30 | ≥ 5 videos, ≥ 1 video > 5k views, CTR > 4% | Pivot format within niche |
| 60 | ≥ 12 videos, ≥ 100 subs, 30-day avg AVD > 35% | Pivot niche if 30-day trend is flat |
| 90 | ≥ 24 videos, ≥ 300 subs, 1 video > 20k views | Sunset if no growth signal |
| 120 | YPP Phase 1 eligible | Sunset; cannibalize content to a different channel |

**Sunsetting protocol**:
1. Stop new uploads
2. Wait 30 days
3. Repurpose top 3 videos into a fresh channel in a different niche
4. Delete the failing channel (or archive — never re-use the same channel name in a different niche; YouTube tracks the channel ID, not the name)

The brain should propose sunsetting decisions but never execute them — channel deletion is irreversible and a high-trust action.

---

## 9. The continuous-improvement loop

Every Monday, the brain runs this loop per business:

```
1. Pull last-7-day stats from every channel / shop / platform in the portfolio
2. Identify the top-decile content unit (video / pin / listing) across all surfaces
3. Identify the bottom-decile content unit
4. For top: extract format + hook + length + visual style; queue 3 variants for next week
5. For bottom: tag the failure mode (low CTR / low AVD / bad niche fit / bad timing)
6. Compute distance-to-$10k for the business
7. Generate the weekly action plan as a brain-task plan (publish queue + ad changes + sunset proposals)
8. Surface to operator as one consolidated "Monday briefing"
```

This loop is the heart of "self-evolving". The brain doesn't generate fresh ideas — it learns the operator's audience response pattern, doubles down on what works, and proposes pivots on what doesn't.

---

## 10. Operator trust gates (what the brain proposes vs executes)

| Action | Brain executes | Brain proposes (operator confirms) |
|---|---|---|
| Generate script | ✅ | — |
| Generate voiceover | ✅ | — |
| Generate thumbnail variants | ✅ | — |
| Publish video on a channel that has > 5 successful publishes | ✅ | — |
| Publish video on a new channel (< 5 publishes) | — | ✅ |
| Cross-post to TikTok / Reels | ✅ (after first published TikTok / Reel succeeded) | — |
| Reply to comments using brand voice templates | ✅ (drafts) | ✅ (operator approves batch) |
| Reply to a comment containing controversy / complaint | — | ✅ |
| Create a new listing on a proven shop | ✅ | — |
| Create a new shop | — | ✅ |
| Increase ad spend on a winning listing | — | ✅ |
| Decrease / pause ad spend on a losing listing | ✅ | — |
| Sunset a channel | — | ✅ (irreversible) |
| Connect a new platform / account | — | ✅ (OAuth touches credentials) |
| Spend more than $50/day in ads | — | ✅ |
| Spend more than $500/month total | — | ✅ |

Money flow is always the operator's. The brain never auto-spends past per-business thresholds. The operator's role becomes "weekly approval + monthly strategy", not "daily production".

---

## 11. The honest limits

What Novan can do:
- Plan production, generate assets, schedule publishes, track performance, suggest improvements, prune losers, scale winners
- Reduce per-video operator time from 8 h to ~1 h
- Maintain consistency across 10+ channels without burnout
- Surface trends and changes that a solo operator would miss

What Novan **cannot** do:
- Guarantee $10k/mo per business — the algorithm + niche + content quality + market conditions are exogenous
- Bypass platform ToS — full automation gets channels banned permanently
- Replace human editorial judgment on controversial topics, brand voice, or strategic pivots
- Materialize working capital — months 1–6 require the operator to fund the system before revenue catches up
- Stop a channel from being banned by a wrong-but-honest editorial decision (a video about a topic YouTube later de-monetizes)

If the operator expects "set it and forget it $10k/mo in 30 days", they will be disappointed and quit. If the operator expects "automated assistant that reduces my 60h/week to 30h/week and steers me toward winners over 6–9 months", they will succeed.

The brain should always default to honest framing with the operator. **Never promise revenue outcomes; promise execution velocity.**
