/**
 * safety-policy.ts — Defense-in-depth for the autonomous code agent.
 *
 * THREE LAYERS:
 *   1. Intent filter   — proposal title/summary scanned BEFORE invoking agent
 *   2. Path policy     — every output file path must match allowlist patterns
 *   3. Content scanner — generated code scanned for forbidden patterns
 *
 * If any layer fails, the patch is BLOCKED and recorded. The agent never
 * writes to the live filesystem — sandbox only. Operator decides if the
 * validated patch text actually gets committed.
 *
 * This module is PURE — no DB, no I/O. Easily testable.
 */

// ─── Layer 1: Intent denylist ─────────────────────────────────────────────
// Reject proposals whose title/summary suggest hostile or illegal builds.
// Conservative: false positives are acceptable; false negatives are not.

const INTENT_DENYLIST: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(hack|hacking|exploit|exploits?|0day|0-day|zero[-\s]?day)\b/i,            reason: 'security exploitation intent' },
  { pattern: /\b(brute[-\s]?force|crack(er|ing)?\s+(password|key|hash))\b/i,              reason: 'credential cracking intent' },
  { pattern: /\b(phish|phishing|spoof|impersonat(e|ion))\b/i,                              reason: 'phishing/impersonation intent' },
  { pattern: /\b(malware|ransomware|spyware|keylog(ger)?|rootkit|backdoor)\b/i,           reason: 'malware intent' },
  { pattern: /\b(ddos|denial[-\s]?of[-\s]?service|botnet)\b/i,                             reason: 'attack tooling intent' },
  { pattern: /\b(surveill(e|ance)|stalk(er|ing)?|dox(x|xing)?)\b/i,                        reason: 'surveillance/stalking intent' },
  { pattern: /\b(deepfake|face[-\s]?swap|undress|nudif(y|ication))\b/i,                    reason: 'harmful media generation intent' },
  { pattern: /\b(csam|child[-\s]?(porn|abuse|sexual))\b/i,                                 reason: 'illegal content intent' },
  { pattern: /\b(weapon(ize|ization|s)?|firearm|explosive|bomb|grenade)\b/i,               reason: 'weapons intent' },
  { pattern: /\b(money[-\s]?laun(der|dering)|launder\s+(money|funds))\b/i,                 reason: 'financial-crime intent' },
  { pattern: /\b(fraud(ulent)?|scam(mer|ming)?|fake[-\s]?id|forge(d|ry))\b/i,              reason: 'fraud intent' },
  { pattern: /\b(bypass\s+(auth|2fa|mfa|paywall|drm|copyright))\b/i,                       reason: 'circumvention intent' },
  { pattern: /\b(steal(ing)?|theft|exfiltrat(e|ion))\s+(data|credentials|keys|tokens)\b/i, reason: 'data theft intent' },
  { pattern: /\b(swat(ting)?|harass(ment)?|threaten)\b/i,                                   reason: 'harm-to-person intent' },
  { pattern: /\b(sql[-\s]?injection|xss\s+(exploit|attack))\b/i,                            reason: 'injection-attack intent' },
]

export interface IntentCheck {
  ok: boolean
  blockedReasons: string[]
}

export function checkIntent(title: string, summary: string): IntentCheck {
  const text = `${title}\n${summary}`
  const blockedReasons: string[] = []
  for (const { pattern, reason } of INTENT_DENYLIST) {
    if (pattern.test(text)) blockedReasons.push(reason)
  }
  return { ok: blockedReasons.length === 0, blockedReasons }
}

// ─── Layer 2: Path policy ─────────────────────────────────────────────────
// Only specific path patterns may be created. Modifications restricted to a
// tiny allowlist with operation-specific constraints.

const CREATE_PATTERNS: RegExp[] = [
  /^apps\/api\/src\/services\/[a-z][a-z0-9-]*\.ts$/,
  /^apps\/api\/src\/routes\/[a-z][a-z0-9-]*\.ts$/,
  /^apps\/api\/src\/test\/[a-z][a-z0-9-]*\.test\.ts$/,
  /^apps\/web\/src\/pages\/[A-Z][A-Za-z0-9]*Page\.tsx$/,
  /^apps\/web\/src\/components\/[A-Z][A-Za-z0-9]*\.tsx$/,
  /^packages\/db\/migrations\/00[0-9]{2}_[a-z0-9_]+\.sql$/,
]

const MODIFY_ALLOWLIST: string[] = [
  'apps/api/src/server.ts',          // route registration only
  'apps/web/src/App.tsx',            // route + nav registration
  'packages/db/src/schema.ts',       // schema additions only
]

const FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /\.env/i,
  /\.git\//,
  /\.github\//,
  /Dockerfile/i,
  /docker-compose/i,
  /package\.json$/,
  /pnpm-lock\.yaml$/,
  /tsconfig\.json$/i,
  /\/auth\//,
  /\/secrets?-vault/,
  /\/billing\./,
  /\/security-team\./,
  /\/plugins\/auth/,
  /\.\./,                             // path traversal
  /^\//,                              // absolute path
]

export interface PathCheck {
  ok: boolean
  reason?: string
  op: 'create' | 'modify'
}

export function checkPath(path: string, op: 'create' | 'modify'): PathCheck {
  for (const f of FORBIDDEN_PATH_PATTERNS) {
    if (f.test(path)) return { ok: false, op, reason: `forbidden path: matches ${f.source}` }
  }
  if (op === 'create') {
    if (!CREATE_PATTERNS.some(p => p.test(path))) {
      return { ok: false, op, reason: `create path not in allowlist: ${path}` }
    }
  } else {
    if (!MODIFY_ALLOWLIST.includes(path)) {
      return { ok: false, op, reason: `modify path not in allowlist: ${path}` }
    }
  }
  return { ok: true, op }
}

