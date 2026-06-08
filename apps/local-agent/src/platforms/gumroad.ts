/**
 * R357 — Gumroad driver.
 *
 * Captures the manual flow Claude drove in R356 via Chrome MCP:
 * 1. Navigate to /products/new
 * 2. Fill Name
 * 3. Pick "Digital product" (preselected)
 * 4. Fill Price
 * 5. Click "Next: Customize" → lands on /products/{slug}/edit
 * 6. Fill Description
 * 7. Customize URL slug
 * 8. Upload Thumbnail (file input)
 * 9. Add version → upload Download file
 * 10. Click Save changes (top right)
 * 11. Toggle product to Published
 *
 * Cookies persist via the user-data-dir profile in index.ts.
 */
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import type { DriverInput, DriverResult, PlatformDriver } from './_types.js'

async function loginCheck(page: Page): Promise<boolean> {
  await page.goto('https://app.gumroad.com/', { waitUntil: 'domcontentloaded' })
  // Logged-in nav has Products / Home / Payouts links in sidebar
  const sidebar = page.locator('text=Products').first()
  return await sidebar.isVisible({ timeout: 5_000 }).catch(() => false)
}

async function upload(input: DriverInput): Promise<DriverResult> {
  const { page, item, designFilePath, dryRun } = input

  // ── Step 1: Create the product shell ────────────────────────────────────
  await page.goto('https://app.gumroad.com/products/new', { waitUntil: 'domcontentloaded' })
  await sectionPause()

  // Name
  const nameInput = page.getByLabel(/^name$/i).first()
  await nameInput.waitFor({ state: 'visible', timeout: 15_000 })
  await humanType(nameInput, item.title)
  await humanPause()

  // Digital product card (preselected by default; click anyway to be safe)
  const digital = page.getByText(/Digital product/i).first()
  await humanClick(page, digital)
  await humanPause()

  // Price
  const priceInput = page.getByLabel(/^price$/i).first()
  await humanType(priceInput, String(item.priceUsd ?? 9))
  await humanPause()

  // Next: Customize
  const nextBtn = page.getByRole('button', { name: /Next:?\s*Customize/i })
  await humanClick(page, nextBtn)
  await page.waitForURL(/\/products\/.+\/edit/, { timeout: 30_000 })
  await sectionPause()

  // ── Step 2: Edit page — description, slug, files ───────────────────────
  // Description (rich-text)
  const descEditable = page.locator('[contenteditable="true"]').first()
  await descEditable.waitFor({ state: 'visible', timeout: 15_000 })
  await descEditable.click()
  await humanPause()
  // Strip leading '**' bold markers from R349 template; the rich editor doesn't render markdown
  const descPlain = item.description.replace(/\*\*/g, '').replace(/\\n/g, '\n')
  await page.keyboard.type(descPlain, { delay: 8 })
  await humanPause()

  // URL slug
  const slug = makeSlug(item.title)
  const slugInputs = page.locator('input[type="text"]').filter({ hasText: '' })
  // Find the slug field by looking for a text input whose value matches the auto-generated 6-char id
  const slugInput = page.locator('input[type="text"]').filter({ has: page.locator(':scope') }).nth(2)
  // Fallback: look for an input near the "URL" / "cyzorcreations.gumroad.com/l/" label
  // Use a robust approach: find input near the URL hint text
  try {
    const slugFieldByPlaceholder = page.locator('input[placeholder*="url"i], input[name*="url"i]').first()
    if (await slugFieldByPlaceholder.count() > 0) {
      await slugFieldByPlaceholder.fill('')
      await humanType(slugFieldByPlaceholder, slug)
    } else {
      // Last resort: find input next to /l/ text node
      const slugByLabel = page.locator('xpath=//*[contains(text(),"/l/")]/following::input[1]')
      if (await slugByLabel.count() > 0) {
        await slugByLabel.fill('')
        await humanType(slugByLabel, slug)
      }
    }
  } catch { /* non-fatal */ }
  void slugInputs
  void slugInput
  await humanPause()

  // Thumbnail upload
  const thumbInput = page.locator('input[type="file"]').first()
  await thumbInput.setInputFiles(designFilePath)
  await sectionPause()                       // wait for upload to register

  // "Add version" — adds a downloadable file row, then a file input appears
  const addVersionBtn = page.getByRole('button', { name: /Add version/i })
  if (await addVersionBtn.count() > 0) {
    await humanClick(page, addVersionBtn)
    await humanPause()
    // Find the newly added file input (Gumroad shows a "Choose file" link)
    const versionFile = page.locator('input[type="file"]').nth(1)
    if (await versionFile.count() > 0) {
      await versionFile.setInputFiles(designFilePath)
      await sectionPause()
    }
  }

  // Save changes
  const saveBtn = page.getByRole('button', { name: /Save changes/i }).first()
  if (await saveBtn.count() > 0) {
    await humanClick(page, saveBtn)
    await humanPause()
  }

  if (dryRun) {
    return { ok: true, externalUrl: page.url(), reason: 'dry-run: stopped before publish' }
  }

  // Publish toggle — Gumroad shows a "Publish" button on draft products
  const publishBtn = page.getByRole('button', { name: /^Publish$/i }).first()
  if (await publishBtn.count() > 0) {
    await humanClick(page, publishBtn)
    await page.waitForTimeout(3000)
  }

  // Read final public URL from page
  const liveLink = page.locator('a[href*="gumroad.com/l/"]').first()
  let externalUrl = ''
  try {
    externalUrl = await liveLink.getAttribute('href', { timeout: 5_000 }) ?? ''
  } catch {
    externalUrl = `https://cyzorcreations.gumroad.com/l/${slug}`
  }
  return { ok: true, externalUrl }
}

function makeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

export const gumroadDriver: PlatformDriver = {
  platform:   'gumroad',
  loginUrl:   'https://app.gumroad.com/login',
  loginCheck,
  upload,
}
