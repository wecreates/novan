/**
 * Catalog validation tests.
 *
 * Enforce that every connector in the catalog meets the metadata
 * contract from the master prompt. This is a lint-style test: it
 * runs against the static CATALOG array (no DB, no mocks).
 *
 * If you add a new connector and one of these fails, the connector
 * is incomplete — fix the def, don't disable the test.
 */
import { describe, it, expect } from 'vitest'
import { CATALOG } from '../services/connector-catalog/index.js'

describe('connector catalog metadata', () => {
  it('catalog is non-empty', () => {
    expect(CATALOG.length).toBeGreaterThan(0)
  })

  describe.each(CATALOG.map(c => [c.id, c] as const))('%s', (_id, def) => {
    it('has stable slug + name + category', () => {
      expect(def.id).toMatch(/^[a-z][a-z0-9-]+$/)
      expect(def.name.length).toBeGreaterThan(0)
      expect(def.category.length).toBeGreaterThan(0)
    })

    it('has description ≥ 20 chars', () => {
      expect(def.description.length).toBeGreaterThanOrEqual(20)
    })

    it('declares at least one action', () => {
      expect(def.actions.length).toBeGreaterThan(0)
    })

    it('every action has unique fully-qualified name (provider.verb shape)', () => {
      const names = def.actions.map(a => a.name)
      expect(new Set(names).size).toBe(names.length)
      for (const n of names) {
        // Must be "provider.verb" shape. Provider prefix may be the
        // connector id OR the natural provider name (e.g. "stripe" for
        // "stripe-readonly"). Cross-catalog uniqueness is checked below.
        expect(n).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]+$/)
      }
    })

    it('every action has a sane risk + minPermission', () => {
      for (const a of def.actions) {
        expect(['low', 'medium', 'high']).toContain(a.risk)
        expect(['read', 'draft', 'publish', 'admin']).toContain(a.minPermission)
      }
    })

    it('has officialWebsiteUrl + docsUrl', () => {
      expect(def.officialWebsiteUrl).toBeTruthy()
      expect(def.docsUrl).toBeTruthy()
      expect(def.officialWebsiteUrl).toMatch(/^https:\/\//)
      expect(def.docsUrl).toMatch(/^https:\/\//)
    })

    it('claims metadataVerified: true', () => {
      // Anything in this catalog should have been verified before commit.
      // If you add an unverified entry, ship it with metadataVerified
      // intentionally omitted — but it'll fail this test and warn you.
      expect(def.metadataVerified).toBe(true)
    })

    it('every URL is https', () => {
      const urlFields: Array<keyof typeof def> = [
        'officialWebsiteUrl','signupUrl','loginUrl','oauthAuthorizationUrl',
        'developerAppSetupUrl','apiKeyCreationUrl','docsUrl','pricingUrl','statusPageUrl',
      ]
      for (const f of urlFields) {
        const v = def[f] as string | undefined
        if (v) expect(v).toMatch(/^https:\/\//)
      }
    })

    it('declares at least one auth type matching authType', () => {
      // If authType is 'oauth', supportsOauth should be true (seed fills
      // default but explicit is better). Same for api_key / session.
      if (def.supportsOauth === false && def.authType === 'oauth') {
        throw new Error('authType=oauth but supportsOauth=false')
      }
      if (def.supportsApiKey === false && (def.authType === 'api_key' || def.authType === 'token')) {
        throw new Error('authType=api_key/token but supportsApiKey=false')
      }
    })

    it('has permissionExplanation (operator must understand what they grant)', () => {
      expect(def.permissionExplanation?.length ?? 0).toBeGreaterThan(20)
    })

    it('has signup OR login URL (operator needs a way to reach the provider)', () => {
      expect(def.signupUrl ?? def.loginUrl).toBeTruthy()
    })

    it('has either developerAppSetupUrl OR apiKeyCreationUrl when accountRequired', () => {
      if (def.accountRequired !== false) {
        expect(def.developerAppSetupUrl ?? def.apiKeyCreationUrl).toBeTruthy()
      }
    })
  })
})

describe('catalog cross-checks', () => {
  it('all connector IDs are unique', () => {
    const ids = CATALOG.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all action names across catalog are unique', () => {
    const all = CATALOG.flatMap(c => c.actions.map(a => a.name))
    expect(new Set(all).size).toBe(all.length)
  })
})
