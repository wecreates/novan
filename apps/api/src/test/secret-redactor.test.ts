/**
 * Tests for secret-redactor.ts — production credential redaction layer.
 *
 * These patterns guard every log line, persisted stdout/stderr, and event
 * payload. They are the LAST defence before a token reaches an attacker's
 * scrape. Tested as black-box contracts:
 *  - real tokens get redacted
 *  - real-looking-but-safe strings are NOT redacted
 *  - sandbox env strips blocked keys
 *  - hasRawSecrets detects unredacted leaks
 */
import { describe, it, expect } from 'vitest'
import {
  redactSecrets, buildSandboxEnv, hasRawSecrets,
  BLOCKED_ENV_KEYS, SANDBOX_ENV_ALLOWLIST,
}                          from '../services/secret-redactor.js'

// ─── A) redactSecrets — known credential formats ─────────────────────────────

describe('redactSecrets: known credential formats', () => {
  it('redacts OpenAI API keys', () => {
    const fakeKey = ['sk', 'abc123def456ghi789jkl012mno345'].join('-')
    const r = redactSecrets(`here is ${fakeKey} and more text`)
    expect(r.redacted).not.toContain(fakeKey)
    expect(r.redacted).toContain('[REDACTED:openai_key]')
    expect(r.count).toBeGreaterThanOrEqual(1)
    expect(r.patternNames).toContain('openai_key')
  })

  it('redacts Anthropic API keys', () => {
    const r = redactSecrets('using sk-ant-abc123-def456-ghi789-jkl012 for prod')
    expect(r.redacted).not.toContain('sk-ant-abc123-def456-ghi789-jkl012')
    expect(r.redacted).toContain('[REDACTED:anthropic_key]')
  })

  it('redacts AWS access key IDs', () => {
    const r = redactSecrets('access key AKIAIOSFODNN7EXAMPLE is wrong')
    expect(r.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(r.redacted).toContain('[REDACTED:aws_access_key]')
  })

  it('redacts GitHub PAT (classic + fine-grained)', () => {
    const classic     = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
    const fineGrained = ['github_pat', '11AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII'].join('_')
    const a = redactSecrets(`token ${classic} leaked`)
    expect(a.redacted).not.toContain(classic)
    expect(a.redacted).toContain('[REDACTED:github_token]')

    const b = redactSecrets(`PAT ${fineGrained}`)
    expect(b.redacted).not.toContain(fineGrained)
    expect(b.redacted).toContain('[REDACTED:github_token]')
  })

  it('redacts Stripe live + test keys', () => {
    // Build patterns at runtime so source literals don't trip secret scanners.
    const liveKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_')
    const testKey = ['sk', 'test', 'abcdefghijklmnopqrstuvwxyz'].join('_')
    const a = redactSecrets(`charge with ${liveKey}`)
    expect(a.redacted).not.toContain(liveKey)
    expect(a.redacted).toContain('[REDACTED:stripe_key]')

    const b = redactSecrets(`test with ${testKey}`)
    expect(b.redacted).toContain('[REDACTED:stripe_key]')
  })

  it('redacts Bearer tokens in Authorization headers', () => {
    const r = redactSecrets('Authorization: Bearer abc.def.ghi-jkl_mno=pqr+stu/vwx')
    expect(r.redacted).not.toContain('abc.def.ghi-jkl_mno=pqr+stu/vwx')
    expect(r.redacted).toContain('Bearer [REDACTED:token]')
  })

  it('redacts Postgres connection strings with passwords', () => {
    const r = redactSecrets('connecting to postgresql://user:supersecretpw@host:5432/db?ssl=true')
    expect(r.redacted).not.toContain('supersecretpw')
    expect(r.redacted).toContain('[REDACTED:pg_dsn]')
  })

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = redactSecrets(`Bearer-less: ${jwt} stored`)
    expect(r.redacted).not.toContain(jwt)
    expect(r.redacted).toContain('[REDACTED:jwt]')
  })

  it('redacts env-var-style secret assignments', () => {
    const r = redactSecrets('export API_KEY=abcdef0123456789abcdef0123 in shell')
    expect(r.redacted).not.toContain('abcdef0123456789abcdef0123')
    expect(r.redacted).toContain('[REDACTED:env_secret]')
  })

  it('returns count > 0 when anything was redacted', () => {
    const oa = ['sk', '1234567890abcdef1234567890'].join('-')
    const gh = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
    const r = redactSecrets(`two tokens: ${oa} and ${gh}`)
    expect(r.count).toBeGreaterThanOrEqual(2)
  })

  it('returns count 0 + empty patterns when nothing matches', () => {
    const r = redactSecrets('plain text with no credentials')
    expect(r.count).toBe(0)
    expect(r.patternNames).toEqual([])
  })

  it('is idempotent — redacting twice produces the same output', () => {
    const fake  = ['sk', 'abc123def456ghi789jkl012mno345'].join('-')
    const once  = redactSecrets(fake).redacted
    const twice = redactSecrets(once).redacted
    expect(twice).toBe(once)
  })

  it('handles empty input', () => {
    const r = redactSecrets('')
    expect(r.redacted).toBe('')
    expect(r.count).toBe(0)
  })

  it('preserves the rest of the string', () => {
    const fake = ['sk', '1234567890abcdef1234567890'].join('-')
    const r = redactSecrets(`before ${fake} after`)
    expect(r.redacted).toMatch(/^before \[REDACTED:openai_key\] after$/)
  })
})