// ─── Layer 3: Content scanner ─────────────────────────────────────────────

const FORBIDDEN_CONTENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Code execution primitives
  { pattern: /\beval\s*\(/,                              reason: 'eval() forbidden' },
  { pattern: /\bnew\s+Function\s*\(/,                    reason: 'new Function() forbidden' },
  { pattern: /\bchild_process\b/,                        reason: 'child_process forbidden' },
  { pattern: /\b(exec|execSync|spawn|spawnSync|fork)\s*\(/, reason: 'process spawn forbidden' },
  { pattern: /\bvm\.(?:run|create|Script|compile)/,      reason: 'vm module forbidden' },
  // Filesystem outside repo
  { pattern: /writeFileSync?\s*\(\s*['"`]\//,            reason: 'absolute filesystem path forbidden' },
  { pattern: /unlink|rmdir|rm\s*-rf/,                    reason: 'destructive fs op forbidden' },
  // Secrets / auth tampering
  { pattern: /process\.env\.[A-Z_]*(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL)/,
    reason: 'direct secret env access forbidden — use secrets-vault' },
  { pattern: /\bcrypto\.create(?:Decipher|Hash)/,        reason: 'low-level crypto forbidden — use approved helpers' },
  // Network exfil patterns
  { pattern: /https?:\/\/(?!api\.groq\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com|api\.tavily\.com|api\.replicate\.com|fal\.ai|api\.stability\.ai|hooks\.slack\.com|discord\.com\/api\/webhooks|api\.pushover\.net)/,
    reason: 'external URL not in allowlist' },
  // Process control
  { pattern: /process\.exit\s*\(/,                       reason: 'process.exit forbidden' },
  { pattern: /process\.kill\s*\(/,                       reason: 'process.kill forbidden' },
  // SQL injection vector
  { pattern: /db\.execute\s*\(\s*sql`[^`]*\$\{[^}]*req\.[a-z]/i, reason: 'unsanitized req param in SQL' },
  // Auth/security middleware bypass
  { pattern: /skipAuth|bypassAuth|disableAuth/i,         reason: 'auth bypass forbidden' },
]

// Identifier-context patterns: ban DEFINING new auth/payment/secret features in a service file.
const FORBIDDEN_NEW_FEATURE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /export\s+(async\s+)?function\s+(authenticate|loginUser|signin|signup|verifyPassword|hashPassword|issueToken|mintApiKey)\b/i,
    reason: 'new auth function forbidden' },
  { pattern: /export\s+(async\s+)?function\s+(chargeCard|capturePayment|refund|payout|wireTransfer)\b/i,
    reason: 'new payment function forbidden' },
  { pattern: /class\s+(AuthProvider|PaymentProcessor|SecretsStore|Wallet|Treasury)\b/,
    reason: 'new auth/payment/treasury class forbidden' },
]

export interface ContentCheck {
  ok: boolean
  violations: Array<{ pattern: string; reason: string; line?: number }>
}

export function checkContent(path: string, contents: string): ContentCheck {
  const violations: Array<{ pattern: string; reason: string; line?: number }> = []
  const lines = contents.split('\n')

  for (const { pattern, reason } of FORBIDDEN_CONTENT_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        violations.push({ pattern: pattern.source.slice(0, 60), reason, line: i + 1 })
        break
      }
    }
  }
  for (const { pattern, reason } of FORBIDDEN_NEW_FEATURE_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        violations.push({ pattern: pattern.source.slice(0, 60), reason, line: i + 1 })
        break
      }
    }
  }

  // Size caps — anti-runaway
  if (contents.length > 30_000) violations.push({ pattern: 'size', reason: `file exceeds 30k chars (${contents.length})` })
  if (lines.length    > 800)    violations.push({ pattern: 'lines', reason: `file exceeds 800 lines (${lines.length})` })

  return { ok: violations.length === 0, violations }
}

// ─── Aggregate check ──────────────────────────────────────────────────────

export interface SafetyReport {
  ok: boolean
  intentCheck: IntentCheck
  fileChecks: Array<{ path: string; pathCheck: PathCheck; contentCheck?: ContentCheck }>
  totalFiles: number
  blockedReasons: string[]
}

export function evaluate(input: {
  title: string
  summary: string
  files: Array<{ path: string; contents: string; op: 'create' | 'modify' }>
}): SafetyReport {
  const intentCheck = checkIntent(input.title, input.summary)
  const fileChecks: SafetyReport['fileChecks'] = []
  const blockedReasons: string[] = []

  if (!intentCheck.ok) {
    blockedReasons.push(...intentCheck.blockedReasons.map(r => `intent: ${r}`))
  }

  // Anti-runaway: max files per patch
  if (input.files.length > 12) {
    blockedReasons.push(`too many files (${input.files.length} > 12)`)
  }

  for (const f of input.files) {
    const pathCheck = checkPath(f.path, f.op)
    let contentCheck: ContentCheck | undefined
    if (pathCheck.ok) {
      contentCheck = checkContent(f.path, f.contents)
      if (!contentCheck.ok) {
        for (const v of contentCheck.violations) {
          blockedReasons.push(`content[${f.path}:${v.line ?? '?'}]: ${v.reason}`)
        }
      }
    } else {
      blockedReasons.push(`path[${f.path}]: ${pathCheck.reason}`)
    }
    fileChecks.push({ path: f.path, pathCheck, ...(contentCheck ? { contentCheck } : {}) })
  }

  return {
    ok: blockedReasons.length === 0,
    intentCheck,
    fileChecks,
    totalFiles: input.files.length,
    blockedReasons,
  }
}
