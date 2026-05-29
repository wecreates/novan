# YouTube Automation Playbook

Last updated 2026-05-25. Operating knowledge for the Novan brain when planning, producing, publishing, and optimizing YouTube channels at scale toward the $10k/month/business floor.

---

## 1. The algorithm in one paragraph

YouTube ranks videos by **session value** — the expected total watch time a user spends on the platform after clicking a video, not just the watch time of that video alone. Concretely the inputs are:

1. **CTR (click-through rate)** on impressions — 4–6% is baseline, 8–12% is good, 15%+ is winning. Below 2% is dead.
2. **AVD/APV (average view duration / average percentage viewed)** — APV ≥ 50% on long-form, ≥ 70% on Shorts, ≥ 35% on videos > 15 min.
3. **End-of-video session continuation** — does the viewer click another YouTube video after yours (good) or leave the platform (bad)?
4. **Subscriber retention curve** — newly-acquired subs from a video must watch the channel's next videos. If they don't, the channel is graded as "click bait" and reach to its own subs is throttled.
5. **Comments-per-1000-views** > 1 is healthy; > 4 is exceptional.
6. **First-hour velocity** — the first 60 minutes after publish determine the suggested-feed slot for the next 7 days.

Everything else (likes, shares, ratio, length) is a distant second-order signal.

## 2. Channel format taxonomy (face-free, scalable)

These formats reliably scale without on-camera presence:

| Format | RPM range | AVD bar | Notes |
|---|---|---|---|
| Tech tutorials | $4–$15 | 4–8 min | High RPM if niche is B2B; needs visual demonstration |
| Personal finance / investing | $15–$45 | 5–10 min | Top-3 RPM niche, fierce competition |
| AI tools / SaaS reviews | $8–$25 | 6–12 min | Trending, dependent on tool freshness |
| History documentary | $3–$8 | 12–25 min | Sleep-friendly; AVD wins because of length |
| True crime narration | $5–$12 | 15–30 min | Heavy script work; sensitive content gate |
| Sports analysis (post-game) | $2–$6 | 6–10 min | Hot-take cycle; requires fast turnaround |
| Stoic / motivational | $1–$3 | 8–15 min | Low RPM, scales on volume |
| Sleep stories / lo-fi | $0.50–$2 | 1–3 hours | Cheap to produce; monetizes on volume |
| Crypto / Web3 | $6–$15 | 5–10 min | Volatile; subject to policy demonetization |
| Reaction-style (without face — text overlays only) | $1–$4 | 3–6 min | Copyright risk |

**Avoid for face-free monetization**: lyric channels (copyright auto-claim), recycled news clips (no fair-use defense for full-segment use), kid-targeted content (COPPA + ads disabled), pure music compilations (DMCA), conspiracy/anti-vax (demonetization risk).

## 3. Niche selection criteria

The brain should score a candidate niche on a 0–10 scale across five axes; a niche with sub-6 on any axis should not be greenlit.

1. **Search volume**: average monthly searches for top 20 keywords ≥ 50k combined.
2. **Competition saturation**: count of channels > 100k subs in the niche < 200. Above that the SERP is locked.
3. **Production economics**: per-video cost (scripting + voice + visuals + editing) < expected per-video ad revenue at 50k views × niche RPM × 0.7. Below this the unit economics fail.
4. **Evergreen-to-trend ratio**: at least 60% of niche content should be evergreen (rankable for 12+ months). Pure trend niches collapse the moment the trend fades.
5. **Advertiser-friendliness**: niche must clear YouTube's ad-friendly content guidelines (no firearms, no hard alcohol, no inflammatory politics, no graphic violence, no adult content).

**Niches the brain should default-prefer for new operators**: AI tools, productivity software reviews, personal finance basics, home automation, retro tech, animal facts (long-form), space, mythology.

## 4. The video unit

Every long-form video must contain:

### 4.1 The 8-second hook
The first 8 seconds determine whether the viewer reaches the 30-second mark, which is where YouTube starts crediting watch time. Hooks that work:

- **Pattern interrupt**: a visual or claim that contradicts the thumbnail's promise but resolves to it ("you've been told X, but here's what's actually happening")
- **Future-state preview**: "by the end of this video you'll know how to do Y in 5 minutes"
- **Cost-of-not-watching**: "the mistake in this clip cost me $4,000 — don't make it"
- **Open loop**: "I'll show you the answer at the 6:24 mark, but first…"

Avoid: "hey guys welcome back to my channel", "in today's video", any greeting longer than 3 seconds.

### 4.2 Retention beats
Insert a "beat" every 30 seconds. A beat is one of:
- a B-roll cut (visual change)
- a callback to the hook
- a future-pacing line ("in 90 seconds I'll show…")
- a comparison or chart
- a quote / testimonial

Retention curves crater when the same camera angle, same voice tone, and same visual style runs for > 45 seconds.