// ─── B) hasRawSecrets — leak detection ───────────────────────────────────────

describe('hasRawSecrets: leak detection', () => {
  it('reports clean for plain text', () => {
    const r = hasRawSecrets('nothing suspicious here')
    expect(r.clean).toBe(true)
    expect(r.patterns).toEqual([])
  })

  it('flags OpenAI key', () => {
    const fake = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
    const r = hasRawSecrets(fake)
    expect(r.clean).toBe(false)
    expect(r.patterns).toContain('openai_key')
  })

  it('flags multiple types simultaneously', () => {
    const oa = ['sk', '1234567890abcdef1234567890'].join('-')
    const gh = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
    const r = hasRawSecrets(`${oa} and ${gh}`)
    expect(r.clean).toBe(false)
    expect(r.patterns.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── C) buildSandboxEnv — env allowlist + blocklist ──────────────────────────

describe('buildSandboxEnv: env stripping', () => {
  it('strips all secret env vars from the resulting object', () => {
    const dirty = {
      OPENAI_API_KEY:        'sk-leaked',
      ANTHROPIC_API_KEY:     'sk-ant-leaked',
      DATABASE_URL:          'postgres://leaked',
      AUTH_SECRET:           'leaked',
      STRIPE_SECRET_KEY:     'sk_live_leaked',
      PATH:                  '/usr/bin',
      NODE_ENV:              'production',
    }
    const safe = buildSandboxEnv(dirty)
    expect(safe['OPENAI_API_KEY']).toBeUndefined()
    expect(safe['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(safe['DATABASE_URL']).toBeUndefined()
    expect(safe['AUTH_SECRET']).toBeUndefined()
    expect(safe['STRIPE_SECRET_KEY']).toBeUndefined()
    expect(safe['PATH']).toBe('/usr/bin')
    expect(safe['NODE_ENV']).toBe('production')
  })

  it('forces CI + colour env vars even if unset', () => {
    const safe = buildSandboxEnv({})
    expect(safe['CI']).toBe('1')
    expect(safe['FORCE_COLOR']).toBe('0')
    expect(safe['NO_COLOR']).toBe('1')
  })

  it('omits keys that are explicitly undefined', () => {
    const safe = buildSandboxEnv({ PATH: undefined, HOME: '/home/test' })
    expect(safe['PATH']).toBeUndefined()
    expect(safe['HOME']).toBe('/home/test')
  })

  it('drops keys not in the allowlist even if benign', () => {
    const safe = buildSandboxEnv({ RANDOM_USER_VAR: 'whatever' })
    expect(safe['RANDOM_USER_VAR']).toBeUndefined()
  })
})

// ─── D) Allowlist + blocklist invariants ─────────────────────────────────────

describe('env allowlist/blocklist invariants', () => {
  it('blocklist contains the most common secret env names', () => {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL',
                     'AUTH_SECRET', 'STRIPE_SECRET_KEY']) {
      expect(BLOCKED_ENV_KEYS.has(k)).toBe(true)
    }
  })

  it('allowlist excludes every known blocked env name', () => {
    for (const k of BLOCKED_ENV_KEYS) {
      expect(SANDBOX_ENV_ALLOWLIST.has(k)).toBe(false)
    }
  })

  it('allowlist contains baseline POSIX env vars', () => {
    for (const k of ['PATH', 'HOME', 'NODE_ENV', 'CI']) {
      expect(SANDBOX_ENV_ALLOWLIST.has(k)).toBe(true)
    }
  })
})
