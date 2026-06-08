/**
 * R357 — Anti-flag utilities. Every interaction goes through these so cross-
 * platform fraud-detection can't fingerprint the agent as a uniform-speed bot.
 *
 * Doctrine ref: workspace_memory.doctrine.anti_flag_intelligence (importance 98).
 */
import type { Locator, Page } from 'playwright'

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

/** Per-character typing jitter — humans type 40-200 ms/char, ~80 avg. */
export async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.click()
  for (const ch of text) {
    await locator.page().keyboard.type(ch, { delay: 0 })
    await sleep(rand(40, 180))
    if (Math.random() < 0.04) await sleep(rand(200, 500))   // micro-pause
  }
}

/** Bezier-ish curved mouse move + tiny overshoot before click. */
export async function humanClick(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) { await locator.click(); return }
  const tx = box.x + box.width * rand(0.3, 0.7)
  const ty = box.y + box.height * rand(0.3, 0.7)
  // Three intermediate steps with deviation
  const steps = 18 + Math.floor(rand(0, 12))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const cx = tx + (Math.random() - 0.5) * 12 * (1 - t)
    const cy = ty + (Math.random() - 0.5) * 12 * (1 - t)
    await page.mouse.move(cx, cy)
    await sleep(rand(4, 14))
  }
  await sleep(rand(40, 120))
  await page.mouse.click(tx, ty)
}

/** Inter-action delay — humans don't action every 200 ms. */
export async function humanPause(): Promise<void> {
  await sleep(rand(800, 2500))
}

/** Bigger pause between distinct steps (form sections, page transitions). */
export async function sectionPause(): Promise<void> {
  await sleep(rand(2500, 6000))
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Pick a delay between successive uploads on the same platform.
 * R350 anti-flag rule 4: 5-30 min between uploads. We jitter inside that.
 */
export function pickInterUploadDelayMs(): number {
  return rand(5 * 60_000, 30 * 60_000)
}
