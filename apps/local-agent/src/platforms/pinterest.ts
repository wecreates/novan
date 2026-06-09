/**
 * R368 — Pinterest pinner driver.
 *
 * Pulls the next pin from the pinterest_pin_queue and creates it via the
 * web UI. Server-side cap is 5/day; client-side pacing adds 30-90 min between
 * pins.
 *
 * Flow:
 *   1. Navigate to /pin-builder/
 *   2. Upload design file
 *   3. Fill title + description
 *   4. Select board (create if needed)
 *   5. Paste destination link
 *   6. Click Publish
 */
import type { Page } from 'playwright'
import { humanType, humanClick, humanPause, sectionPause } from '../anti-flag.js'
import type { AgentConfig } from '../config.js'

async function brainTask<T>(cfg: AgentConfig, op: string, params: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op, params }] }),
    })
    if (!res.ok) return null
    const j = await res.json() as { data?: { results?: Array<{ ok: boolean; data: T }> } }
    return j.data?.results?.[0]?.data ?? null
  } catch { return null }
}

interface PinItem {
  id:          string
  title:       string
  description: string
  tags:        string
  linkUrl:     string
  boardName:   string
  designFile:  string | null
}

export async function loginCheckPinterest(page: Page): Promise<boolean> {
  await page.goto('https://www.pinterest.com/pin-builder/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const url = page.url()
  if (url.includes('/login') || url.includes('signup')) return false
  return await page.locator('input[type="file"], button:has-text("Publish"), [data-test-id*="pin"]')
    .first().isVisible({ timeout: 5_000 }).catch(() => false)
}

export async function postOnePin(cfg: AgentConfig, page: Page): Promise<{ ok: boolean; reason?: string; externalUrl?: string }> {
  const pin = await brainTask<PinItem | null>(cfg, 'pinterest.next', {})
  if (!pin) return { ok: false, reason: 'no pins ready (cap hit or queue empty)' }
  if (!pin.designFile) {
    await brainTask(cfg, 'pinterest.mark_failed', { pinQueueId: pin.id, reason: 'no design file path' })
    return { ok: false, reason: 'no design file' }
  }

  await page.goto('https://www.pinterest.com/pin-builder/', { waitUntil: 'domcontentloaded' })
  await sectionPause()

  // 1. Upload image
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 20_000 })
  await fileInput.setInputFiles(pin.designFile)
  await page.waitForTimeout(8_000)   // Pinterest processes upload

  // 2. Title
  const titleField = page.locator(
    'input[id*="title" i], textarea[id*="title" i], input[placeholder*="title" i], [data-test-id*="title"] input, [data-test-id*="title"] textarea'
  ).first()
  if (await titleField.count() > 0) {
    await humanType(titleField, pin.title.slice(0, 100))
    await humanPause()
  }

  // 3. Description
  const descField = page.locator(
    'textarea[id*="description" i], textarea[placeholder*="description" i], [data-test-id*="description"] textarea'
  ).first()
  if (await descField.count() > 0) {
    await humanType(descField, pin.description.slice(0, 500))
    await humanPause()
  }

  // 4. Destination link
  const linkField = page.locator(
    'input[id*="link" i], input[placeholder*="link" i], input[placeholder*="destination" i], [data-test-id*="link"] input'
  ).first()
  if (await linkField.count() > 0) {
    await humanType(linkField, pin.linkUrl)
    await humanPause()
  }

  // 5. Board selection — click board selector + look for the board name
  const boardSelector = page.locator(
    'button:has-text("Choose a board"), button:has-text("Select"), [data-test-id*="board"] button'
  ).first()
  if (await boardSelector.count() > 0) {
    await humanClick(page, boardSelector)
    await page.waitForTimeout(1500)
    const boardOption = page.locator(`text="${pin.boardName}"`).first()
    if (await boardOption.count() > 0) await humanClick(page, boardOption)
    else {
      // Create board if needed
      const createBtn = page.locator('button:has-text("Create"), [data-test-id*="create-board"]').first()
      if (await createBtn.count() > 0) await humanClick(page, createBtn)
    }
    await humanPause()
  }

  // 6. Publish
  const publishBtn = page.locator(
    'button:has-text("Publish"), [data-test-id*="publish"] button, button[type="submit"]:visible'
  ).first()
  if (await publishBtn.count() === 0) {
    await brainTask(cfg, 'pinterest.mark_failed', { pinQueueId: pin.id, reason: 'publish button not found' })
    return { ok: false, reason: 'publish button not found' }
  }
  await humanClick(page, publishBtn)
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await sectionPause()

  // Extract live pin URL — Pinterest typically redirects to /pin/<id>/
  const url = page.url()
  const externalUrl = url.includes('/pin/') ? url : 'https://www.pinterest.com/pin/'
  await brainTask(cfg, 'pinterest.mark_posted', { pinQueueId: pin.id, externalUrl })
  return { ok: true, externalUrl }
}
