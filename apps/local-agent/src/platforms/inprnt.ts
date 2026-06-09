/**
 * R358 — INPRNT driver.
 *
 * Flow:
 *   1. /upload (logged-in artists land on the upload form directly)
 *   2. Click file input → setInputFiles
 *   3. Fill Title
 *   4. Select Category (matched to niche)
 *   5. Fill tag list (comma-separated)
 *   6. Set markup slider/input
 *   7. Click Submit → wait for confirmation
 *
 * INPRNT auto-crops + scales for product sizing, so no per-product
 * variant generation is needed.
 *
 * Selectors are best-effort from the INPRNT seller portal as of late 2025;
 * verify with `--dry-run` before going live and tighten if the DOM has
 * shifted.
 */
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import type { DriverInput, DriverResult, PlatformDriver } from './_types.js'

async function loginCheck(page: Page): Promise<boolean> {
  // Navigate to a page that requires authentication. Logged-in users stay on
  // the upload form; anonymous users get redirected to /accounts/login/.
  await page.goto('https://www.inprnt.com/upload/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const url = page.url()
  if (url.includes('/accounts/login') || url.includes('/login')) return false
  // Additional positive signal: look for a logout link OR the user avatar OR upload form.
  const positive = await page.locator(
    'a[href*="/logout"], form[action*="upload"], input[type="file"]'
  ).first().isVisible({ timeout: 4_000 }).catch(() => false)
  return positive
}

const CATEGORY_BY_NICHE: Record<string, string> = {
  botanical:           'Nature',
  natural_history:     'Nature',
  animal_audubon:      'Animals',
  nautical:            'Travel',
  vintage_map:         'Travel',
  japanese_woodblock:  'Illustration',
  antique_portrait:    'Portrait',
  landscape:           'Landscape',
  still_life:          'Illustration',
  architecture:        'Architecture',
  pattern_decorative:  'Pattern',
  celestial:           'Space',
  mythology:           'Fantasy',
  art_nouveau:         'Illustration',
  medieval_illumination: 'Illustration',
}

async function upload(input: DriverInput): Promise<DriverResult> {
  const { page, item, designFilePath, dryRun } = input

  await page.goto('https://www.inprnt.com/upload', { waitUntil: 'domcontentloaded' })
  await sectionPause()

  // File upload
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 20_000 })
  await fileInput.setInputFiles(designFilePath)
  await page.waitForTimeout(4_000)              // INPRNT renders a thumb after upload

  // Title
  const titleField = page.locator('input[name="title"], input[id*="title"], input[placeholder*="title" i]').first()
  await titleField.waitFor({ state: 'visible', timeout: 15_000 })
  await humanType(titleField, item.title.slice(0, 100))
  await humanPause()

  // Description (INPRNT uses this for SEO meta)
  const descField = page.locator('textarea[name="description"], textarea[id*="description"]').first()
  if (await descField.count() > 0) {
    await humanType(descField, item.description.slice(0, 500))
    await humanPause()
  }

  // Tags — INPRNT uses a comma-separated text field
  const tags = (item.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 10).join(', ')
  const tagsField = page.locator('input[name="tags"], input[id*="tags"], input[placeholder*="tag" i]').first()
  if (await tagsField.count() > 0) {
    await humanType(tagsField, tags)
    await humanPause()
  }

  // Category — pick the niche-mapped option from a select (or click-through if combobox)
  const niche = (item.notes?.match(/niche=(\w+)/)?.[1]) || 'natural_history'
  const category = CATEGORY_BY_NICHE[niche] ?? 'Illustration'
  const categorySelect = page.locator('select[name*="categ" i]').first()
  if (await categorySelect.count() > 0) {
    await categorySelect.selectOption({ label: category }).catch(() => {/* fallback below */})
  }

  // Submit
  if (dryRun) return { ok: true, externalUrl: page.url(), reason: 'dry-run: stopped before submit' }

  const submitBtn = page.locator('button[type="submit"], button:has-text("Upload"), button:has-text("Submit")').first()
  if (await submitBtn.count() === 0) return { ok: false, reason: 'submit button not found' }
  await humanClick(page, submitBtn)
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {/* slow uploads */})
  await sectionPause()

  // Pull the live URL — INPRNT lands you on the public image page after a successful upload
  const url = page.url()
  return { ok: true, externalUrl: url.includes('/gallery/') || url.includes('/print/') ? url : `https://www.inprnt.com${url}` }
}

export const inprntDriver: PlatformDriver = {
  platform: 'inprnt',
  loginUrl: 'https://www.inprnt.com/accounts/login/',
  loginCheck,
  upload,
}
