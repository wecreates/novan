/**
 * R357 — Platform driver registry.
 *
 * Drivers ship one at a time. Each new platform = one file in this directory
 * + one entry in DRIVERS. Stubs return ok:false so they get re-queued without
 * crashing the loop.
 */
import { gumroadDriver } from './gumroad.js'
import { inprntDriver } from './inprnt.js'
import { fineArtAmericaDriver } from './fine_art_america.js'
import type { PlatformDriver, DriverResult } from './_types.js'

function stub(platform: string, loginUrl: string): PlatformDriver {
  return {
    platform,
    loginUrl,
    loginCheck: async () => false,
    upload:     async (): Promise<DriverResult> => ({ ok: false, reason: `R357: ${platform} driver not yet implemented` }),
  }
}

export const DRIVERS: Record<string, PlatformDriver> = {
  gumroad:           gumroadDriver,
  inprnt:            inprntDriver,
  fine_art_america:  fineArtAmericaDriver,
  redbubble:         stub('redbubble',        'https://www.redbubble.com/auth/login'),
  etsy:              stub('etsy',             'https://www.etsy.com/signin'),
  zazzle:            stub('zazzle',           'https://www.zazzle.com/auth/login'),
  spreadshirt:       stub('spreadshirt',      'https://partner.spreadshirt.net/'),
  teepublic:         stub('teepublic',        'https://www.teepublic.com/login'),
  tiktok_shop:       stub('tiktok_shop',      'https://seller-us.tiktok.com/'),
  displate:          stub('displate',         'https://displate.com/auth/signin'),
  threadless:        stub('threadless',       'https://www.threadless.com/login'),
}

export function getDriver(platform: string): PlatformDriver | undefined {
  return DRIVERS[platform]
}
