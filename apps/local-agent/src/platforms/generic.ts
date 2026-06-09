/**
 * R371 — Generic upload driver.
 *
 * Works on ANY platform's upload page by discovering selectors via
 * resilientLocate (R366 self-improving framework). For each abstract field
 * (file_input, title, description, tags, submit), tries the driver's best
 * guess → stored selectors from past runs → LLM-suggested selectors.
 *
 * Wired into the stub platforms so they go from "not implemented" to
 * "first-pass-functional" the moment the agent runs against them.
 *
 * The platform-specific knowledge that remains hard-coded:
 *   - loginUrl  : where to send the operator for login
 *   - uploadUrl : where the upload form lives
 *   - submitNav : whether the platform navigates away or stays after submit
 */
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import { resilientLocate } from '../selector-improver.js'
import type { DriverInput, DriverResult, PlatformDriver } from './_types.js'
import type { AgentConfig } from '../config.js'

export interface GenericPlatformSpec {
  platform:   string
  loginUrl:   string
  uploadUrl:  string                      // where the new-item form lives
  homeUrl?:   string                      // where to navigate for loginCheck
  successUrlPattern?: RegExp              // what URL means upload succeeded
}

function buildLoginCheck(spec: GenericPlatformSpec) {
  return async function loginCheck(page: Page): Promise<boolean> {
    const target = spec.homeUrl ?? spec.uploadUrl
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const url = page.url()
    if (url.includes('/login') || url.includes('/signin') || url.includes('/auth')) return false
    // Positive signal: anything that's not a login form should mean logged in
    const loginForm = await page.locator('input[type="password"], form[action*="login" i]').first()
      .isVisible({ timeout: 2000 }).catch(() => false)
    return !loginForm
  }
}

function buildUpload(spec: GenericPlatformSpec, cfg: () => AgentConfig) {
  return async function upload(input: DriverInput): Promise<DriverResult> {
    const { page, item, designFilePath, dryRun } = input
    const c = cfg()

    await page.goto(spec.uploadUrl, { waitUntil: 'domcontentloaded' })
    await sectionPause()

    // 1. File input
    const fileLoc = await resilientLocate({
      cfg: c, page, platform: spec.platform, step: 'find_file_input',
      fallback: 'input[type="file"]',
      timeoutMs: 10_000,
    })
    if (!fileLoc) return { ok: false, reason: 'file input not found after improver suggestions' }
    try { await fileLoc.setInputFiles(designFilePath) }
    catch (e) { return { ok: false, reason: `setInputFiles failed: ${(e as Error).message}` } }
    await page.waitForTimeout(8_000)
    await sectionPause()

    // 2. Title
    const titleLoc = await resilientLocate({
      cfg: c, page, platform: spec.platform, step: 'fill_title',
      fallback: 'input[name*="title" i], input[id*="title" i], input[placeholder*="title" i]',
      visible: true, timeoutMs: 8_000,
    })
    if (titleLoc) { await humanType(titleLoc, item.title.slice(0, 100)); await humanPause() }

    // 3. Description
    const descLoc = await resilientLocate({
      cfg: c, page, platform: spec.platform, step: 'fill_description',
      fallback: 'textarea[name*="description" i], textarea[id*="description" i]',
      visible: true, timeoutMs: 5_000,
    })
    if (descLoc) { await humanType(descLoc, item.description.slice(0, 500)); await humanPause() }

    // 4. Tags / keywords
    const tagsStr = (item.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 15).join(', ')
    if (tagsStr) {
      const tagsLoc = await resilientLocate({
        cfg: c, page, platform: spec.platform, step: 'fill_tags',
        fallback: 'input[name*="tag" i], input[name*="keyword" i], textarea[name*="tag" i], input[placeholder*="tag" i]',
        visible: true, timeoutMs: 5_000,
      })
      if (tagsLoc) { await humanType(tagsLoc, tagsStr); await humanPause() }
    }

    if (dryRun) return { ok: true, externalUrl: page.url(), reason: 'dry-run: stopped before submit' }

    // 5. Submit
    const submitLoc = await resilientLocate({
      cfg: c, page, platform: spec.platform, step: 'click_submit',
      fallback: 'button[type="submit"], button:has-text("Publish"), button:has-text("Save"), button:has-text("Upload"), input[type="submit"]',
      visible: true, timeoutMs: 8_000,
    })
    if (!submitLoc) return { ok: false, reason: 'submit button not found' }
    await humanClick(page, submitLoc)
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {/* slow */})
    await sectionPause()

    const url = page.url()
    if (spec.successUrlPattern && !spec.successUrlPattern.test(url)) {
      return { ok: false, reason: `post-submit URL ${url} does not match success pattern` }
    }
    return { ok: true, externalUrl: url }
  }
}

export function genericDriver(spec: GenericPlatformSpec, getCfg: () => AgentConfig): PlatformDriver {
  return {
    platform:   spec.platform,
    loginUrl:   spec.loginUrl,
    loginCheck: buildLoginCheck(spec),
    upload:     buildUpload(spec, getCfg),
  }
}

/** Platform specs — what the generic driver needs to operate on each site. */
export const GENERIC_SPECS: Record<string, GenericPlatformSpec> = {
  etsy: {
    platform:  'etsy',
    loginUrl:  'https://www.etsy.com/signin',
    homeUrl:   'https://www.etsy.com/your/shops/me/dashboard',
    uploadUrl: 'https://www.etsy.com/your/shops/me/tools/listings/new',
    successUrlPattern: /\/your\/shops\/me\/(tools\/listings|listings)/,
  },
  zazzle: {
    platform:  'zazzle',
    loginUrl:  'https://www.zazzle.com/auth/login',
    homeUrl:   'https://www.zazzle.com/my/store',
    uploadUrl: 'https://www.zazzle.com/api/create/product',
  },
  spreadshirt: {
    platform:  'spreadshirt',
    loginUrl:  'https://partner.spreadshirt.net/',
    homeUrl:   'https://partner.spreadshirt.net/Designs/',
    uploadUrl: 'https://partner.spreadshirt.net/Designs/Upload',
  },
  teepublic: {
    platform:  'teepublic',
    loginUrl:  'https://www.teepublic.com/login',
    homeUrl:   'https://www.teepublic.com/dashboard',
    uploadUrl: 'https://www.teepublic.com/upload',
  },
  tiktok_shop: {
    platform:  'tiktok_shop',
    loginUrl:  'https://seller-us.tiktok.com/',
    homeUrl:   'https://seller-us.tiktok.com/homepage',
    uploadUrl: 'https://seller-us.tiktok.com/product/create',
  },
  displate: {
    platform:  'displate',
    loginUrl:  'https://displate.com/auth/signin',
    homeUrl:   'https://displate.com/artist/dashboard',
    uploadUrl: 'https://displate.com/artist/dashboard/upload',
  },
  threadless: {
    platform:  'threadless',
    loginUrl:  'https://www.threadless.com/login',
    homeUrl:   'https://artist-shops.threadless.com/',
    uploadUrl: 'https://artist-shops.threadless.com/products/new',
  },
}
