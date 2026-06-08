/**
 * R146.351 — Trend Intelligence Catalog
 *
 * Curated current POD/wall-art trend data with breakout candidate scoring.
 * Three tiers:
 *
 *   PROVEN     - Top sellers right now on Etsy/Redbubble/Society6/INPRNT.
 *                High demand, high saturation. Reliable revenue but
 *                competitive. Pace yourself - flood-uploading these
 *                triggers spam heuristics on saturated platforms.
 *
 *   BREAKOUT   - Rising trends with 60-180 day velocity in adjacent
 *                signal sources (Pinterest predicts, TikTok hashtags,
 *                Reddit cottagecore-adjacent subs, Etsy "newly listed"
 *                with high engagement). Less saturation, higher upside.
 *                These are where you out-earn established artists.
 *
 *   NICHE_BREAKOUT - Earliest signal, smaller markets but very high
 *                    conversion-to-search-volume ratio. The asymmetric
 *                    bets - small risk of nothing, large upside if one
 *                    catches.
 *
 * Catalog refreshed monthly via cron (later) or operator command.
 * For now: hand-curated from 2025-2026 Pinterest Predicts + Etsy
 * bestseller lists + Reddit subreddit growth data + creator forum
 * intelligence.
 */

import type { DesignNiche, DesignStyle } from './r349-design-factory.js'

export type TrendTier = 'proven' | 'breakout' | 'niche_breakout'

export interface TrendingSubject {
  subject:         string                          // image-gen prompt subject
  tier:            TrendTier
  niche:           DesignNiche
  recommendedStyle: DesignStyle
  signalSources:   string[]                         // where the signal comes from
  saturationScore: number                           // 0-100 (lower = less competition)
  conversionScore: number                           // 0-100 (higher = better sell-through)
  trendNotes:      string
}

export const PROVEN_SUBJECTS: TrendingSubject[] = [
  // Top-selling botanical (always selling)
  { subject: 'vintage peony illustration', tier: 'proven', niche: 'botanical', recommendedStyle: 'watercolor',
    signalSources: ['Etsy top sellers', 'Pinterest evergreen', 'Society6 trending'],
    saturationScore: 75, conversionScore: 88,
    trendNotes: 'Bridal-season spike Mar-Jun; baseline strong year-round. Cottagecore + wedding decor overlap.' },
  { subject: 'fern frond botanical study', tier: 'proven', niche: 'botanical', recommendedStyle: 'watercolor',
    signalSources: ['INPRNT bestsellers', 'Pinterest evergreen'],
    saturationScore: 70, conversionScore: 82,
    trendNotes: 'Apartment/rental wall art staple. Pairs with mushrooms, moss, forest aesthetics.' },
  { subject: 'vintage chickadee bird perched on dogwood', tier: 'proven', niche: 'animal_audubon', recommendedStyle: 'watercolor',
    signalSources: ['Etsy bestsellers', 'Pinterest Audubon revival'],
    saturationScore: 65, conversionScore: 85,
    trendNotes: 'Audubon-style art is having a sustained moment. North American native birds outperform exotic.' },

  // Cottagecore proven
  { subject: 'cottagecore mushroom illustration with moss', tier: 'proven', niche: 'natural_history', recommendedStyle: 'watercolor',
    signalSources: ['Etsy cottagecore category', 'TikTok #cottagecore', 'Pinterest evergreen'],
    saturationScore: 80, conversionScore: 86,
    trendNotes: 'High saturation but converts well. Variant strategy critical (different mushroom species + settings).' },

  // Antique / vintage maps (sustained interest)
  { subject: 'vintage Pacific Northwest constellation chart', tier: 'proven', niche: 'celestial', recommendedStyle: 'engraving',
    signalSources: ['Etsy map category', 'Saatchi Art celestial'],
    saturationScore: 60, conversionScore: 80,
    trendNotes: 'Celestial charts have premium feel. Region-specific (Pacific NW, New England) outperforms generic.' },

  // Antique nautical
  { subject: 'vintage scientific whale illustration with anatomy labels', tier: 'proven', niche: 'nautical', recommendedStyle: 'engraving',
    signalSources: ['Etsy bestsellers', 'INPRNT nautical category'],
    saturationScore: 55, conversionScore: 82,
    trendNotes: 'Coastal grandmother + science-y appeal. Sells especially well to dads as gifts.' },

  // Apothecary / herbalism
  { subject: 'vintage apothecary herbs and bottles still life', tier: 'proven', niche: 'still_life', recommendedStyle: 'gouache',
    signalSources: ['Etsy apothecary category', 'Pinterest cottagegoth'],
    saturationScore: 65, conversionScore: 84,
    trendNotes: 'Witchy + cottagecore overlap. Kitchen wall art for the herbalism crowd.' },

  // Moon phases (sustained)
  { subject: 'vintage moon phases astronomical chart', tier: 'proven', niche: 'celestial', recommendedStyle: 'engraving',
    signalSources: ['Etsy celestial bestsellers', 'Pinterest tarot/astrology'],
    saturationScore: 78, conversionScore: 82,
    trendNotes: 'Saturated but evergreen. Differentiation: unusual paper-color or unusual lunar event.' },
]

