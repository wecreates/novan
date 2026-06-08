/**
 * R357 — Per-platform driver contract.
 */
import type { Page } from 'playwright'
import type { QueueItem } from '../api.js'

export interface DriverInput {
  page:           Page
  item:           QueueItem
  designFilePath: string                    // absolute local path
  dryRun:         boolean                   // stop before final Publish click
}

export interface DriverResult {
  ok:           boolean
  externalUrl?: string                      // the published product URL
  reason?:      string                      // failure detail
}

export interface PlatformDriver {
  platform:     string                      // matches PLATFORMS table
  loginCheck:   (page: Page) => Promise<boolean>
  loginUrl:     string                      // page to land on for manual login
  upload:       (input: DriverInput) => Promise<DriverResult>
}
