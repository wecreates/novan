/**
 * workspace-bootstrap.ts — Boot-time seed of the operator's baseline state.
 *
 * Several tables ship empty by design (operator configures them) but a
 * handful need at least ONE row so the rest of the platform has something
 * to read. Without this:
 *   - provider routing returns null and chat hits env-var fallback only
 *   - safety kill-switches array is empty so the brain graph shows no
 *     governance posture
 *   - runtime fabric has no node to schedule against
 *   - setup_state is null so onboarding hints never resolve
 *
 * Idempotent: every insert is gated by a "row already exists" check.
 * Re-running on every boot is a no-op after the first time.
 */
import { db } from '../db/client.js'
import {
  providerConfigs, killSwitches, runtimeNodes, setupState, notificationPrefs,
  externalFeeds, businesses, businessSystems, researchTopics, agentDefinitions,
} from '../db/schema.js'
import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { KNOWN_PROVIDERS } from './chat-providers.js'

interface BootstrapResult {
  providersSeeded: number
  killSwitchesSeeded: number
  runtimeNodesSeeded: number
  setupStateSeeded: boolean
  notificationPrefsSeeded: boolean
  feedsSeeded: number
  businessesBackfilled: number
  businessSystemsSeeded: number
  researchTopicsSeeded: number
  monitorAgentsSeeded: number
  promptSeedsInserted: number
}

// OpenJarvis monitor-operative agents — ported from
// OpenJarvis-main/src/openjarvis/agents/templates/*.toml as native
// agent_definitions. Each runs on a schedule (handled by openjarvis-monitors
// cron) and uses brain-task ops as its tools.
const OPENJARVIS_MONITORS: Array<{
  slug: string; name: string; department: string; description: string
  intervalSec: number; tools: string[]; systemPrompt: string
}> = [
  {
    slug:        'openjarvis-code-reviewer',
    name:        'Code Reviewer (OpenJarvis)',
    department:  'engineering',
    description: 'Monitors the repository for changes, reviews code quality, identifies bugs.',
    intervalSec: 3600,
    tools:       ['code.search', 'desktop.read_file', 'desktop.exec', 'db.query'],
    systemPrompt: `You are a code review monitor operative.
On each cycle:
1. Use code.search to find recently modified files (last 24h).
2. Read the changed files via desktop.read_file.
3. Identify: bugs, security issues, performance concerns, missing error handling.
4. Report findings as a concise bulleted summary. Each finding cites file:line.
5. If a fix is small + safe, propose it as a HANDOFF: engineering — <ask>.
Never modify code directly — only report and propose. Stay tactical.`,
  },
  {
    slug:        'openjarvis-inbox-triager',
    name:        'Inbox Triager (OpenJarvis)',
    department:  'operations',
    description: 'Monitors notifications + messages, categorizes by priority + summarizes.',
    intervalSec: 1800,
    tools:       ['db.query', 'issue.create'],
    systemPrompt: `You are an inbox triage operative.
On each cycle:
1. Query recent notifications + events (last 30 min).
2. Categorize: urgent / important / informational / noise.
3. Summarize each non-noise item in <= 1 line.
4. If urgent + actionable, create an issue via issue.create.
5. Output a 5-line bulleted digest sorted by priority.`,
  },
  {
    slug:        'openjarvis-research-monitor',
    name:        'Research Monitor (OpenJarvis)',
    department:  'research',
    description: 'Searches papers, news, blogs on configured topics. Stores findings.',
    intervalSec: 24 * 3600,   // daily 9am-ish via jitter
    tools:       ['web.fetch', 'code.search', 'db.query'],
    systemPrompt: `You are a research monitor operative.
On each cycle:
1. Query active research_topics from the database.
2. For each topic, pull the most relevant recent finding signals (RSS, web.fetch).
3. Summarize the top 3 findings across all topics in <= 5 lines each.
4. Note any actionable opportunities; mark with HANDOFF: product or HANDOFF: marketing.
5. Cite sources by URL.`,
  },
  {
    slug:        'openjarvis-personal-deep-research',
    name:        'Personal Deep Research (OpenJarvis)',
    department:  'research',
    description: 'On-demand deep research across the operators knowledge base; produces cited reports.',
    intervalSec: 0,   // manual / on-demand only
    tools:       ['db.query', 'code.search', 'web.fetch'],
    systemPrompt: `You are a deep research agent.
Given a research question:
1. Query reasoning_chains + memories + research_findings tables for prior context.
2. If context is thin, supplement with 2-3 targeted web.fetch calls.
3. Synthesize a cited report: claim → evidence → confidence (high/medium/low).
4. Cite every claim with chain id, finding id, or URL.
5. End with: "Open questions:" (list anything you could not resolve).
Stay tactical. Mark forecasts with confidence levels. No filler.`,
  },
]