### 4.3 The mid-roll trap
At 50–60% of duration, place a payoff that justifies the second half. If the viewer hits 60% they almost always finish, which doubles the AVD signal.

### 4.4 End screen + subscription pull
The last 15 seconds: a sentence-length sub pitch (no monologues), then 2 end-screen cards (next video + subscribe). End screens drive 5–12% of channel sub gains for face-free channels.

## 5. Thumbnail rules

Thumbnails determine 70% of CTR variance. Hard rules:

1. **One subject only**. Multi-subject thumbnails score 30–50% lower CTR.
2. **Three-second readability test**: a viewer scrolling at 1 thumbnail per second on mobile must identify the topic without reading text. If the text removed makes it unreadable, the thumbnail is failing.
3. **Color contrast**: use one bright color (yellow #FFD700, red #E63946, lime #A8E63A) against a dark backdrop. Avoid mid-tones.
4. **Face or no face**: if the channel has no on-screen face, use a single product/object or a single archetypal image (a hand pointing, a stack of cash, a silhouette). Never use stock-photo people for face-free channels — viewers detect the inauthenticity.
5. **Text**: ≤ 4 words, bold sans-serif, minimum 80pt at 1280×720. The Novan brain should reject any generated thumbnail whose largest text exceeds 4 words.

The brain should always generate **5 thumbnail variants** per video and run a 24-hour CTR test (via YouTube's built-in thumbnail test for eligible channels, or by swapping every 6 hours and recording impressions).

## 6. Title rules

1. **Front-load the keyword**: the search term should appear in the first 40 characters.
2. **Length 50–60 characters**. Mobile truncates at 60. Below 30 looks under-baked.
3. **Curiosity gap, not click-bait**: a curiosity gap promises an answer the video delivers. Click-bait promises one and switches.
4. **Specific number > vague claim**: "I built 4 apps in 30 days" beats "I built apps fast".
5. **Avoid all-caps and emoji unless niche convention** (gaming + reaction channels use them; tutorial channels don't).

## 7. Multi-channel scaling

This is the core lever for $10k/mo per business — single channels are bounded by niche size; multi-channel portfolios diversify niche risk and stack RPM.

### 7.1 The portfolio formula

To hit $10k/mo of net revenue per business:

```
target_net_rev = 10000
youtube_take   = 0.55   (after YouTube's 45% Shorts cut + Adsense fees)
avg_rpm        = 6     (mid-niche assumption)
required_monthly_views = target_net_rev / (avg_rpm / 1000) / youtube_take
                       = 10000 / 0.006 / 0.55
                       ≈ 3_030_000 views/month
```

So 3M monthly views is the floor for a $10k/mo business at mid-RPM niches. In high-RPM niches (finance/B2B), 800k views suffices. In low-RPM (sleep/motivation), 12M+ is needed.

### 7.2 Channel count guidance

| Niche RPM | Target views/channel/month | Channels needed for $10k/mo |
|---|---|---|
| $15+ (finance, B2B) | 100–150k | 6–10 channels |
| $5–10 (tech, AI) | 200–300k | 10–15 channels |
| $1–4 (motivation, sleep) | 600k–1M+ | 15–25 channels |

The brain should plan around the **10-channel portfolio** as a starting unit and grow from there.

### 7.3 Account hygiene (ToS-critical)

YouTube's ToS allow multiple channels per Google account (up to 50 brand accounts per Google ID). Operationally:

- **One Google account per 3 channels** maximum. Concentrating > 3 channels on one account creates a single point of failure (one strike = all channels affected).
- **Distinct AdSense per channel cluster**: AdSense permits one account per *person*, not per channel. Use the same AdSense for all channels owned by the same operator. (Multiple AdSense accounts per person violates ToS and triggers bans.)
- **Distinct IP per account cluster** *only* if reasonable — YouTube's anti-multi-account detection is mostly behavior-based, not IP-based. A residential ISP is fine for 3–5 brand accounts.
- **Distinct browser fingerprint** per Google account: use separate Chrome profiles, distinct extensions, distinct timezone if travelling. Do NOT use anti-detect browsers (Multilogin etc) for this — those signals trip YouTube's automation flag and lock the channel.

### 7.4 What "automation" can and cannot do

**Allowed**:
- Bulk research (keyword tools, competitive analysis)
- AI-generated scripts (must be edited by a human or another AI for quality)
- AI-generated voiceover (ElevenLabs / Play.ht; YouTube does not ban AI voice as of 2026-05)
- AI-generated B-roll and thumbnails
- Scheduled publishing via the YouTube Studio API
- Cross-platform repost (Shorts → TikTok → IG Reels)

**Banned by YouTube ToS or de-monetized by AI content policy** (effective 2024-03, enforced harder 2025-09):
- Pure AI-on-AI content with no human editorial input (the channel must demonstrate "added value")
- Mass-generated content without unique value (so-called "AI slop")
- Repetitive content where the only change between videos is a swapped keyword
- Automated comment posting, sub-for-sub schemes, view-bot purchases
- Reuploaded content (compilations, lyric videos) without transformative editing

The brain must **always** insert at least one human editorial decision per video — even if it's just the operator approving the script before voiceover. Without it, the channel is monetization-eligible for 60–120 days and then permanently demonetized.

## 8. Publishing cadence

| Phase | Videos/week per channel | Why |
|---|---|---|
| 0–30 days (warm-up) | 2 | Algorithm needs signal density without diluting AVD |
| 30–90 days (signal building) | 3 | More signal; new sub retention curve still forming |
| 90+ days (scale) | 3–5 | Diminishing returns above 5/week unless channel is news-cycle |

Posting times: peak publish for the channel's geo audience — for US English channels, **Tuesday/Thursday 14:00–16:00 ET** consistently outperform other slots by 20–35% in first-hour velocity.

## 9. Monetization gates

| Gate | Requirement | Time to clear (typical) |
|---|---|---|
| YPP Phase 1 (Shorts fund + Fan Funding) | 500 subs + 3 uploads in 90d + 3k watch hours OR 3M Shorts views in 90d | 60–120 days |
| YPP Phase 2 (full AdSense) | 1,000 subs + 4,000 watch hours OR 10M Shorts views in 90d | 90–180 days |
| Memberships | 1,000 subs | (same as Phase 2) |
| Super Thanks / Super Chat | YPP Phase 2 | — |

For a portfolio of 10 channels, expected timeline to first $10k/mo: **6–9 months** if 60%+ of channels reach Phase 2. Many portfolios churn 40% of channels before reaching this — niche/format failures are the dominant cost.

## 10. Cross-platform repurposing (the leverage)

Every long-form video produces:
1. **3–5 Shorts cuts** (the highest-CTR 30-second moments) — published to YouTube Shorts, TikTok, IG Reels, simultaneously
2. **1 X thread** of the video's key claims (8–12 tweets)
3. **1 LinkedIn post** (if niche supports it — finance/B2B/tech yes, motivation/sleep no)
4. **1 Pinterest pin** for the thumbnail (drives 1–3% of long-tail traffic on tutorial niches)

Cross-platform repost is the single biggest multiplier — a video that does 50k views native typically does 150–400k across all surfaces when repurposed correctly. The brain should always plan the repurpose tasks alongside the publish task.

## 11. Performance benchmarks for the brain to check

After 30 days of a new channel:
- **Healthy**: ≥ 5 videos published, ≥ 1 video at > 5k views, sub count > 100, CTR > 4%, AVD > 40%
- **Marginal**: 3–4 videos, one outlier > 2k views, CTR 2–4%
- **Failing**: 0–2 videos > 1k views, CTR < 2% — niche/format is wrong; pivot or kill

The brain should auto-flag failing channels at day 30 and propose either (a) a format pivot (same niche, different format — e.g. tutorial → reaction-style), (b) a niche pivot, or (c) sunset.

## 12. Common failure modes (from real channel deaths)

1. **Niche cosplay**: operator picked the niche because it was trending in a YouTuber's video, not because they have any insight. Fails because the AI scripts are surface-level.
2. **Thumbnail drift**: thumbnails get worse over time as the operator gets tired. Brain must monitor for CTR decay and force a thumbnail review at any 7-day CTR drop > 25%.
3. **AVD collapse from length inflation**: operator extends videos from 8 min → 14 min to chase the 8-min watch-hour bonus. AVD halves. Watch hours drop net.
4. **Sub-velocity-without-watch-time**: a viral Short brings 50k subs who never watch long-form. Channel is graded as Shorts-only; long-form reach craters. Solution: pair every viral Short with an explicit long-form CTA in the Short's caption + pinned comment.
5. **Demonetization cascade**: one borderline video gets a yellow icon, brain doesn't notice, next 3 videos copy its style, all demonetized, channel growth stalls. Brain must check monetization status on every upload + halt the format on any demonetization within 24 hours.

## 13. What Novan should automate vs. queue for the operator

| Action | Automate | Queue for operator |
|---|---|---|
| Niche research + scoring | ✅ | — |
| Keyword + topic backlog | ✅ | — |
| Script first draft | ✅ | — |
| Script final approval | — | ✅ (1-click in chat) |
| Voiceover + B-roll + thumbnail | ✅ | — |
| Final video review (10-sec preview check) | — | ✅ |
| Title + description + tags | ✅ | — |
| Publish scheduling | ✅ | — |
| Cross-platform repost | ✅ | — |
| Reply to first 20 comments per video | ✅ (with brand-voice template) | — |
| Reply to monetization issues / strikes | — | ✅ (always) |
| AdSense linking / banking setup | — | ✅ (always — Novan never touches money flow) |
| ToS appeals | — | ✅ |

The "queue for operator" actions are deliberately the ones where a wrong move ends the channel or costs money — Novan defers those to the operator every time.
