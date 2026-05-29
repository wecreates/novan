/**
 * prompt-seeds.ts — Starter prompts for the prompt-evolution registry.
 *
 * Each slot here is a real LLM job the brain runs as part of the
 * production pipeline. The bodies are pulled directly from the
 * playbooks in apps/api/knowledge so they ship with substantive
 * operating knowledge, not generic LLM fluff.
 *
 * Seeding is idempotent — `seedAll(workspaceId)` skips any slot that
 * already has a version row. Re-running the seed after operator
 * changes does not clobber their edits.
 *
 * The brain pulls from these slots via prompt-evolution.usePrompt(),
 * so this file is the single source of truth for "what does the brain
 * say when it's drafting a YouTube script for the operator".
 *
 * Adding a new slot:
 *   1. Add an entry to SEEDS below
 *   2. Reference it in the calling service via usePrompt() with a
 *      hardcoded fallback to the same body
 *   3. Call seedAll() at boot (already wired in server.ts)
 */
import { and, eq } from 'drizzle-orm'
import { db }     from '../db/client.js'
import { businessPrompts } from '../db/schema.js'
import { seedPrompt } from './prompt-evolution.js'

interface Seed {
  slot:  string
  body:  string
}

export const SEEDS: Seed[] = [
  // ─── YouTube long-form ───────────────────────────────────────────────
  {
    slot: 'youtube.script.draft',
    body: `You are drafting a YouTube long-form video script for a face-free channel.

Rules (from the YouTube automation playbook):
- The first 8 seconds MUST contain a hook from one of these patterns:
  • pattern interrupt ("you've been told X, but here's what's actually happening")
  • future-state preview ("by the end of this video you'll know how to do Y")
  • cost-of-not-watching ("the mistake in this clip cost me $4,000")
  • open loop ("I'll show you the answer at the 6:24 mark, but first…")
- NEVER open with "hey guys welcome back" or any greeting longer than 3 seconds
- Insert a retention beat every 30 seconds (B-roll cut, callback to hook, future-pace, comparison, or quote)
- Place a payoff at 50–60% of duration to lock in AVD
- Last 15 seconds: one-sentence subscribe pitch + end-screen CTA, no monologue
- Pacing: 140–160 words per minute spoken
- Target length: matches the channel's RPM tier (8–12 min for AI/tech, 12–25 min for history/documentary)

Output format:
Return ONLY the script, no preamble.
Use these markers:
  [HOOK 0:00–0:08] — the 8-second hook
  [BEAT 0:08] — first retention beat description in brackets, then dialogue
  [PAYOFF 6:00] — the mid-roll payoff
  [CTA] — final subscribe + end-screen

Tone matches the channel's brand DNA. Default to direct, evidence-led, no hype.`,
  },

  // ─── YouTube thumbnail prompt ────────────────────────────────────────
  {
    slot: 'youtube.thumbnail.prompt',
    body: `You are writing an image-generation prompt for a YouTube thumbnail.

Hard rules (from the playbook):
- ONE subject only — never multi-subject
- The thumbnail must pass the "three-second readability test" — identifiable at 1 thumbnail per second on mobile without reading text
- One bright color against a dark backdrop (yellow #FFD700, red #E63946, lime #A8E63A — pick one)
- Text overlay ≤ 4 words, bold sans-serif, minimum 80pt at 1280×720
- Face-free channels: use a product, object, or archetypal image (hand pointing, stack of cash, silhouette). NEVER stock-photo people.

Input format from the operator:
{
  "topic": "...",
  "channelStyle": "tech | finance | history | motivation | ...",
  "hookKeyword": "the one word that should anchor the visual"
}

Output: a single image-generation prompt (string) suitable for OpenAI / Stability / FAL / Replicate. Include explicit composition instructions: "centered subject, 16:9, dark background, single bright accent color, text overlay 'X' bottom-third in bold sans-serif". Maximum 250 words. Do NOT include the words "YouTube", "thumbnail", or "click-bait" in the prompt — those bias the generator toward clichéd outputs.`,
  },

  // ─── YouTube title ───────────────────────────────────────────────────
  {
    slot: 'youtube.title.draft',
    body: `Draft 5 YouTube title candidates for the video described below.

Rules:
- 50–60 characters each (mobile truncates at 60)
- Keyword in the first 40 characters
- Curiosity gap, not click-bait — promise something the video actually delivers
- Specific number beats vague claim ("I built 4 apps in 30 days" > "I built apps fast")
- No emoji unless the channel's niche convention uses them (gaming, reaction — yes; tutorial — no)
- No ALL CAPS

Output: a JSON array of exactly 5 strings, ordered by your confidence (most likely highest CTR first).`,
  },

  // ─── YouTube Shorts hook ─────────────────────────────────────────────
  {
    slot: 'shorts.hook',
    body: `Draft 3 candidate hooks (1–3 seconds each) for a YouTube Short.

Constraints:
- Each hook is a single sentence, max 12 words
- Must drive watch-through to 70% (the Shorts AVD threshold)
- Use one of these patterns:
  • "Three things nobody tells you about [X]"
  • "I tried [thing] for 30 days. Here's what happened:"
  • "Stop doing [common behavior] — here's why"
  • "If you're [demographic], stop scrolling"
  • "[Authority figure] just said [counterintuitive thing]"
- Each hook should ALSO suggest a long-form CTA the creator should drop in the caption ("full 12-min breakdown in my long-form video")

Output: JSON array of 3 objects, each { "hook": "...", "longFormCta": "..." }.`,
  },

  // ─── TikTok hook ─────────────────────────────────────────────────────
  {
    slot: 'tiktok.hook',
    body: `Draft a TikTok hook (1–3 seconds, max 14 words) for the topic below.

TikTok-specific:
- Avoid greetings, questions starting with "did you know", slow zoom-ins, lifestyle B-roll
- The hook should set up a watch-through > 65% (the dominant TikTok signal)
- Use patterns that perform: pattern interrupt, POV ("POV: you just realized…"), result-first ("I made $X in Y days. Here's how:"), or authority ("This [position] said [counterintuitive thing]")

Also output the suggested length and the trending-sound category if applicable.

Output JSON: { "hook": "...", "suggestedLengthSec": 21–34, "soundCategory": "..." }`,
  },

  // ─── Etsy listing description ────────────────────────────────────────
  {
    slot: 'etsy.listing.description',
    body: `Write an Etsy listing description for the POD product described below.

Mandatory structure (from the print-on-demand playbook):
1. First sentence (≤ 160 chars): the Google preview snippet — must include the primary keyword + a clear identity claim
2. 3–5 bulleted features (Etsy renders them)
3. Material + dimensions + shipping time
4. Care instructions
5. 1–2 gift-suggestion phrases that match buyer intent searches ("perfect for Mother's Day", "great for a nurse's birthday")
6. Final sentence: pull toward shop favorites ("browse more nurse gifts in my shop")

Keyword density rule: mention the primary keyword 2–3 times total, naturally. NOT 5 — Etsy detects keyword stuffing.

Tone: warm and direct. NEVER use the words "premium", "luxury", "boutique" unless the price point > $40.`,
  },

  // ─── Etsy tags ───────────────────────────────────────────────────────
  {
    slot: 'etsy.tags',
    body: `Generate exactly 13 Etsy tags for the listing described below.

Hard rules:
- Exactly 13 tags (Etsy ignores anything past 13)
- Max 20 chars per tag
- Each tag is a phrase a buyer might search ("nurse mug" not "nurse")
- Mix exact-match (3–4) + long-tail (4–5) + synonym (2–3) + audience descriptor (2–3)
- Repeat the primary keyword in 2–3 tags maximum — more triggers keyword-stuffing penalty
- NO commas inside tags
- NO trademark names

Output: a JSON array of exactly 13 strings.`,
  },

  // ─── Pinterest pin overlay ───────────────────────────────────────────
  {
    slot: 'pinterest.overlay',
    body: `Write the text overlay for a Pinterest pin (1000×1500 vertical).

Constraints:
- ≤ 8 words
- Bold sans-serif, will render large
- Use outcome-language ("15-minute weeknight pasta" not "easy pasta recipe")
- Match Pinterest's muted-browsing audience — viewer reads in 1 second

Output: { "overlay": "...", "titleSuggestion": "the pin's title that goes alongside" }`,
  },

  // ─── Comment reply (YouTube / generic social) ────────────────────────
  {
    slot: 'reply.youtube_comment',
    body: `Draft a reply to a YouTube comment on the operator's channel.

Brand-voice rules: use the operator's brand_dna block injected into the system prompt to keep tone consistent. Default tone if no brand DNA: warm, direct, never sycophantic, never defensive.

Reply rules:
- Match the commenter's energy level (excited → excited but grounded; critical → calm, evidence-led)
- If the comment is a question and you can answer in < 30 words, answer it
- If the comment is a complaint about an error in the video, ACKNOWLEDGE the error first, then explain
- If the comment is praise, say thanks in 1 sentence and add ONE thing they'll like in the next video (so they come back)
- Length: 10–40 words. Never longer.
- NEVER use "Great question!" or "Thanks for watching!" as openers — those signal automation

Refuse to draft a reply if the comment is:
- Spam / scam / link-laden
- Harassment / slur
- A trap question designed to provoke an out-of-context clip
Return the literal string "SKIP" for any of those.

Otherwise output ONLY the reply text — no preamble, no quotes.`,
  },

  // ─── Cross-platform repurpose plan ───────────────────────────────────
  {
    slot: 'repurpose.plan',
    body: `Given a long-form video's transcript + title, return a structured repurpose plan.

Surfaces to cover (in priority order — only generate for surfaces the operator has connected):
1. 3–5 Shorts/Reels/TikToks (30s vertical re-export, NOT a TikTok-watermarked repost) — pick the highest-energy moments
2. 1 X thread (8–12 tweets) of the video's key claims
3. 1 LinkedIn post (if niche is B2B/tech/finance — skip for entertainment niches)
4. 1 Pinterest pin (thumbnail re-crop with retitle)

Output JSON:
{
  "shorts": [{ "startSec": n, "endSec": n, "caption": "…", "hook": "…" }, …],
  "xThread": ["tweet 1", "tweet 2", …],
  "linkedinPost": "…" | null,
  "pinterestPin": { "title": "…", "overlay": "…" } | null
}

Hook the operator: every short's caption ends with the long-form CTA ("full 12-min breakdown in my channel").`,
  },

  // ─── Niche scoring ───────────────────────────────────────────────────
  {
    slot: 'niche.score',
    body: `Score a candidate niche against the $10k/mo per-business platform floor.

Input: { "niche": "…", "format": "tutorial | finance | history | …", "category": "youtube | pod | social | newsletter" }

Score on six axes — integer 0–10 + 1-sentence rationale each. The $10k floor axis is mandatory; failure on it auto-rejects regardless of other scores.

1. tenKFeasibility — does the math support $10k/mo? Use the playbook unit economics:
   • youtube: $5 RPM × required_views × 0.55 share ≥ $10k → required_views = ~3.6M/mo combined across portfolio
   • pod:     $9 avg margin × required_units ≥ $10k → required_units = ~1,110/mo
   • social:  ad-share-only rarely closes; needs a layered monetization (newsletter/course/product)
   • newsletter: $8 ARPU × 1,250 paying subs = $10k → 1,250 subs is the realistic minimum
   Score 10 if the math closes within 6 months at reasonable inputs; 5 if it needs aggressive growth + portfolio expansion; 0 if no realistic input set closes.
2. searchVolume — combined monthly searches for top 20 keywords (≥ 50k = 10; < 5k = 0)
3. competitionSaturation — channels > 100k subs (< 200 = 10; > 2,000 = 0)
4. productionEconomics — per-video / per-listing cost vs expected revenue at niche-typical traffic (cost < 30% of expected gross = 10; cost > 100% = 0)
5. evergreenToTrendRatio — % evergreen rankable for 12+ months (≥ 60% = 10; < 20% = 0)
6. advertiserFriendliness — ToS clearance + ad-friendly content (clean = 10; borderline = 5; banned topic = 0)

Output JSON: { "axes": { "tenKFeasibility": {"score": n, "why": "…with the actual numbers"}, ... }, "totalScore": sum, "verdict": "greenlight" | "marginal" | "reject", "tenKPath": "one sentence describing the specific path to $10k for this niche" }

Auto-reject rules:
- tenKFeasibility < 5 → verdict = "reject" (math doesn't close)
- ANY axis < 6 → verdict = "reject" (one weak axis sinks the niche)
- advertiserFriendliness < 8 → verdict = "reject" (ad-policy risk)

The tenKPath field MUST quote specific numbers — "needs 8 channels at 250k views/mo each" or "needs 1,200 sales/mo at $9 margin", not vague language.`,
  },
]

/** Idempotent seed for one workspace. Skips slots that already have any
 *  version row. Safe to call at boot + on operator request. */
export async function seedAll(workspaceId: string): Promise<{ inserted: string[]; skipped: string[] }> {
  const inserted: string[] = []
  const skipped: string[] = []
  for (const s of SEEDS) {
    const existing = await db.select({ id: businessPrompts.id })
      .from(businessPrompts)
      .where(and(eq(businessPrompts.workspaceId, workspaceId), eq(businessPrompts.slot, s.slot)))
      .limit(1)
    if (existing.length > 0) { skipped.push(s.slot); continue }
    await seedPrompt({ workspaceId, slot: s.slot, body: s.body, origin: 'seed' })
    inserted.push(s.slot)
  }
  return { inserted, skipped }
}

/** Inventory of available slots — used by docs + the brain to advertise
 *  capabilities. Returns the slot name only (not the body, which is large). */
export function availableSlots(): string[] {
  return SEEDS.map(s => s.slot)
}
