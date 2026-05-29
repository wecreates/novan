# Social Media Engagement Playbook

Per-platform algorithm signals, posting cadence, hook libraries, and ToS-safe automation patterns. Companion to `youtube-automation.md`; used by the brain when planning cross-platform repurpose or running a social-only business.

---

## 0. The universal mechanic

Every modern social platform (TikTok, IG Reels, YouTube Shorts, X, Threads, LinkedIn, Pinterest) runs the same loop:

1. Post enters a **seed audience** (50–500 people who match the post's predicted topic).
2. The platform measures **first-15-minute engagement velocity**.
3. If velocity exceeds the platform's median for that topic, post is promoted to a larger audience.
4. Step 3 repeats up to 4–6 times until engagement decays.

**The single most important number on every platform is the same**: engagement rate in the first 15 minutes after publish. Everything else (followers, prior posts, account age) is a tiebreaker.

---

## 1. TikTok

### 1.1 Algorithm signals (in order of weight)
1. **Watch-through %** (re-watches count multiple times) — the dominant signal. 65%+ watch-through is exceptional; below 30% the video dies.
2. **Saves** — weighted higher than likes by ~3×.
3. **Shares to a friend** (DMs, not external) — weighted ~5× a like.
4. **Comments** with replies from creator — comment + creator reply is weighted higher than comment alone.
5. **Follow conversion** from this video — 1 follow per 1000 views is good; 5+ is exceptional.
6. **Hashtags + sounds** — directional signal only; not a primary input. Following the trending sound is worth ~10% of reach.

### 1.2 Hook library (1–3 second openers that work)

- "Three things nobody tells you about [X]…"
- "Here's the [X] mistake I made so you don't have to:"
- "If you're [demographic], stop scrolling — this is for you."
- "POV: you just realized [insight]…"
- "I tried [thing] for 30 days. Here's what happened:"
- "[Authority figure] just said [counterintuitive thing]. Here's why he's right:"

Avoid: questions ("Did you know…"), greetings, slow zoom-ins, lifestyle B-roll before any speech.

### 1.3 Length sweet spot
21–34 seconds. Watch-through % decays past 35s for general topics; tutorial/explainer content can hold to 60s if the hook is strong.

### 1.4 Posting cadence
2–4 posts/day for an aggressive growth account; 1/day sustainable. Posting more than 5/day cannibalizes own reach as the algorithm A/B tests recent uploads against each other.

### 1.5 Comments + DMs (the underrated lever)
TikTok's algorithm increases reach when the creator replies to early comments. **Reply to every comment in the first hour**. The brain can auto-draft replies but the operator (or a brand-voice template) must approve.

### 1.6 Bans + shadow-bans
TikTok shadow-bans accounts for:
- Posting the same caption + hashtag combo on 3+ posts in 24h
- Posting on > 2 accounts from the same device (without device-reset)
- Using copyrighted music in a non-personal-use post (commercial)
- Engaging with > 80 posts/hour (auto-follow-back, auto-like)

The brain must never auto-engage. Manual engagement only.

---

## 2. Instagram Reels

### 2.1 Algorithm signals
1. **Sends per reach** — DMs of the Reel to friends. By far the highest-weight signal post-2024.
2. **Saves**
3. **Watch-through %**
4. **Follow conversion** — IG weights this lower than TikTok; main lever is sends.
5. **Comments + comment-replies-from-creator**

Hashtags were de-prioritized in 2024; now they're a topic hint, not a reach lever. Use 3–5 niche hashtags max.

### 2.2 Content-fit rule
Instagram users open Reels for entertainment + aesthetic-aspirational content. Pure-tutorial content underperforms here vs TikTok by ~40%. Repurpose tutorial Shorts but **change the hook** to emphasize the aesthetic outcome ("the result of doing X for a year") rather than the process.

### 2.3 Length
15–30s for high reach; 30–60s for higher follow-conversion. Pick by goal.

### 2.4 Captions
Long captions (> 200 chars) outperform short. The IG algorithm uses caption text to infer topic; longer = more accurate routing. First line is the actual hook — the user only sees the first 2 lines without tapping "more".

### 2.5 Cross-posting from TikTok
**Do not post the same video with the TikTok watermark.** IG explicitly down-ranks watermarked Reels. Re-export from the source video file, not the TikTok download. Brain should always re-export, never repost a watermarked file.

---

## 3. YouTube Shorts

Covered in detail in `youtube-automation.md` section 10. Key delta vs TikTok:
- AVD threshold is **70%**, not 60%. Shorts below that decay fast.
- Long-form CTA in caption + pinned comment is the lever for converting Shorts viewers to long-form.
- Monetization is via the Shorts fund (revenue share on Shorts views) — RPM is $0.03–$0.08 per 1000 views, *much* lower than long-form ($2–$15). Volume game.

---

## 4. X (Twitter)

### 4.1 Algorithm signals
1. **Reply-to-impression ratio** — most-weighted signal. A tweet with 0 replies dies regardless of likes.
2. **Engagement-from-verified accounts** weighted higher than from unverified.
3. **Dwell time on the tweet** (yes, X measures how long a viewer reads — pause time before scroll).
4. **Bookmark count** (added 2024 as a discoverable metric).
5. **Quote-tweets > reposts** — quotes signal more engagement.

### 4.2 Format that wins
- **Single-tweet bangers** (declarative statement + image or chart) — fastest reach
- **Threads** (8–12 tweets, each compounds the previous, ends with CTA) — slowest reach per tweet but highest follower conversion
- **Reply farming** (reply to large accounts in your niche within 5 min of their post) — the fastest follower-growth lever currently

### 4.3 Cadence
Aggressive: 5–8 main posts/day + 20–40 replies. Sustainable solo: 2 main posts/day + 10 replies. The brain should compose drafts; the operator approves.

### 4.4 X automation limits (2026 rules)
- 1,000 API requests per 24h on the basic tier
- No auto-DM (was rate-limited in 2024)
- Auto-reply to mentions is allowed via the API but is detected as automation by users and tanks follower retention
- Scheduled tweets: allowed, no limit
- **Mass-unfollow / mass-follow detection**: triggered at > 400 actions per hour; account gets a 30-day write lock

The brain should compose, schedule, and queue replies for the operator to approve. Never auto-post replies.

---

## 5. Threads (Meta)

### 5.1 Status
As of 2026-05, Threads is the highest-growth-rate platform for new accounts: 0 → 5k followers in 30 days is achievable for high-engagement accounts in active niches (tech, finance, culture). It's still pre-algorithm-maturity, which means consistent posting beats clever optimization.

### 5.2 Format
- Conversational, lowercase, no hashtags, no links in the main post (links are de-ranked; put them in a reply to your own post)
- 1–3 short sentences per post
- Replies to large accounts in your niche are the #1 follow lever (mirrors X but with less competition)
- Polls and "what's your take" prompts outperform statements

### 5.3 Cadence
3–6 posts/day works; replies cost nothing (no character cost on engagement). Brain should compose 5+ posts/day in draft and the operator picks 3.

---

## 6. LinkedIn

### 6.1 Algorithm signals
1. **Comments from inside your network** — heavily weighted; LinkedIn's algorithm is network-graph-first, content-second.
2. **Dwell time** — measured via expanded text "see more" clicks.
3. **Profile clicks from the post** — the conversion the algorithm optimizes for.
4. **Re-shares from inside your network** > re-shares from outside.

### 6.2 Format that wins
- Personal narrative + business lesson + concrete takeaway (the so-called "broetry" format, still the highest-engagement template on the platform)
- Carousels (PDF docs) — 2–3× the dwell time of text posts
- Polls — high engagement, low follow conversion
- Pure text posts ≤ 200 words with line breaks every 1–2 sentences

### 6.3 Cadence
3–5 posts/week. > 1/day actually decreases reach (LinkedIn assumes the user is spamming and throttles).

### 6.4 Best for
B2B / SaaS / consulting / coaching niches. Tutorial channels and entertainment niches mostly fail here.

---

## 7. Pinterest

### 7.1 The underrated traffic source
Pinterest is the **single best long-tail traffic source** for tutorial / how-to / DIY / recipe / design niches. A single pin can drive traffic for 12–24 months after creation, unlike every other platform.

### 7.2 Algorithm signals
1. **Save rate** (Pinterest's primary engagement metric)
2. **Outbound click-through** (Pinterest wants to send people *off* the platform — opposite of all other socials)
3. **Pin freshness** — fresh pins outperform repinned content
4. **Idea Pin completion %** (Pinterest's Reels equivalent, recently de-emphasized)

### 7.3 Format
- 1000×1500 vertical
- Bold text overlay (Pinterest is browsed muted, so text > video for most niches)
- High contrast color (terracotta, navy, mustard outperform grayscale)
- Title text describing the outcome ("15-minute pasta recipes for busy weeknights")
- Description with 3–5 relevant search keywords

### 7.4 Cadence
5–15 fresh pins/day per board. The brain can mass-produce pins from a single blog post / video by re-cropping the thumbnail with different text overlays — Pinterest treats each as a fresh pin.

---

## 8. Cross-platform repurpose decision tree

For every long-form video produced:

```
                long-form video (8–15 min, YouTube/Spotify/Podcast)
                              │
       ┌──────────────────────┼──────────────────────┐
       ▼                      ▼                      ▼
  3–5 Shorts cuts        1 X thread          1 LinkedIn post
  (30s, native re-export, (8–12 tweets,        (if B2B niche)
   no watermarks)         from script's
       │                  best 8 quotes)
       ▼
  ┌────┼─────┬─────┐
  ▼    ▼     ▼     ▼
 YT   TT   IG    FB
 Sh.       Reels  Reels
              │
              ▼
        1 Pinterest pin
        (1000×1500 of the
         thumbnail, retitled)
```

Order of priority for first-time operators: **YouTube long-form → 3 Shorts on YT/TT/IG simultaneously → 1 X thread**. Add LinkedIn + Pinterest once the first three are running smoothly. Spreading too thin across all 7 surfaces at once tanks all of them.

---

## 9. Brand voice + tone (must be consistent)

The single biggest determinant of follow-conversion is **voice consistency**. Every business should define:

1. **One emotion the audience feels reading the post** (curious, validated, motivated, amused, informed)
2. **Three words the brand never uses** (e.g. "synergy", "leverage", "ecosystem" for an anti-corporate brand)
3. **Two recurring phrases the brand uses** (catchphrases that signal "this is us")
4. **Per-platform tone modifier** (X = punchier; LinkedIn = warmer; TikTok = more emotional; IG = more aspirational)

The brain should store this as a `brand_dna` row per workspace and inject the relevant block into every script-draft and reply-draft.

---

## 10. ToS & ban-survival rules (cross-platform)

| Behavior | YouTube | TikTok | IG | X | Threads | LinkedIn |
|---|---|---|---|---|---|---|
| AI voiceover (declared or implied) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| AI-generated faces ("deepfake") | ⚠ requires disclosure | ⚠ disclosure | ⚠ disclosure | ✅ | ✅ | ⚠ |
| Repost from another platform with watermark | ⚠ ranks lower | ❌ shadow-bans | ❌ down-ranks | ✅ | ✅ | ✅ |
| Auto-comment / auto-reply | ❌ ban | ❌ ban | ❌ ban | ❌ rate-limit | ❌ ban | ❌ ban |
| Cross-post identical content to multiple owned accounts | ⚠ duplicate detection | ⚠ duplicate | ⚠ down-rank | ✅ | ✅ | ✅ |
| Buy followers / likes | ❌ purge | ❌ purge | ❌ purge | ❌ purge | ❌ | ❌ |
| Engagement pods (group like/comment swap) | ⚠ low risk | ⚠ | ❌ if detected | ⚠ | ⚠ | ⚠ |

The brain should never automate any column with ❌ in this table, and should require operator confirmation for any ⚠.

---

## 11. Brain decision pattern

When the brain is asked "what should we post today on [platform]" it should:

1. Pull recent performance from `content_analytics` for that platform (last 14 days)
2. Identify the **top-decile post** by platform's primary signal (watch-through for TT/Reels/Shorts, replies for X, sends for IG, comments for LinkedIn)
3. Identify which **format + hook + length combination** drove it
4. Generate 3 candidate posts that copy the format + hook style but cover a different topic from the current backlog
5. Score the candidates against the audience's stated values (from `brand_dna`)
6. Return the top candidate for operator approval (or auto-publish if `autopilot_per_platform[platform] === true` AND the kill-switch is off)

This is the loop the brain runs continuously — not "what's a creative idea" but "what worked last week and how do we vary it".