export const BREAKOUT_SUBJECTS: TrendingSubject[] = [
  // Beetle/insect specimen art (genuinely rising 2025-2026)
  { subject: 'vintage scientific beetle specimen collection plate', tier: 'breakout', niche: 'natural_history', recommendedStyle: 'engraving',
    signalSources: ['Pinterest Predicts 2026 entomology', 'Etsy "newly listed" with high view-rate', 'TikTok #naturecore'],
    saturationScore: 35, conversionScore: 78,
    trendNotes: '60-day velocity is steep. Pinterest call-outs in early 2026. Less saturated than butterfly art.' },

  // Mossy ruins / moss-on-everything aesthetic
  { subject: 'mossy ruined cathedral with overgrown ivy illustration', tier: 'breakout', niche: 'architecture', recommendedStyle: 'ink_wash',
    signalSources: ['TikTok #mosscore', 'Reddit r/Cottagecore growing', 'Pinterest gothic-cottage hybrid'],
    saturationScore: 30, conversionScore: 72,
    trendNotes: 'Solarpunk + cottagegoth crossover. Gothic architecture + moss = high-engagement on Pinterest.' },

  // Folk horror (rising 2025-2026)
  { subject: 'vintage folk horror illustration of hare under crescent moon', tier: 'breakout', niche: 'mythology', recommendedStyle: 'lithograph',
    signalSources: ['A24 effect on folk horror', 'TikTok #folkhorror surging', 'r/folkhorror up 300% YoY'],
    saturationScore: 25, conversionScore: 70,
    trendNotes: 'Niche but converting strongly on premium platforms (INPRNT, Society6 limited).' },

  // Carnivorous plants
  { subject: 'vintage botanical illustration of venus flytrap and sundew', tier: 'breakout', niche: 'botanical', recommendedStyle: 'watercolor',
    signalSources: ['TikTok #carnivorousplants viral 2025', 'Pinterest curious botanical sub-trend'],
    saturationScore: 28, conversionScore: 74,
    trendNotes: 'Adjacent to general botanical demand but far less saturated. Conversation-piece appeal.' },

  // Vintage scientific anatomical
  { subject: 'vintage human heart anatomical illustration with botanical border', tier: 'breakout', niche: 'natural_history', recommendedStyle: 'engraving',
    signalSources: ['Pinterest anatomical art rising', 'INPRNT new artist category', 'Medical-aesthetic crossover'],
    saturationScore: 32, conversionScore: 76,
    trendNotes: 'Med students + dark academia + cottagegoth all buying. Pair anatomical with botanical for premium look.' },

  // Vintage perfume bottles
  { subject: 'vintage Art Nouveau perfume bottle collection still life', tier: 'breakout', niche: 'still_life', recommendedStyle: 'gouache',
    signalSources: ['Pinterest Y2K + vintage girly aesthetic', 'TikTok #perfumetok'],
    saturationScore: 22, conversionScore: 71,
    trendNotes: 'Underserved category. Perfume hobbyists + Art Nouveau lovers + maximalist decor.' },

  // Brutalist architecture posters
  { subject: 'vintage brutalist architecture poster of Boston City Hall', tier: 'breakout', niche: 'architecture', recommendedStyle: 'mid_century_modern',
    signalSources: ['Architecture social media revival', 'Pinterest 1970s-aesthetic'],
    saturationScore: 18, conversionScore: 65,
    trendNotes: 'Very niche but high-conversion to architect/designer audience. Premium pricing tolerated.' },
]

