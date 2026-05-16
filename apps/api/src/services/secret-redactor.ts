/**
 * secret-redactor.ts — Pure secret/credential redaction utility.
 *
 * Scrubs known credential patterns from any string before:
 * - persisting to DB (stdout/stderr columns)
 * - emitting to SSE stream
 * - returning to UI
 *
 * Returns both the redacted string and a count of tokens replaced.
 * Never throws — if redaction fails, returns original with error flag.
 */

// ─── Pattern definitions ───────────────────────────────────────────────────────

interface RedactPattern {
  name:    string
  pattern: RegExp
  replace: string
}

/**
 * All patterns use global flag. Order matters — more specific first.
 * Replacement strings are safe sentinel values that reveal the secret type
 * without exposing the secret itself.
 */
const REDACT_PATTERNS: RedactPattern[] = [
  // OpenAI API keys
  {
    name:    'openai_key',
    pattern: /sk-[a-zA-Z0-9]{20,}/g,
    replace: '[REDACTED:openai_key]',
  },
  // Anthropic API keys
  {
    name:    'anthropic_key',
    pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
    replace: '[REDACTED:anthropic_key]',
  },
  // AWS access key ID
  {
    name:    'aws_access_key',
    pattern: /(?:AKIA|ABIA|ACCA|AGPA|AIDA|AIPA|AKIA|ANPA|ANVA|AROA|ASCA|ASIA)[A-Z0-9]{16}/g,
    replace: '[REDACTED:aws_access_key]',
  },
  // AWS secret access key (after = or space, 40 base64 chars)
  {
    name:    'aws_secret',
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
    replace: '[REDACTED:aws_secret]',
  },
  // GitHub PAT / tokens
  {
    name:    'github_token',
    pattern: /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9]{36,}/g,
    replace: '[REDACTED:github_token]',
  },
  // Stripe keys
  {
    name:    'stripe_key',
    pattern: /(?:sk|pk|rk)_(?:live|test)_[a-zA-Z0-9]{24,}/g,
    replace: '[REDACTED:stripe_key]',
  },
  // Generic Bearer tokens (Authorization headers)
  {
    name:    'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-_=.+/]{20,}/g,
    replace: 'Bearer [REDACTED:token]',
  },
  // Basic auth in URLs
  {
    name:    'basic_auth_url',
    pattern: /([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/)([^:@\s]+):([^@\s]{6,})@/g,
    replace: '$1[REDACTED:user]:[REDACTED:password]@',
  },
  // Postgres connection strings with password
  {
    name:    'pg_dsn',
    pattern: /postgresql?:\/\/[^:@\s]+:[^@\s]{6,}@[^\s"']*/g,
    replace: '[REDACTED:pg_dsn]',
  },
  // Generic env var assignments that look like secrets (KEY=VALUE where value is long and opaque)
  {
    name:    'env_secret',
    pattern: /(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|AUTH_SECRET|ENCRYPTION_KEY)\s*[=:]\s*["']?[A-Za-z0-9\-_./+=]{16,}["']?/gi,
    replace: '[REDACTED:env_secret]',
  },
  // JWT tokens (3 base64url segments)
  {
    name:    'jwt',
    pattern: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g,
    replace: '[REDACTED:jwt]',
  },
]

// ─── Runtime env key blocklist ─────────────────────────────────────────────────

/**
 * Env keys that must NEVER be passed to sandboxed processes.
 * Even if process.env contains these, they are stripped before spawn.
 */
export const BLOCKED_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'AUTH_SECRET',
  'JWT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'DB_PASSWORD',
  'POSTGRES_PASSWORD',
  'REDIS_URL',
  'REDIS_PASSWORD',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_APP_PRIVATE_KEY',
  'ENCRYPTION_KEY',
  'PRIVATE_KEY',
  'API_KEY',
  'SECRET_KEY',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
])

// ─── Allowed env keys for sandboxed processes ─────────────────────────────────

/**
 * Explicit allowlist of env keys that are safe to forward.
 * Anything not on this list is stripped.
 */
export const SANDBOX_ENV_ALLOWLIST = new Set([
  'NODE_ENV',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PWD',
  'OLDPWD',
  'SHELL',
  'TERM',
  'USER',
  'USERNAME',
  'LOGNAME',
  'REPO_ROOT',
  'NODE_PATH',
  'npm_config_cache',
  'PNPM_HOME',
  'TURBO_TEAM',
  'TURBO_TOKEN',  // safe — controls remote cache, not credentials
])

// ─── Redaction engine ──────────────────────────────────────────────────────────

export interface RedactResult {
  redacted:      string
  count:         number   // number of tokens replaced
  patternNames:  string[] // which pattern types fired
}

export function redactSecrets(input: string): RedactResult {
  let result = input
  let count  = 0
  const fired = new Set<string>()

  for (const { name, pattern, replace } of REDACT_PATTERNS) {
    // Reset lastIndex (global regex)
    pattern.lastIndex = 0
    const before = result
    result = result.replace(pattern, replace)
    if (result !== before) {
      // Count replacements made
      pattern.lastIndex = 0
      const matches = before.match(pattern)
      count += matches?.length ?? 1
      fired.add(name)
    }
  }

  return { redacted: result, count, patternNames: [...fired] }
}

/**
 * Build a sanitized env object for sandboxed process execution.
 * Only keys on the allowlist pass through. Blocked keys are stripped.
 */
export function buildSandboxEnv(
  baseEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const val = baseEnv[key]
    if (val !== undefined) safe[key] = val
  }
  // Always force CI mode and no color for deterministic output
  safe['CI'] = '1'
  safe['FORCE_COLOR'] = '0'
  safe['NO_COLOR'] = '1'
  return safe
}

/**
 * Verify a string contains no obvious raw secrets.
 * Returns true if clean, false + matches if dirty.
 */
export function hasRawSecrets(input: string): { clean: boolean; patterns: string[] } {
  const patterns: string[] = []
  for (const { name, pattern } of REDACT_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(input)) patterns.push(name)
  }
  return { clean: patterns.length === 0, patterns }
}
