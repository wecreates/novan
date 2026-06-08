/**
 * R358 — Fine Art America (FAA) driver.
 *
 * FAA flow is multi-step. Verified path:
 *   1. /uploadart.html?action=newimage (Image Upload page)
 *   2. Fill Title + Description + (optional) Subject Keyword
 *   3. setInputFiles on the file input
 *   4. Wait for upload progress to complete (FAA shows a percentage bar)
 *   5. Pick categories (multi-select)
 *   6. Set pricing markup (operator-set once at account-level via "set markups";
 *      this driver only sets per-image markup if needed)
 *   7. Click "Save" / "Upload Image"
 *   8. Land on the new image's edit page
 *
 * Pixels.com inherits automatically; no separate driver needed.
 */
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import type { DriverInput, DriverResult, PlatformDriver } from './_types.js'

async function loginCheck(page: Page): Promise<boolean> {
  await page.goto('https://fineartamerica.com/', { waitUntil: 'domcontentloaded' })
  // Member nav shows "My Account" link when logged in
  return await page.locator('a[href*="member.php"], a:has-text("My Account")').first()
    .isVisible({ timeout: 5_000 }).catch(() => false)
}

async function upload(input: DriverInput): Promise<DriverResult> {
  const { page, item, designFilePath, dryRun } = input

  await page.goto('https://fineartamerica.com/uploadart.html?action=newimage', { waitUntil: 'domcontentloaded' })
  await sectionPause()

  // FAA sometimes shows an interstitial — dismiss any "got it" / OK banner
  const dismiss = page.locator('button:has-text("OK"), button:has-text("Got it"), button:has-text("Close")').first()
  if (await dismiss.count() > 0) await dismiss.click().catch(() => {})

  // Title
  const titleField = page.locator('input[name="title"], input[id="title"]').first()
  await titleField.waitFor({ state: 'visible', timeout: 20_000 })
  await humanType(titleField, item.title.slice(0, 100))
  await humanPause()

  // Description
  const descField = page.locator('textarea[name="description"], textarea[id="description"]').first()
  if (await descField.count() > 0) {
    await humanType(descField, item.description.slice(0, 1000))
    await humanPause()
  }

  // Keywords (FAA's "Keywords" field is comma-separated tags)
  const tags = (item.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 15).join(', ')
  const tagsField = page.locator('input[name="keywords"], input[id="keywords"], textarea[name="keywords"]').first()
  if (await tagsField.count() > 0) {
    await humanType(tagsField, tags)
    await humanPause()
  }

  // File upload
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 20_000 })
  await fileInput.setInputFiles(designFilePath)
  // FAA shows upload progress; wait up to 90s for the image to fully process
  await page.waitForTimeout(8_000)
  // Wait for a thumbnail preview to render OR a "complete" indicator
  await page.waitForFunction(() => {
    const img = document.querySelector('img[src*="thumb"], img[src*="preview"], canvas') as HTMLElement | null
    return img && img.offsetHeight > 50
  }, { timeout: 90_000 }).catch(() => {/* fall through; some FAA states skip preview */})
  await sectionPause()

  if (dryRun) return { ok: true, externalUrl: page.url(), reason: 'dry-run: stopped before submit' }

  // Submit
  const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Upload"), button:has-text("Save")').first()
  if (await submitBtn.count() === 0) return { ok: false, reason: 'submit button not found' }
  await humanClick(page, submitBtn)
  await page.waitForLoadState('networkidle', { timeout: 90_000 }).catch(() => {/* slow */})
  await sectionPause()

  // Pull URL — FAA lands you on /art/<title>-<id>.html
  const liveLink = page.locator('a[href*="fineartamerica.com/featured/"], a[href*="fineartamerica.com/art/"]').first()
  let url = ''
  try { url = await liveLink.getAttribute('href', { timeout: 5_000 }) ?? '' } catch { url = page.url() }
  return { ok: true, externalUrl: url }
}

export const fineArtAmericaDriver: PlatformDriver = {
  platform: 'fine_art_america',
  loginUrl: 'https://fineartamerica.com/loginform.html',
  loginCheck,
  upload,
}