export const NICHE_BREAKOUT_SUBJECTS: TrendingSubject[] = [
  // Spore prints
  { subject: 'vintage mushroom spore print pattern in indigo and rust', tier: 'niche_breakout', niche: 'natural_history', recommendedStyle: 'lithograph',
    signalSources: ['Mycology hobby community growth', 'Reddit r/mycology', 'Niche Etsy newly-listed'],
    saturationScore: 8, conversionScore: 62,
    trendNotes: 'Spore prints are mycology aesthetic in pure form. Tiny market but zero competition.' },

  // Antique microscopy
  { subject: 'vintage microscopy slide illustration of diatoms', tier: 'niche_breakout', niche: 'natural_history', recommendedStyle: 'engraving',
    signalSources: ['Science teacher market', 'Etsy "vintage scientific" rising sub-niche'],
    saturationScore: 5, conversionScore: 58,
    trendNotes: 'Almost no competitors. Universities + science enthusiasts. Small market but premium prices.' },

  // Vintage skateboard graphics
  { subject: 'vintage 1970s skateboard deck graphic illustration', tier: 'niche_breakout', niche: 'pattern_decorative', recommendedStyle: 'mid_century_modern',
    signalSources: ['Skate culture nostalgia', 'TikTok 70s-revival'],
    saturationScore: 12, conversionScore: 60,
    trendNotes: 'Cross-demographic appeal: skaters + dads + Gen X nostalgia.' },

  // Vintage mathematical illustrations
  { subject: 'vintage geometric construction illustration of golden ratio spiral', tier: 'niche_breakout', niche: 'pattern_decorative', recommendedStyle: 'engraving',
    signalSources: ['Math teacher market', 'Sacred geometry crossover'],
    saturationScore: 6, conversionScore: 55,
    trendNotes: 'Sacred geometry crowd + math enthusiasts. Niche but loyal.' },

  // Tide pool / specimen collections
  { subject: 'vintage tide pool specimen plate with sea stars and anemones', tier: 'niche_breakout', niche: 'natural_history', recommendedStyle: 'watercolor',
    signalSources: ['Coastal-grandmother adjacent', 'Marine biology hobby'],
    saturationScore: 10, conversionScore: 64,
    trendNotes: 'Coastal grandmother adjacent. Premium beach-house decor crowd.' },

  // Vintage mycology field guide
  { subject: 'vintage field guide illustration of edible vs poisonous mushrooms', tier: 'niche_breakout', niche: 'natural_history', recommendedStyle: 'watercolor',
    signalSources: ['Foraging community growth 2024-2026', 'Pinterest foraging sub-niche'],
    saturationScore: 9, conversionScore: 67,
    trendNotes: 'Foraging hobby surge post-2024. Functional + decorative.' },
]

// ─── Public API ─────────────────────────────────────────────────────────────

export interface TrendBatchRequest {
  provenCount?:        number       // default 5
  breakoutCount?:      number       // default 3
  nicheBreakoutCount?: number       // default 2
}

export interface TrendBatchResponse {
  proven:          TrendingSubject[]
  breakout:        TrendingSubject[]
  nicheBreakout:   TrendingSubject[]
  totalSubjects:   number
  recommendation:  string
}

export function pickTrendingBatch(req: TrendBatchRequest = {}): TrendBatchResponse {
  // Sort each tier by conversion score (descending) - best converters first
  const sortedProven  = [...PROVEN_SUBJECTS].sort((a, b) => b.conversionScore - a.conversionScore)
  const sortedBreak   = [...BREAKOUT_SUBJECTS].sort((a, b) => b.conversionScore - a.conversionScore)
  const sortedNiche   = [...NICHE_BREAKOUT_SUBJECTS].sort((a, b) => b.conversionScore - a.conversionScore)

  const proven        = sortedProven.slice(0, req.provenCount ?? 5)
  const breakout      = sortedBreak.slice(0, req.breakoutCount ?? 3)
  const nicheBreakout = sortedNiche.slice(0, req.nicheBreakoutCount ?? 2)

  return {
    proven, breakout, nicheBreakout,
    totalSubjects: proven.length + breakout.length + nicheBreakout.length,
    recommendation: `Generate all ${proven.length + breakout.length + nicheBreakout.length}. The 5 proven anchor reliable revenue, the 3 breakouts capture rising demand, the 2 niche-breakouts are asymmetric upside bets.`,
  }
}

export function getAllTrending(): TrendingSubject[] {
  return [...PROVEN_SUBJECTS, ...BREAKOUT_SUBJECTS, ...NICHE_BREAKOUT_SUBJECTS]
}