// Monetization + skill-development research topics. The brain polls each
// on its own cadence (6h default) and accumulates findings the operator
// can browse on /research. Hits the autonomous-mind + recommendation
// engine downstream so insights surface as roadmap tasks.
const DEFAULT_RESEARCH_TOPICS: Array<{ topic: string; description: string; tags: string[] }> = [
  { topic: 'High-conversion landing page patterns',
    description: 'Headlines, hero-section structure, CTA placement, social proof — what is converting in 2026',
    tags: ['monetization', 'conversion', 'cro'] },
  { topic: 'YouTube long-form growth tactics',
    description: 'Title + thumbnail patterns, retention curves, packaging, AI-assisted ideation for 8-15 min videos',
    tags: ['youtube', 'long-form', 'content'] },
  { topic: 'YouTube Shorts / TikTok / Reels short-form playbook',
    description: 'Hook formulas, pacing, sound trends, vertical video editing, posting cadence',
    tags: ['shorts', 'short-form', 'social', 'video'] },
  { topic: 'Print-on-demand niches + trending designs',
    description: 'Profitable niches (Printful/Printify/Gelato), design trends, copyright-safe themes',
    tags: ['print-on-demand', 'pod', 'ecommerce'] },
  { topic: 'Passive income systems that scale',
    description: 'Real recurring-revenue plays: digital products, micro-SaaS, content licensing, affiliate stacks',
    tags: ['passive-income', 'monetization', 'scale'] },
  { topic: 'Social media management automation',
    description: 'Cross-posting, scheduling, response automation, batching workflows, time-saving tools',
    tags: ['social', 'automation', 'workflow'] },
  { topic: 'AI video editing + repurposing workflows',
    description: 'Long-form → shorts pipelines, captioning, b-roll generation, AI-assisted cuts',
    tags: ['video', 'editing', 'ai-tools'] },
  { topic: 'Codebase scaling + production hardening',
    description: 'Patterns for going from prototype to revenue: observability, queues, caching, deploys',
    tags: ['coding', 'scaling', 'engineering'] },
  { topic: 'Newsletter monetization + audience growth',
    description: 'Sponsorships, paid tiers, list growth, deliverability — Substack/Beehiiv/Ghost economics',
    tags: ['newsletter', 'monetization', 'audience'] },
  { topic: 'Digital product launches + price psychology',
    description: 'Tier pricing, anchoring, launch sequences, founders-discount tactics',
    tags: ['digital-products', 'pricing', 'launch'] },
  { topic: 'Affiliate + recurring revenue stacks',
    description: 'High-LTV affiliate programs, content-to-affiliate funnels, niche aggregation',
    tags: ['affiliate', 'recurring', 'monetization'] },
  { topic: 'Personal brand growth on X / LinkedIn',
    description: 'Posting cadence, thread structures, profile optimization, conversion to product/lead',
    tags: ['personal-brand', 'social', 'growth'] },
  { topic: 'AI tool stacks for creators + solopreneurs',
    description: 'Which models, which tools, which workflows are delivering ROI in 2026 — leave-no-stone-unturned',
    tags: ['ai-tools', 'creator', 'productivity'] },

  // ─── Music production — deep, evergreen knowledge for the conductor ──
  // The brain is the conductor of all music creation: every topic below
  // is studied on the same cadence as monetization topics, with findings
  // surfaced via /research and persisted into memories with high
  // confidence. This is what stops AI vocals from sounding robotic.
  { topic: 'Mixing fundamentals — gain staging, headroom, bus structure',
    description: 'Gain staging from input → channel → bus → master, K-system metering, -18 dBFS reference, why headroom prevents harsh artifacts',
    tags: ['music', 'mixing', 'fundamentals'] },
  { topic: 'EQ techniques — subtractive, additive, dynamic, surgical',
    description: 'When to cut vs boost, Q-width philosophy, dynamic EQ vs static, surgical de-ess, tilt EQ, mid-side EQ on the master bus',
    tags: ['music', 'mixing', 'eq'] },
  { topic: 'Compression — vocal, drum, bus, parallel, sidechain',
    description: 'Ratios + attack/release for each source family, parallel "New York" comp, sidechain ducking, multiband comp on vocals, glue comp on the bus',
    tags: ['music', 'mixing', 'compression'] },
  { topic: 'Vocal production — recording, tuning, doubling, ad-libs',
    description: 'Mic placement, plosive control, Auto-Tune vs Melodyne workflows, manual pitch correction without artifacts, double-tracking, stacking harmonies, lead/ad-lib balance',
    tags: ['music', 'vocals', 'production'] },
  { topic: 'Anti-robotic vocal techniques — humanizing AI + synthetic voices',
    description: 'Breath insertion, micro-pitch variation, formant shifting, vibrato modulation, de-essing for AI sibilance, room IR simulation, mouth-noise blending — why this matters for ACE-Step / Suno / Udio outputs',
    tags: ['music', 'vocals', 'ai-vocals', 'anti-robotic'] },
  { topic: 'Mastering — broadcast spec, loudness, true peak, dither',
    description: 'EBU R128 + -14 LUFS streaming target, true-peak limiting -1 dBTP, M/S processing, multiband on master, dithering 32→24→16, reference-track methodology',
    tags: ['music', 'mastering', 'broadcast'] },
  { topic: 'Sound design — synthesis, sampling, layering, sub-bass',
    description: 'Subtractive vs FM vs wavetable synthesis, sample layering, sub-bass design + mono-summing, transient shaping, granular textures',
    tags: ['music', 'sound-design', 'synthesis'] },
  { topic: 'Drum programming + groove engineering',
    description: 'Swing/shuffle ratios, ghost notes, velocity humanization, kick/snare phase alignment, drum bus processing, parallel saturation',
    tags: ['music', 'drums', 'rhythm'] },
  { topic: 'Music theory for producers — keys, modes, progressions',
    description: 'Diatonic chord function, modal interchange, secondary dominants, voice leading, tension-and-release pacing, BPM-to-key emotional pairings',
    tags: ['music', 'theory', 'composition'] },
  { topic: 'Song arrangement + dynamic structure',
    description: 'Intro/verse/pre/chorus/bridge/outro pacing per genre, energy curves, contrast tools (drop-outs, risers, impacts), 8/16/32 bar conventions',
    tags: ['music', 'arrangement', 'structure'] },
  { topic: 'Genre-specific production playbooks',
    description: 'Hip-hop (808s + hats + vocal chops), EDM (sidechain pump + drops), pop (vocal-forward mix + bright master), lo-fi (analog filter + tape sat), R&B (lush pads + 808s), country (acoustic + wide stereo), rock (mids-forward guitars)',
    tags: ['music', 'genre', 'playbook'] },
  { topic: 'Reverb + delay — spaces, depth, sends, pre-delay',
    description: 'Room vs hall vs plate vs spring, send-based reverb architecture, pre-delay for vocal clarity, ducked reverb, ping-pong delay, tempo-synced delays',
    tags: ['music', 'mixing', 'reverb', 'delay'] },
  { topic: 'Saturation + harmonic enhancement',
    description: 'Tube vs tape vs transformer saturation, even vs odd harmonics, exciters on vocals, bass saturation for translation on small speakers, master-bus glue saturation',
    tags: ['music', 'saturation', 'mixing'] },
  { topic: 'Stereo imaging + width — mid/side, Haas, panning',
    description: 'Mono-bass principle, mid/side EQ + comp, Haas trick for width, panning conventions per source family, correlation meters, mono-compatibility',
    tags: ['music', 'stereo', 'imaging'] },
  { topic: 'Lyric writing — meter, rhyme schemes, narrative arcs',
    description: 'Syllable counts per line by genre, internal vs end rhyme, slant rhyme, hook-chorus-verse density, repetition vs novelty, story arcs for verses',
    tags: ['music', 'lyrics', 'songwriting'] },
  { topic: 'Mixcraft 11 — workflow, shortcuts, virtual instruments, FX',
    description: 'Keyboard shortcuts, Performance Panel, MIDI editing, virtual instrument library, built-in mastering, automation lanes, send/return setup',
    tags: ['music', 'mixcraft', 'daw', 'workflow'] },
  { topic: 'Reference tracks + critical listening',
    description: 'How to pick references, A/B level-matching, frequency-balance reference checks, translation testing (phone/laptop/car/club), ear fatigue management',
    tags: ['music', 'mixing', 'reference'] },
  { topic: 'AI music systems — ACE-Step, Suno, Udio, Stable Audio, MusicGen',
    description: 'Capabilities + limitations of each, prompt engineering for music, stem-based generation (lego mode), cover/repaint workflows, copyright considerations',
    tags: ['music', 'ai-tools', 'generation'] },
  { topic: 'Music monetization — streaming royalties, sync licensing, beat sales',
    description: 'Spotify/Apple per-stream economics, sync placement strategy, beat-leasing platforms (BeatStars/Airbit), publishing splits, PRO registration',
    tags: ['music', 'monetization', 'royalties'] },
  { topic: 'Famous producers + their signature techniques',
    description: 'What Rick Rubin, Quincy Jones, Max Martin, Metro Boomin, Mike Dean, Finneas, Jack Antonoff actually do behind the desk — recurring patterns, mic chains, plugin chains',
    tags: ['music', 'producers', 'study'] },

  // ─── Video editing — deep, evergreen knowledge for mass production ──
  { topic: 'Retention curves — the science of watch-time',
    description: 'YouTube/TikTok retention shape, the 30-second drop-off cliff, re-hooking patterns, AVD vs APV, chapter pacing, why intros need to land in 4s',
    tags: ['video', 'retention', 'youtube', 'tiktok'] },
  { topic: 'Hook patterns — first 3 seconds that stop the scroll',
    description: 'Pattern interrupts, visual surprise, contrarian openings, on-screen text hooks, "you won\'t believe…" formulas that actually work, mid-hook re-engagement',
    tags: ['video', 'hook', 'short-form', 'engagement'] },
  { topic: 'Cut pacing + jump-cut philosophy',
    description: 'When to cut on motion vs cut on word, jump-cut density per genre, the 3-second rule for B-roll, breath-pause cuts, beat-matched cuts',
    tags: ['video', 'editing', 'pacing'] },
  { topic: 'J-cuts and L-cuts for cinematic flow',
    description: 'Audio leading video (J-cut), video leading audio (L-cut), how interviews use both, why this elevates amateur edits to cinematic',
    tags: ['video', 'editing', 'audio'] },
  { topic: 'Color grading — LUTs, scopes, exposure, contrast',
    description: 'Waveform vs vectorscope reading, base correction → creative grade workflow, LUT stacking, skin-tone protection, look development per genre',
    tags: ['video', 'color', 'grading'] },
  { topic: 'B-roll strategy — what to layer, when, and why',
    description: 'Establishing → detail → reaction shot rhythm, the 3-1 B-roll rule, b-roll density for retention, when to NOT cut to b-roll',
    tags: ['video', 'broll', 'composition'] },
  { topic: 'Captions + on-screen text — typography, placement, timing',
    description: 'Caption font choices (high-contrast sans), safe zones for vertical, word-by-word vs sentence captions, animated text patterns, ADA compliance',
    tags: ['video', 'captions', 'typography'] },
  { topic: 'Audio for video — dialogue, SFX, music, ducking',
    description: 'Dialogue clarity (-12 dBFS), SFX layering, ambient bed, music-under-dialogue ducking by 6-10dB, transition SFX library curation',
    tags: ['video', 'audio', 'mixing'] },
  { topic: 'Aspect ratios + safe zones — 9:16, 16:9, 1:1',
    description: 'Platform requirements per platform (TikTok/Shorts vertical, YouTube long-form 16:9, Instagram feed 4:5), safe-zone composition, repurposing landscape → vertical',
    tags: ['video', 'aspect-ratio', 'platform'] },
  { topic: 'Transitions — when they help, when they kill momentum',
    description: 'Hard cut as default, whip pan / match cut / morph / luma key for moments, why most fancy transitions hurt retention',
    tags: ['video', 'transitions', 'editing'] },
  { topic: 'CapCut Desktop workflow — shortcuts, effects, auto-captions',
    description: 'Ctrl+B split, Ctrl+I import, multi-track timeline, auto-captions accuracy, beat detection for music sync, export presets per platform',
    tags: ['video', 'capcut', 'workflow'] },
  { topic: 'Short-form playbook — TikTok / Reels / Shorts',
    description: '7-second hook + 3-act micro-story + loop close, hashtag strategy, posting cadence, sound-trend exploitation, vertical-only b-roll',
    tags: ['video', 'short-form', 'tiktok', 'shorts'] },
  { topic: 'Long-form playbook — 8-15 min YouTube',
    description: 'Chapter structure, retention pattern (peak-valley-peak), end-screen CTA, thumbnail + title coupling, the "value loop" mid-video',
    tags: ['video', 'long-form', 'youtube'] },
  { topic: 'Repurposing long-form into shorts',
    description: 'Best-clip detection (laughter, surprise, strong claim), 30-60s extraction with new hooks, captioning the cut, vertical reframing',
    tags: ['video', 'repurposing', 'workflow'] },
  { topic: 'Thumbnail design + click-through optimization',
    description: 'High-contrast subject, expressive faces, 3-word max text, color-blocking against YouTube UI, A/B testing thumbnails',
    tags: ['video', 'thumbnail', 'ctr'] },
  { topic: 'Stock + royalty-free asset sources',
    description: 'Pexels, Pixabay, Unsplash, Mixkit, Coverr, Internet Archive — license rules, attribution requirements, when to pay for premium (Artgrid/Storyblocks)',
    tags: ['video', 'assets', 'stock'] },
  { topic: 'AI tools in the video pipeline — captions, b-roll, voiceover',
    description: 'Whisper for transcript-driven editing, ElevenLabs/Play.ht voiceover, Runway / Sora / Veo for synthetic b-roll, AI thumbnail generation',
    tags: ['video', 'ai-tools', 'workflow'] },
  { topic: 'Encoding + delivery — codecs, bitrate, frame rate',
    description: 'H.264 vs H.265 vs ProRes, 1080p vs 4k bitrate targets, 24/30/60fps decisions, two-pass encoding for upload-quality',
    tags: ['video', 'encoding', 'delivery'] },
  { topic: 'Famous editors + their signature styles',
    description: 'What MrBeast\'s editors do with cuts-per-second, Casey Neistat\'s timelapse + music-led pacing, Marques Brownlee\'s clean precision, Emma Chamberlain\'s text-heavy chaos',
    tags: ['video', 'editors', 'study'] },
  { topic: 'Video monetization — RPM, sponsors, mid-rolls, end-cards',
    description: 'YouTube RPM by niche, mid-roll placement for retention, sponsor-integration patterns, end-card CTA hierarchy, channel-membership funnels',
    tags: ['video', 'monetization', 'youtube'] },
]

