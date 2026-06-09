/**
 * R361 — INPRNT driver, portfolio-application mode.
 *
 * Operator clarified: INPRNT does NOT block uploads pending approval — the
 * approval gate IS the portfolio application page itself. Until 5 portfolio
 * images are uploaded and the application submitted, the regular /upload/
 * route is unavailable.
 *
 * Flow:
 *   1. Navigate to /application/ (logged-in required)
 *   2. Fill bio + social links (if requested)
 *   3. Upload 5 portfolio images via the file input
 *   4. Submit for community-vote review
 *
 * The driver's upload() processes ONE queue item per call, accumulating
 * portfolio uploads via a memory cache. When 5 are accumulated, it submits
 * the application and marks all 5 queue items as uploaded together.
 *
 * Once approved (3-14 days, manual operator check), swap this driver back to
 * the post-approval /sell/{shop}/upload/ flow.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import type { DriverInput, DriverResult, PlatformDriver } from './_types.js'

const PORTFOLIO_TARGET = 5
const PORTFOLIO_STATE_FILE = '.profile/inprnt-portfolio.json'

interface PortfolioState {
  collectedDesignIds: string[]
  collectedFiles:     string[]
  submitted:          boolean
  submittedAt?:       number
  applicationUrl?:    string
}

async function loadState(): Promise<PortfolioState> {
  try {
    const raw = await fs.readFile(PORTFOLIO_STATE_FILE, 'utf8')
    return JSON.parse(raw) as PortfolioState
  } catch {
    return { collectedDesignIds: [], collectedFiles: [], submitted: false }
  }
}
async function saveState(s: PortfolioState): Promise<void> {
  await fs.mkdir(path.dirname(PORTFOLIO_STATE_FILE), { recursive: true })
  await fs.writeFile(PORTFOLIO_STATE_FILE, JSON.stringify(s, null, 2))
}

async function loginCheck(page: Page): Promise<boolean> {
  // Navigate to the application page. Logged-out users get redirected.
  await page.goto('https://www.inprnt.com/application/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const url = page.url()
  if (url.includes('/accounts/login') || url.includes('/login')) return false
  // Application page or shop-already-open page = logged in.
  return true
}

async function upload(input: DriverInput): Promise<DriverResult> {
  const { page, item, designFilePath, dryRun } = input
  const state = await loadState()

  // If already submitted, refuse: the operator needs to manually move past
  // the review stage; auto-resubmitting would look like spam.
  if (state.submitted) {
    return {
      ok: false,
      reason: `INPRNT application already submitted at ${state.submittedAt ? new Date(state.submittedAt).toISOString() : '?'}. Wait for review (3-14 days) before more uploads.`,
    }
  }

  // Accumulate this design into the portfolio (no submission yet)
  if (!state.collectedDesignIds.includes(item.designId)) {
    state.collectedDesignIds.push(item.designId)
    state.collectedFiles.push(designFilePath)
    await saveState(state)
  }

  const haveAll = state.collectedDesignIds.length >= PORTFOLIO_TARGET
  if (!haveAll) {
    const remaining = PORTFOLIO_TARGET - state.collectedDesignIds.length
    return {
      ok: true,
      externalUrl: 'PENDING_PORTFOLIO_ACCUMULATION',
      reason: `Accumulated ${state.collectedDesignIds.length}/${PORTFOLIO_TARGET} portfolio designs. Need ${remaining} more before submission.`,
    }
  }

  // We have 5. Drive the application page.
  await page.goto('https://www.inprnt.com/application/', { waitUntil: 'domcontentloaded' })
  await sectionPause()

  // Fill bio if there's a bio field (it's optional on most renderings)
  const bioField = page.locator('textarea[name*="bio" i], textarea[id*="bio" i]').first()
  if (await bioField.count() > 0) {
    const bio = 'Original artwork by Chris Spangler / CYZOR CREATIONS. Botanical, natural-history, vintage-scientific, and cottagecore illustrations. Each print is hand-finished. Made for collectors who like books, gardens, and quiet rooms.'
    await humanType(bioField, bio)
    await humanPause()
  }

  // Find the portfolio file input(s). INPRNT may use one multi-upload input
  // or multiple single-file inputs. Try multi first.
  const multiInput = page.locator('input[type="file"][multiple]').first()
  if (await multiInput.count() > 0) {
    await multiInput.setInputFiles(state.collectedFiles)
    await page.waitForTimeout(8_000)         // wait for INPRNT thumbnail processing
  } else {
    // Fall back to N single inputs
    const singleInputs = page.locator('input[type="file"]')
    const count = await singleInputs.count()
    for (let i = 0; i < Math.min(count, state.collectedFiles.length); i++) {
      const file = state.collectedFiles[i]!
      await singleInputs.nth(i).setInputFiles(file)
      await page.waitForTimeout(2000)
    }
  }
  await sectionPause()

  if (dryRun) {
    return {
      ok: true,
      externalUrl: page.url(),
      reason: 'dry-run: portfolio loaded onto application page, did NOT submit',
    }
  }

  // Submit
  const submitBtn = page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Apply")').first()
  if (await submitBtn.count() === 0) {
    return { ok: false, reason: 'submit button not found on application page' }
  }
  await humanClick(page, submitBtn)
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {/* slow */})
  await sectionPause()

  // Persist submission state so we don't re-submit
  state.submitted     = true
  state.submittedAt   = Date.now()
  state.applicationUrl = page.url()
  await saveState(state)

  return {
    ok: true,
    externalUrl: page.url(),
    reason: `Submitted INPRNT portfolio application with ${state.collectedDesignIds.length} designs. Review takes 3-14 days.`,
  }
}

export const inprntDriver: PlatformDriver = {
  platform: 'inprnt',
  loginUrl: 'https://www.inprnt.com/accounts/login/',
  loginCheck,
  upload,
}
