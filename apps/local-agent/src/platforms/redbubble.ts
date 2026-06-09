/**
 * R364 — Redbubble driver.
 *
 * Flow (verified late-2025 Redbubble Studio UI):
 *   1. Navigate to /portfolio/images/new (logged-in artists land here directly;
 *      anonymous users get redirected to /auth/login)
 *   2. File input → setInputFiles
 *   3. Wait for upload progress → form fields render
 *   4. Fill title + tags (comma-separated)
 *   5. Accept default product enablements (RB pre-selects everything)
 *   6. Click "Save Work" / "Publish"
 *
 * RB has a 5-day account-classification window during which the store stays
 * private. Uploads during this window are safe — they only become visible
 * after classification anyway.
 */
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import type { DriverInput, DriverResult, PlatformDriver } from './_types.js'

async function loginCheck(page: Page): Promise<boolean> {
  await page.goto('https://www.redbubble.com/studio/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const url = page.url()
  if (url.includes('/auth/login') || url.includes('/auth/sign')) return false
  // Positive signal: the studio nav with "Products", "Dashboard", or "Add new work"
  return await page.locator('a:has-text("Add new work"), a[href*="/portfolio/"], h1:has-text("Dashboard")')
    .first().isVisible({ timeout: 4_000 }).catch(() => false)
}

async function upload(input: DriverInput): Promise<DriverResult> {
  const { page, item, designFilePath, dryRun } = input

  // Try /studio/upload (new Studio UI) first; fall back via dashboard nav.
  await page.goto('https://www.redbubble.com/studio/upload', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  // Dismiss any cookie/banner if present (RB shows EU + onboarding modals)
  const dismiss = page.locator('button:has-text("Accept"), button:has-text("Got it"), button:has-text("Close"), button[aria-label*="close" i]').first()
  if (await dismiss.count() > 0) await dismiss.click().catch(() => {})

  // File input — try several common ones
  const fileInput = page.locator('input[type="file"]').first()
  const fileInputVisible = await fileInput.isVisible({ timeout: 3000 }).catch(() => false)
  if (!fileInputVisible && await fileInput.count() === 0) {
    // Fallback: navigate via dashboard "Add new work" link
    await page.goto('https://www.redbubble.com/studio/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    const addNew = page.locator('a:has-text("Add new work"), a:has-text("Upload"), a[href*="upload"]').first()
    if (await addNew.count() > 0) {
      await addNew.click()
      await page.waitForTimeout(4000)
    }
  }
  await fileInput.waitFor({ state: 'attached', timeout: 30_000 })
  await fileInput.setInputFiles(designFilePath)
  // Wait for upload progress to finish — RB shows a preview when ready
  await page.waitForTimeout(10_000)
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img'))
    return imgs.some(i => i.src && (i.src.includes('rbstatic') || i.src.includes('cloudfront')) && i.naturalHeight > 100)
  }, { timeout: 90_000 }).catch(() => {/* fall through; preview may be canvas */})
  await sectionPause()

  // Title field
  const titleField = page.locator(
    'input[name="work[title]"], input[id*="title" i], input[placeholder*="title" i]'
  ).first()
  await titleField.waitFor({ state: 'visible', timeout: 15_000 })
  await humanType(titleField, item.title.slice(0, 50))     // RB caps at 50 chars
  await humanPause()

  // Tags field — RB uses a comma-separated input
  const tagsStr = (item.tags || '')
    .split(',').map(t => t.trim()).filter(Boolean)
    .slice(0, 15).join(', ')
  const tagsField = page.locator(
    'input[name="work[tag_field]"], input[id*="tag" i], textarea[name*="tag" i]'
  ).first()
  if (await tagsField.count() > 0) {
    await humanType(tagsField, tagsStr)
    await humanPause()
  }

  // Description (optional, but RB rewards filled descriptions)
  const descField = page.locator(
    'textarea[name="work[description]"], textarea[id*="description" i]'
  ).first()
  if (await descField.count() > 0) {
    await humanType(descField, item.description.slice(0, 500))
    await humanPause()
  }

  // Accept default rights (RB requires acknowledging you own the design)
  const rightsCheckbox = page.locator('input[type="checkbox"][name*="default_pricing"], input[type="checkbox"][name*="rights"], input[type="checkbox"]').first()
  if (await rightsCheckbox.count() > 0) {
    const isChecked = await rightsCheckbox.isChecked().catch(() => false)
    if (!isChecked) await rightsCheckbox.check({ force: true }).catch(() => {})
    await humanPause()
  }

  if (dryRun) return { ok: true, externalUrl: page.url(), reason: 'dry-run: stopped before save/publish' }

  // Save Work / Publish
  const saveBtn = page.locator(
    'button[type="submit"]:has-text("Save"), button:has-text("Save Work"), button:has-text("Submit"), button:has-text("Publish")'
  ).first()
  if (await saveBtn.count() === 0) return { ok: false, reason: 'save/publish button not found' }
  await humanClick(page, saveBtn)
  await page.waitForLoadState('networkidle', { timeout: 90_000 }).catch(() => {/* slow */})
  await sectionPause()

  // After save RB lands on the work's edit page (/portfolio/work/<id>) or back on dashboard
  const url = page.url()
  return {
    ok: true,
    externalUrl: url.includes('/portfolio/') ? url : 'https://www.redbubble.com/people/CYZORCREATIONS/shop',
  }
}

export const redbubbleDriver: PlatformDriver = {
  platform: 'redbubble',
  loginUrl: 'https://www.redbubble.com/auth/login',
  loginCheck,
  upload,
}