// Well-known feeds — high-signal sources the feed-ingester polls on
// its own schedule. Operator can add more via the UI; these are just
// enough to make the cron meaningful from day 1.
const DEFAULT_FEEDS = [
  { name: 'Hacker News (front page)',      url: 'https://hnrss.org/frontpage',                  tags: ['tech', 'news', 'discussion'] },
  { name: 'Hacker News — Show HN',         url: 'https://hnrss.org/show',                       tags: ['tech', 'launch', 'product'] },
  // GitHub Trending: github.trendiverse.app was unreachable. Use Mshibly's
  // mirror which actually serves Atom for trending repos.
  { name: 'GitHub Trending (daily)',       url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml', tags: ['github', 'trending', 'oss'] },
  { name: 'arXiv cs.AI (recent)',          url: 'https://export.arxiv.org/rss/cs.AI',           tags: ['research', 'ai', 'paper'] },
  { name: 'arXiv cs.LG (recent)',          url: 'https://export.arxiv.org/rss/cs.LG',           tags: ['research', 'ml', 'paper'] },
  { name: 'Anthropic News',                url: 'https://www.anthropic.com/news/rss.xml',       tags: ['ai', 'anthropic', 'product'] },
  { name: 'OpenAI Blog',                   url: 'https://openai.com/blog/rss.xml',              tags: ['ai', 'openai', 'product'] },
  { name: 'CNCF Blog',                     url: 'https://www.cncf.io/feed/',                    tags: ['infra', 'cloud-native'] },
  { name: 'Vercel Changelog',              url: 'https://vercel.com/changelog/feed.xml',        tags: ['infra', 'changelog'] },
  // NIST NVD .json.gz isn't RSS; replaced with CVE alerting feed.
  { name: 'CISA Known Exploited Vulns',    url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.xml', tags: ['security', 'cve', 'kev'] },

  // ─── Music production — pro audio + producer-craft feeds ─────────────
  { name: 'Sound on Sound (techniques + reviews)',
    url:  'https://www.soundonsound.com/feeds/articles.rss',
    tags: ['music', 'production', 'techniques'] },
  { name: 'Production Expert (mixing/mastering)',
    url:  'https://www.production-expert.com/production-expert-1?format=rss',
    tags: ['music', 'mixing', 'mastering'] },
  { name: 'Bobby Owsinski — Music Production',
    url:  'https://bobbyowsinski.blogspot.com/feeds/posts/default?alt=rss',
    tags: ['music', 'production', 'mixing'] },
  { name: 'Pro Tools Expert',
    url:  'https://www.pro-tools-expert.com/production-expert-1?format=rss',
    tags: ['music', 'daw', 'pro-tools'] },
  { name: 'Mixing Engineer (Mike Senior)',
    url:  'https://www.cambridge-mt.com/blog/feed/',
    tags: ['music', 'mixing', 'engineering'] },
  { name: 'arXiv eess.AS — Audio + Speech Processing',
    url:  'https://export.arxiv.org/rss/eess.AS',
    tags: ['music', 'research', 'audio', 'paper'] },
  { name: 'arXiv cs.SD — Sound',
    url:  'https://export.arxiv.org/rss/cs.SD',
    tags: ['music', 'research', 'audio', 'paper'] },
  { name: 'Reddit r/WeAreTheMusicMakers (top)',
    url:  'https://www.reddit.com/r/WeAreTheMusicMakers/top/.rss?t=week',
    tags: ['music', 'community', 'production'] },
  { name: 'Reddit r/edmproduction (top)',
    url:  'https://www.reddit.com/r/edmproduction/top/.rss?t=week',
    tags: ['music', 'community', 'edm', 'production'] },
  { name: 'Reddit r/mixingmastering (top)',
    url:  'https://www.reddit.com/r/mixingmastering/top/.rss?t=week',
    tags: ['music', 'community', 'mixing', 'mastering'] },
  { name: 'Reddit r/Mixcraft (top)',
    url:  'https://www.reddit.com/r/Mixcraft/top/.rss?t=month',
    tags: ['music', 'mixcraft', 'daw'] },

  // ─── Video editing — pro tutorial + creator-economy feeds ───────────
  { name: 'No Film School',
    url:  'https://nofilmschool.com/rss.xml',
    tags: ['video', 'editing', 'filmmaking'] },
  { name: 'PremiumBeat blog (video editing)',
    url:  'https://www.premiumbeat.com/blog/feed/',
    tags: ['video', 'editing', 'techniques'] },
  { name: 'Frame.io Insider',
    url:  'https://blog.frame.io/feed/',
    tags: ['video', 'post-production', 'workflow'] },
  { name: 'YouTube Creator Insider',
    url:  'https://www.youtube.com/feeds/videos.xml?channel_id=UCGg-UqjRgzhYDPJMr-9HXCg',
    tags: ['video', 'youtube', 'creator'] },
  { name: 'TubeFilter (creator economy news)',
    url:  'https://www.tubefilter.com/feed/',
    tags: ['video', 'creator-economy', 'platforms'] },
  { name: 'Reddit r/VideoEditing (top)',
    url:  'https://www.reddit.com/r/VideoEditing/top/.rss?t=week',
    tags: ['video', 'community', 'editing'] },
  { name: 'Reddit r/CapCut (top)',
    url:  'https://www.reddit.com/r/CapCut/top/.rss?t=month',
    tags: ['video', 'capcut', 'community'] },
  { name: 'Reddit r/NewTubers (top)',
    url:  'https://www.reddit.com/r/NewTubers/top/.rss?t=week',
    tags: ['video', 'youtube', 'growth'] },
  { name: 'Reddit r/TikTok (top)',
    url:  'https://www.reddit.com/r/Tiktokhelp/top/.rss?t=week',
    tags: ['video', 'tiktok', 'growth'] },
]

const DEFAULT_KILL_SWITCHES = [
  { switchType: 'autonomous_writes',     reason: 'Default off — operator must enable' },
  { switchType: 'autonomous_deploys',    reason: 'Default off — operator must enable' },
  { switchType: 'destructive_migrations', reason: 'Default off — operator must enable' },
  { switchType: 'external_communications', reason: 'Default off — outbound email/Slack disabled until configured' },
] as const

export async function bootstrapWorkspace(workspaceId = 'default'): Promise<BootstrapResult> {
  const now = Date.now()
  const result: BootstrapResult = {
    providersSeeded: 0, killSwitchesSeeded: 0, runtimeNodesSeeded: 0,
    setupStateSeeded: false, notificationPrefsSeeded: false,
    feedsSeeded: 0,
    businessesBackfilled: 0, businessSystemsSeeded: 0,
    researchTopicsSeeded: 0,
    monitorAgentsSeeded: 0,
    promptSeedsInserted: 0,
  }

  // Seed the prompt-evolution registry with the curated starter prompts
  // from the playbooks. Idempotent — re-running skips slots that already
  // have a version. Without this, usePrompt() returns null on first call
  // and the brain falls back to hardcoded prompts in service code.
  try {
    const { seedAll } = await import('./prompt-seeds.js')
    const seedRes = await seedAll(workspaceId)
    result.promptSeedsInserted = seedRes.inserted.length
  } catch (e) {
    console.error('[workspace-bootstrap] prompt seed failed:', (e as Error).message)
  }

  // ─── 1. Provider configs — one row per provider whose env-var key is set ──
  for (let i = 0; i < KNOWN_PROVIDERS.length; i++) {
    const p = KNOWN_PROVIDERS[i]!
    if (!process.env[p.envVar]) continue   // skip providers without keys
    const existing = await db.select({ id: providerConfigs.id }).from(providerConfigs)
      .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.providerId, p.id)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (existing) continue
    await db.insert(providerConfigs).values({
      id:           uuidv7(),
      workspaceId,
      providerId:   p.id,
      label:        p.id,
      enabled:      true,
      priority:     i,                       // order from KNOWN_PROVIDERS
      apiKeyEncrypted: null,
      apiKeyIv:     null,
      maxCostPerReqUsd: 0.1,
      notes:        'auto-seeded from env-var presence at boot',
      createdAt:    now,
      updatedAt:    now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.providersSeeded++
  }

  // ─── 2. Kill switches — safe defaults so the brain graph + governance
  //         layer have something to render. All START disabled.
  for (const ks of DEFAULT_KILL_SWITCHES) {
    const existing = await db.select({ id: killSwitches.id }).from(killSwitches)
      .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.switchType, ks.switchType)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (existing) continue
    await db.insert(killSwitches).values({
      id:        uuidv7(),
      workspaceId,
      switchType: ks.switchType,
      enabled:   false,
      reason:    ks.reason,
      enabledBy: null,
      enabledAt: null,
      disabledAt: now,
      createdAt: now,
      updatedAt: now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.killSwitchesSeeded++
  }

  // ─── 3. Runtime nodes — register the API process as a runtime node ─────
  const apiNodeName = `api-${process.pid}`
  const existingNode = await db.select({ id: runtimeNodes.id }).from(runtimeNodes)
    .where(and(eq(runtimeNodes.workspaceId, workspaceId), eq(runtimeNodes.role, 'api')))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (!existingNode) {
    await db.insert(runtimeNodes).values({
      id:           uuidv7(),
      workspaceId,
      region:       process.env['AWS_REGION'] ?? process.env['REGION'] ?? 'local',
      role:         'api',
      status:       'up',
      capacity:     100,
      activeLoad:   0,
      queueDepth:   0,
      endpoint:     `http://localhost:${process.env['API_PORT'] ?? '3001'}`,
      metadata:     { hostname: process.env['HOSTNAME'] ?? 'unknown', name: apiNodeName, pid: process.pid },
      lastHeartbeatAt: now,
      createdAt:    now,
      updatedAt:    now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.runtimeNodesSeeded++
  } else {
    // Refresh heartbeat on every boot
    await db.update(runtimeNodes).set({
      status: 'up', lastHeartbeatAt: now, updatedAt: now,
    }).where(eq(runtimeNodes.id, existingNode.id)).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
  }

  // ─── 4. Setup state — initialize once so onboarding flows have a target ──
  const existingSetup = await db.select().from(setupState)
    .where(eq(setupState.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch(() => undefined)
  if (!existingSetup) {
    await db.insert(setupState).values({
      workspaceId,
      firstRunAt:          now,
      firstProviderAt:     result.providersSeeded > 0 ? now : null,
      completedOnboarding: false,
      updatedAt:           now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.setupStateSeeded = true
  } else if (result.providersSeeded > 0 && !existingSetup.firstProviderAt) {
    await db.update(setupState).set({ firstProviderAt: now, updatedAt: now })
      .where(eq(setupState.workspaceId, workspaceId)).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
  }

  // ─── 5. Notification prefs — sensible default so the brain knows what
  //         severity it can send + where (in-app only until operator opts in).
  // PK is (workspaceId, type). Seed three default types.
  for (const t of ['issue', 'incident', 'security']) {
    const existingPrefs = await db.select().from(notificationPrefs)
      .where(and(eq(notificationPrefs.workspaceId, workspaceId), eq(notificationPrefs.type, t)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (existingPrefs) continue
    await db.insert(notificationPrefs).values({
      workspaceId,
      type:          t,
      severityFloor: t === 'security' ? 'warning' : 'normal',
      mutedUntil:    null,
      updatedAt:     now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.notificationPrefsSeeded = true
  }

  // ─── 6. External feeds — seed 10 well-known sources so feed-ingester
  //         has work to do from boot. Operator can add/disable via UI.
  // Different poll cadences so we don't hammer everything on the same minute.
  const POLL_CADENCES = [10, 15, 30, 45, 60, 90, 120, 180, 240, 360]
  for (let i = 0; i < DEFAULT_FEEDS.length; i++) {
    const f = DEFAULT_FEEDS[i]!
    const existing = await db.select({ id: externalFeeds.id }).from(externalFeeds)
      .where(and(eq(externalFeeds.workspaceId, workspaceId), eq(externalFeeds.feedUrl, f.url)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (existing) continue
    await db.insert(externalFeeds).values({
      id:                uuidv7(),
      workspaceId,
      feedUrl:           f.url,
      name:              f.name,
      tags:              f.tags,
      intervalSeconds:   (POLL_CADENCES[i] ?? 60) * 60,
      maxItemsPerPoll:   25,
      enabled:           true,
      lastPolledAt:      null,
      lastSuccessAt:     null,
      pollCount:         0,
      itemsIngested:     0,
      errorCount:        0,
      lastError:         null,
      createdAt:         now,
      updatedAt:         now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.feedsSeeded++
  }

  // ─── 7. Backfill businesses without responsibleDepartments + scaffold
  //         minimal business_systems for any business missing them. CEO
  //         needs the link to know which agents to delegate to per biz.
  const bizList = await db.select().from(businesses)
    .where(eq(businesses.workspaceId, workspaceId)).catch(() => [])
  const DEFAULT_DEPTS = ['engineering', 'operations', 'product', 'growth']
  const STARTER_SYSTEMS: Array<{ kind: string; layer: string; name: string; summary: string }> = [
    { kind: 'goal',      layer: 'strategy',    name: 'North-star metric',     summary: 'Single number that defines success' },
    { kind: 'workflow',  layer: 'operations',  name: 'Customer feedback loop', summary: 'Capture signal, triage, ship fix' },
    { kind: 'workflow',  layer: 'operations',  name: 'Release pipeline',       summary: 'PR → typecheck → tests → deploy' },
    { kind: 'agent_slot', layer: 'execution',  name: 'Engineering lead',       summary: 'Owns codebase health' },
    { kind: 'agent_slot', layer: 'execution',  name: 'Product lead',           summary: 'Owns roadmap + customer fit' },
  ]
  for (const biz of bizList) {
    const meta = (biz.metadata as { responsibleDepartments?: string[] } | null) ?? {}
    if (!meta.responsibleDepartments || meta.responsibleDepartments.length === 0) {
      await db.update(businesses).set({
        metadata: { ...meta, responsibleDepartments: DEFAULT_DEPTS },
        updatedAt: now,
      }).where(eq(businesses.id, biz.id)).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
      result.businessesBackfilled++
    }
    // Skip system scaffold if any row already exists for this business
    const hasSystems = await db.select({ id: businessSystems.id }).from(businessSystems)
      .where(and(eq(businessSystems.workspaceId, workspaceId), eq(businessSystems.businessId, biz.id)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (hasSystems) continue
    for (const s of STARTER_SYSTEMS) {
      await db.insert(businessSystems).values({
        id:          uuidv7(),
        workspaceId,
        businessId:  biz.id,
        kind:        s.kind,
        layer:       s.layer,
        name:        s.name,
        summary:     s.summary,
        status:      'forming',
        agentSlug:   null,
        parentId:    null,
        position:    null,
        metadata:    {},
        createdAt:   now,
        updatedAt:   now,
      }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
      result.businessSystemsSeeded++
    }
  }

  // ─── 8. Seed monetization/skill-development research topics so the
  //         brain has things to learn about. Idempotent — checks by topic name.
  for (let i = 0; i < DEFAULT_RESEARCH_TOPICS.length; i++) {
    const t = DEFAULT_RESEARCH_TOPICS[i]!
    const existing = await db.select({ id: researchTopics.id }).from(researchTopics)
      .where(and(eq(researchTopics.workspaceId, workspaceId), eq(researchTopics.topic, t.topic)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (existing) continue
    // Stagger poll intervals so 13 topics don't all hit the network at once
    const intervalHours = 6 + (i % 6)   // 6-11h
    await db.insert(researchTopics).values({
      id: uuidv7(),
      workspaceId,
      topic:           t.topic,
      description:     t.description,
      approvedSources: [],
      approvedAgents:  ['web-research-agent', 'market_research', 'product_research', 'trend_detection'],
      status:          'active',
      pollIntervalSec: intervalHours * 3600,
      createdBy:       'bootstrap',
      createdAt:       now,
      updatedAt:       now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.researchTopicsSeeded++
  }

  // ─── 9. OpenJarvis monitor-operative agents — port the 4 templates
  //         as native agent_definitions. They become first-class agents
  //         the CEO can delegate to. The openjarvis-monitors cron (in
  //         learning-cron) invokes the scheduled ones on cadence.
  for (const m of OPENJARVIS_MONITORS) {
    const existing = await db.select({ id: agentDefinitions.id }).from(agentDefinitions)
      .where(and(eq(agentDefinitions.workspaceId, workspaceId), eq(agentDefinitions.slug, m.slug)))
      .limit(1).then(r => r[0]).catch(() => undefined)
    if (existing) continue
    const checksum = crypto.createHash('sha256').update(m.systemPrompt).digest('hex').slice(0, 16)
    await db.insert(agentDefinitions).values({
      id:           uuidv7(),
      workspaceId,
      slug:         m.slug,
      department:   m.department,
      name:         m.name,
      description:  m.description,
      color:        null, emoji: null, vibe: null,
      systemPrompt: m.systemPrompt,
      sourcePath:   `OpenJarvis-main/src/openjarvis/agents/templates/${m.slug.replace('openjarvis-', '')}.toml`,
      checksum,
      tags:         ['openjarvis', 'monitor-operative', `interval:${m.intervalSec}`, ...m.tools.map(t => `tool:${t}`)],
      createdAt:    now,
      updatedAt:    now,
    }).catch((e: Error) => { console.error('[workspace-bootstrap]', e.message); return null })
    result.monitorAgentsSeeded++
  }

  // ─── Civilization-layer seeds ───────────────────────────────────────
  // Governance defaults: seed the 7 default constitutional rules so
  // governance.check has something to enforce from the first call.
  try {
    const { listRules } = await import('./governance-engine.js')
    await listRules(workspaceId)  // listRules auto-seeds defaults if empty
  } catch { /* */ }

  // Operator DNA: seed the row so observeTurn has something to update.
  try {
    const { getOperatorDna } = await import('./civilization-core.js')
    await getOperatorDna(workspaceId)
  } catch { /* */ }

  // World-model: create a self-node for the workspace so subsequent
  // graph traversal has an anchor.
  try {
    const { upsertNode } = await import('./world-model.js')
    await upsertNode({
      id: `workspace:${workspaceId}`, workspaceId, kind: 'business',
      label: `Workspace ${workspaceId}`,
      attrs: { bootstrappedAt: now }, health: 1.0, importance: 1.0,
    })
  } catch { /* */ }

  // GUI queue table: eager-create so it exists from boot even before the
  // first cloud-routed music/CapCut/Mixcraft op fires. The schema is
  // auto-created on first enqueue, but eager-creating means health probes
  // + bridge.status calls work immediately on a fresh deploy.
  try {
    const { bridgeStatus } = await import('./gui-queue.js')
    await bridgeStatus()   // calls ensureTable() internally
  } catch { /* */ }

  return result
}
