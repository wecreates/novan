/**
 * R357/R371 — Platform driver registry.
 *
 * Three tiers of drivers:
 *   1. Hand-written (full upload flow): gumroad, inprnt, fine_art_america, redbubble, pinterest
 *   2. Generic + self-improving (R371): etsy, zazzle, spreadshirt, teepublic, tiktok_shop, displate, threadless
 *      → uses resilientLocate per step, learns selectors per platform over time
 *   3. Stub (return ok:false): anything we haven't onboarded yet
 */
import { gumroadDriver } from './gumroad.js'
import { inprntDriver } from './inprnt.js'
import { fineArtAmericaDriver } from './fine_art_america.js'
import { redbubbleDriver } from './redbubble.js'
import { genericDriver, GENERIC_SPECS } from './generic.js'
import { loadConfig } from '../config.js'
import type { PlatformDriver, DriverResult } from './_types.js'

function stub(platform: string, loginUrl: string): PlatformDriver {
  return {
    platform,
    loginUrl,
    loginCheck: async () => false,
    upload:     async (): Promise<DriverResult> => ({ ok: false, reason: `R357: ${platform} driver not yet implemented` }),
  }
}

// Generic+self-improving drivers — config is loaded lazily per call so
// env reloads work between runs.
let cachedCfg: ReturnType<typeof loadConfig> | null = null
const getCfg = () => cachedCfg ??= loadConfig()

export const DRIVERS: Record<string, PlatformDriver> = {
  gumroad:           gumroadDriver,
  inprnt:            inprntDriver,
  fine_art_america:  fineArtAmericaDriver,
  redbubble:         redbubbleDriver,
  // R371 — self-improving generic drivers
  etsy:              genericDriver(GENERIC_SPECS['etsy']!,         getCfg),
  zazzle:            genericDriver(GENERIC_SPECS['zazzle']!,       getCfg),
  spreadshirt:       genericDriver(GENERIC_SPECS['spreadshirt']!,  getCfg),
  teepublic:         genericDriver(GENERIC_SPECS['teepublic']!,    getCfg),
  tiktok_shop:       genericDriver(GENERIC_SPECS['tiktok_shop']!,  getCfg),
  displate:          genericDriver(GENERIC_SPECS['displate']!,     getCfg),
  threadless:        genericDriver(GENERIC_SPECS['threadless']!,   getCfg),
}

export function getDriver(platform: string): PlatformDriver | undefined {
  return DRIVERS[platform]
}
