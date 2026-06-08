/**
 * R146.351 — Trend → Design → Queue Pipeline
 *
 * Single op orchestrates: pick trending subjects → generate designs via HF →
 * generate per-platform listings → enqueue for manual upload across all
 * configured platforms.
 *
 * Output: full plan with design IDs, queue item IDs, paste-ready content
 * counts per platform.
 */
import { pickTrendingBatch, type TrendingSubject } from './r351-trend-catalog.js'
import { generateBatch } from './r349-design-factory.js'
import { generateListing, type Platform } from './r349-listing-content-rotator.js'
import { enqueue } from './r349-upload-queue.js'

const DEFAULT_PRIMARY_PLATFORMS: Platform[] = ['gumroad', 'fine_art_america', 'inprnt', 'etsy']
const DEFAULT_BACKGROUND_PLATFORMS: Platform[] = ['redbubble', 'zazzle', 'spreadshirt', 'teepublic', 'displate', 'threadless']
// Note: society6 removed (curated/invitation-only since Oct 2025).
// Note: pixels.com is FAA's sister site; auto-syncs from FAA account = no separate queue entries needed.

export interface RunTrendingPipelineInput {
  workspaceId:           string
  provenCount?:          number
  breakoutCount?:        number
  nicheBreakoutCount?:   number
  platforms?:            Platform[]                // default: all 9
  primaryOnly?:          boolean                    // restrict to 3 primary
  dryRun?:               boolean                    // pick + generate but don't queue
}

export interface PipelineDesignResult {
  subject:             string
  tier:                'proven' | 'breakout' | 'niche_breakout'
  niche:               string
  designId?:           string
  imageUrl?:           string
  perPlatformQueued:   Array<{ platform: Platform; queueItemId?: string; reason?: string }>
  generationError?:    string
}

export interface RunTrendingPipelineResult {
  generatedAt:         number
  picked:              { proven: number; breakout: number; nicheBreakout: number }
  platforms:           Platform[]
  designs:             PipelineDesignResult[]
  totals: {
    designsGenerated:  number
    queueItemsCreated: number
    designsFailed:     number
  }
}

export async function runTrendingPipeline(input: RunTrendingPipelineInput): Promise<RunTrendingPipelineResult> {
  const batch = pickTrendingBatch({
    ...(input.provenCount !== undefined        ? { provenCount: input.provenCount }               : {}),
    ...(input.breakoutCount !== undefined      ? { breakoutCount: input.breakoutCount }           : {}),
    ...(input.nicheBreakoutCount !== undefined ? { nicheBreakoutCount: input.nicheBreakoutCount } : {}),
  })
  const allSubjects: TrendingSubject[] = [...batch.proven, ...batch.breakout, ...batch.nicheBreakout]
  const platforms: Platform[] = input.primaryOnly
    ? DEFAULT_PRIMARY_PLATFORMS
    : (input.platforms ?? [...DEFAULT_PRIMARY_PLATFORMS, ...DEFAULT_BACKGROUND_PLATFORMS, 'tiktok_shop'])

  const results: PipelineDesignResult[] = []
  let designsGenerated  = 0
  let queueItemsCreated = 0
  let designsFailed     = 0

  // Group by niche so each generateBatch call hits the same image-gen template
  const byNiche = new Map<string, TrendingSubject[]>()
  for (const s of allSubjects) {
    const k = s.niche
    const list = byNiche.get(k) ?? []
    list.push(s)
    byNiche.set(k, list)
  }

  for (const [niche, subjects] of byNiche.entries()) {
    const gen = await generateBatch({
      workspaceId: input.workspaceId,
      niche:       niche as 'botanical',
      subjects:    subjects.map(s => s.subject),
    })
    // Match generated designs back to their TrendingSubject by prompt substring
    for (const s of subjects) {
      const design = gen.generated.find(d => d.prompt.includes(s.subject))
      if (!design) {
        const failure = gen.failed.find(f => f.subject === s.subject)
        results.push({
          subject:           s.subject,
          tier:              s.tier,
          niche:             s.niche,
          perPlatformQueued: [],
          generationError:   failure?.error ?? 'design not found in generation output',
        })
        designsFailed++
        continue
      }
      designsGenerated++

      const perPlatform: PipelineDesignResult['perPlatformQueued'] = []
      if (!input.dryRun) {
        for (const platform of platforms) {
          const listing = generateListing({
            platform, subject: s.subject, niche: s.niche, style: s.recommendedStyle, designId: design.id,
          })
          const queueRes = await enqueue({
            workspaceId: input.workspaceId,
            designId:    design.id,
            platform,
            title:       listing.title,
            description: listing.description,
            tags:        listing.tags,
            priceUsd:    listing.priceUsd,
            ...(listing.category ? { category: listing.category } : {}),
            priority:    s.tier === 'proven' ? 70 : s.tier === 'breakout' ? 60 : 50,
            notes:       `${s.tier} subject; conversion=${s.conversionScore}; saturation=${s.saturationScore}`,
          })
          if (queueRes.ok && queueRes.id) {
            perPlatform.push({ platform, queueItemId: queueRes.id })
            queueItemsCreated++
          } else {
            perPlatform.push({ platform, reason: queueRes.reason ?? 'enqueue returned no id (likely duplicate)' })
          }
        }
      }
      results.push({
        subject:           s.subject,
        tier:              s.tier,
        niche:             s.niche,
        designId:          design.id,
        imageUrl:          design.imageUrl.slice(0, 80) + '...[truncated]',
        perPlatformQueued: perPlatform,
      })
    }
  }

  return {
    generatedAt: Date.now(),
    picked: {
      proven:        batch.proven.length,
      breakout:      batch.breakout.length,
      nicheBreakout: batch.nicheBreakout.length,
    },
    platforms,
    designs: results,
    totals: {
      designsGenerated,
      queueItemsCreated,
      designsFailed,
    },
  }
}
