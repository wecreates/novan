/**
 * connector-oauth.ts — generic OAuth 2.0 authorization-code flow.
 *
 * Provider-agnostic substrate. Each OAuth-capable connector registers
 * its provider config (auth URL, token URL, client ID, redirect URI).
 * The flow:
 *
 *   1. POST /api/v1/connectors/oauth/start
 *      body: { workspace_id, connector_id, label, scopes? }
 *      → returns { state, authorizeUrl }
 *      operator opens authorizeUrl in browser
 *
 *   2. Provider redirects to /api/v1/connectors/oauth/callback?code=…&state=…
 *      We look up the pending row by state, exchange code → tokens, store
 *      the access (+ refresh) token in the vault, create the
 *      connector_accounts row.
 *
 *   3. POST /api/v1/connectors/oauth/refresh  (optional, periodic)
 *      Refreshes the access token using the stored refresh token.
 *
 * Honest scope today:
 *   - Real authorization-code exchange flow
 *   - Real state CSRF protection
 *   - Vault-encrypted token storage
 *   - One provider configured: GitHub (client ID/secret read from env)
 *   - Adding a new provider = add a `ProviderConfig` entry below
 *
 * Deferred:
 *   - Automatic token refresh cron (the refresh route works manually)
 *   - PKCE (some providers require it; substrate doesn't enforce yet)
 *   - Server-side login UI (operator opens the authorizeUrl directly)
 */
import { v7 as uuidv7 } from 'uuid'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { storeSecret } from './secrets-vault.js'
import { createAccount, type Permission } from './connectors.js'

// ── Provider config ──────────────────────────────────────────────────

export interface ProviderConfig {
  connectorId:        string
  authorizationUrl:   string       // base URL operator visits
  tokenUrl:           string       // POST endpoint we hit for code → token
  clientIdEnv:        string       // env var name for client ID
  clientSecretEnv:    string       // env var name for client secret
  defaultScopes:      string[]
  /** Optional override for the redirect URI base (defaults to the API host). */
  redirectPathOverride?: string
  /** Extra query params to add to the authorization URL. */
  extraAuthParams?:   Record<string, string>
}

// Each connector that supports OAuth declares its endpoints here.
// Operator must register a real OAuth app at the provider and set the
// client ID + secret as env vars (e.g. NOVAN_OAUTH_GITHUB_CLIENT_ID).
export const OAUTH_PROVIDERS: Record<string, ProviderConfig> = {
  github: {
    connectorId:      'github',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl:         'https://github.com/login/oauth/access_token',
    clientIdEnv:      'NOVAN_OAUTH_GITHUB_CLIENT_ID',
    clientSecretEnv:  'NOVAN_OAUTH_GITHUB_CLIENT_SECRET',
    defaultScopes:    ['repo', 'read:user'],
  },
  slack: {
    connectorId:      'slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl:         'https://slack.com/api/oauth.v2.access',
    clientIdEnv:      'NOVAN_OAUTH_SLACK_CLIENT_ID',
    clientSecretEnv:  'NOVAN_OAUTH_SLACK_CLIENT_SECRET',
    defaultScopes:    ['chat:write', 'channels:read'],
  },
  // Google connectors share the same OAuth endpoints; the scope set
  // distinguishes Calendar vs Gmail at app-registration time.
  gcal: {
    connectorId:      'gcal',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:         'https://oauth2.googleapis.com/token',
    clientIdEnv:      'NOVAN_OAUTH_GOOGLE_CLIENT_ID',
    clientSecretEnv:  'NOVAN_OAUTH_GOOGLE_CLIENT_SECRET',
    defaultScopes:    ['https://www.googleapis.com/auth/calendar.events'],
    extraAuthParams:  { access_type: 'offline', prompt: 'consent' },
  },
  gmail: {
    connectorId:      'gmail',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:         'https://oauth2.googleapis.com/token',
    clientIdEnv:      'NOVAN_OAUTH_GOOGLE_CLIENT_ID',
    clientSecretEnv:  'NOVAN_OAUTH_GOOGLE_CLIENT_SECRET',
    defaultScopes:    ['https://www.googleapis.com/auth/gmail.compose'],
    extraAuthParams:  { access_type: 'offline', prompt: 'consent' },
  },
  discord: {
    connectorId:      'discord',
    authorizationUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl:         'https://discord.com/api/oauth2/token',
    clientIdEnv:      'NOVAN_OAUTH_DISCORD_CLIENT_ID',
    clientSecretEnv:  'NOVAN_OAUTH_DISCORD_CLIENT_SECRET',
    defaultScopes:    ['bot'],
  },
  notion: {
    connectorId:      'notion',
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl:         'https://api.notion.com/v1/oauth/token',
    clientIdEnv:      'NOVAN_OAUTH_NOTION_CLIENT_ID',
    clientSecretEnv:  'NOVAN_OAUTH_NOTION_CLIENT_SECRET',
    defaultScopes:    [],         // Notion grants integration access per-page
    extraAuthParams:  { owner: 'user' },
  },
}

// ── Pending state store (in-memory; flushed every 10 min) ─────────────
//
// State is short-lived (≤10 min between start and callback). Keeping
// in-process avoids DB write/read for every OAuth start. If the API
// restarts during a pending flow, the operator just clicks "Connect"
// again — no data corruption risk.

interface PendingState {
  state:       string
  workspaceId: string
  operatorId:  string
  label:       string
  connectorId: string
  scopes:      string[]
  permission:  Permission
  createdAt:   number
  /** R146.44 — PKCE verifier; threaded into the token exchange. */
  codeVerifier?: string
}

const PENDING = new Map<string, PendingState>()
// Hard ceiling to defend against a runaway producer (e.g. an attacker
// hammering /start to grow the Map). Oldest entries get evicted FIFO
// when the cap is hit — legitimate flows complete in seconds, so an
// evicted state is almost always a malicious or abandoned attempt.
const PENDING_MAX = 10_000

function pendingSet(k: string, v: PendingState): void {
  if (PENDING.size >= PENDING_MAX) {
    const firstKey = PENDING.keys().next().value
    if (firstKey !== undefined) PENDING.delete(firstKey)
  }
  PENDING.set(k, v)
}

function reapStale() {
  const cutoff = Date.now() - 10 * 60_000
  for (const [k, v] of PENDING) if (v.createdAt < cutoff) PENDING.delete(k)
}
// Track the timer so the API graceful-shutdown path can clear it, freeing
// the event loop instead of relying on .unref() to skip waiting.
const REAP_TIMER = setInterval(reapStale, 60_000)
REAP_TIMER.unref()

/** Stop the OAuth pending-state reaper. Called from server.ts shutdown. */
export function stopConnectorOauthReaper(): void {
  clearInterval(REAP_TIMER)
}

// ─── R146.48: refresh-flow hazards + lock helper ─────────────────────────
//
// Audit finding: completeCallback stores the refresh_token in the vault
// under `${connectorId}:${label}:refresh`, but NOTHING in the codebase
// uses it. Connectors will silently break ~1hr after grant once provider
// access tokens expire. When the operator wires up the refresh flow,
// the implementation MUST satisfy ALL of the following or it will ship
// the vulnerabilities this audit was looking for:
//
//   1. Concurrent-refresh race. Two callers seeing an expired access
//      token will both POST refresh_token to the provider. Some
//      providers issue a new refresh_token on success AND invalidate
//      the old; the slower of the two callers will then have a stale
//      access + a now-invalid refresh and the account is bricked.
//      → Use refreshLock.runExclusive(accountId, ...) below.
//
//   2. Rotating refresh tokens. Google, Microsoft, GitHub all rotate
//      refresh_token in the response when configured to. If you only
//      replace the access secret, the next refresh fails with
//      invalid_grant the moment the provider rotates. → On every
//      successful refresh, rotateSecret() BOTH access AND (when present
//      in the response) refresh secrets atomically before returning.
//
//   3. Revoked refresh tokens. Provider returns 400 invalid_grant when
//      the user revoked access in their settings, or when the refresh
//      hit its TTL. → Emit `connector.refresh_revoked` event + mark the
//      connector account inactive + DO NOT delete the vault rows
//      (operator must consciously re-grant; auto-delete is recoverable
//      via re-OAuth but the audit trail matters).
//
//   4. Stored access tokens with no expiry tracking. Currently we store
//      `expiresIn` (number of seconds) in account.metadata but the
//      absolute `expiresAt = now + expiresIn*1000` is not derived
//      anywhere. → Compute and store expiresAt at grant time; check it
//      before every outbound provider call and refresh proactively.
//
//   5. Logging. The refresh response body contains the new access +
//      refresh tokens. pino redaction (R38) handles structured logs, but
//      console.error() and toString() do NOT. → Never log the response
//      body verbatim; log only `{ ok, status, rotated_refresh: bool }`.

const REFRESH_LOCKS = new Map<string, Promise<unknown>>()
// R146.53 — hard cap. Even with the per-entry finally-delete, a synthetic
// burst of distinct accountIds would grow the map until the slow tail of
// hung fetches resolves. 5000 lets a high-fanout operator workspace
// refresh many accounts in parallel without bumping a real ceiling.
const REFRESH_LOCKS_MAX = 5000

/** Per-account in-flight lock. The future refreshAccessToken implementation
 *  MUST wrap its provider exchange + vault rotation in this. Subsequent
 *  concurrent callers await the first one's result instead of issuing
 *  parallel refresh exchanges (which can brick rotating-refresh providers). */
export async function withRefreshLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const existing = REFRESH_LOCKS.get(accountId) as Promise<T> | undefined
  if (existing) return existing
  if (REFRESH_LOCKS.size >= REFRESH_LOCKS_MAX) {
    // FIFO evict oldest entry. The orphaned promise still resolves and
    // attempts its finally-delete on a key that's already gone (no-op).
    // No correctness loss — the orphaned caller still sees its result.
    const firstKey = REFRESH_LOCKS.keys().next().value
    if (firstKey !== undefined) REFRESH_LOCKS.delete(firstKey)
  }
  const p = (async () => {
    try { return await fn() }
    finally { REFRESH_LOCKS.delete(accountId) }
  })()
  REFRESH_LOCKS.set(accountId, p)
  return p
}

export type RefreshResult =
  | { ok: true;  rotated_refresh: boolean; expires_at: number | null }
  | { ok: false; reason: 'revoked' | 'no_refresh_secret' | 'no_provider' | 'no_client_creds' | 'http_error' | 'parse_error' | 'no_account'; status?: number }

/**
 * R146.49 — canonical refresh implementation. Closes every hazard
 * enumerated in R146.48's comment block. Call sites:
 *   await refreshAccessToken({ workspaceId, accountId, requestedBy })
 * before any outbound provider call where the access token may have
 * expired (check account.metadata.expiresAt < now + safetyMargin).
 *
 * SECURITY INVARIANTS this function maintains:
 *   - Concurrent-refresh race          → withRefreshLock
 *   - Rotating refresh tokens          → rotates BOTH access AND refresh
 *                                        secrets when provider returns new
 *                                        refresh_token; access-only otherwise
 *   - Revoked refresh (400 inv_grant)  → marks account status='revoked',
 *                                        emits event, leaves vault rows alone
 *                                        so operator can investigate
 *   - Absolute expiry tracking         → stamps metadata.expiresAt
 *   - No token values in logs          → emits only { rotated_refresh, status }
 */
export async function refreshAccessToken(opts: {
  workspaceId: string
  accountId:   string
  requestedBy: string
}): Promise<RefreshResult> {
  return withRefreshLock(opts.accountId, async () => {
    const { getAccount, updateAccountStatus } = await import('./connectors.js')
    const { revealSecret, rotateSecret } = await import('./secrets-vault.js')
    const { db } = await import('../db/client.js')
    const { secretsVault, connectorAccounts, events } = await import('../db/schema.js')
    const { eq, and } = await import('drizzle-orm')

    const account = await getAccount(opts.workspaceId, opts.accountId)
    if (!account) return { ok: false, reason: 'no_account' }
    const provider = OAUTH_PROVIDERS[account.connectorId]
    if (!provider) return { ok: false, reason: 'no_provider' }
    const clientId     = process.env[provider.clientIdEnv]
    const clientSecret = process.env[provider.clientSecretEnv]
    if (!clientId || !clientSecret) return { ok: false, reason: 'no_client_creds' }

    // Locate refresh secret by name. completeCallback stored it as
    // `${connectorId}:${label}:refresh`.
    const refreshName = `${account.connectorId}:${account.label}:refresh`
    const refreshRows = await db.select({ id: secretsVault.id })
      .from(secretsVault)
      .where(and(eq(secretsVault.workspaceId, opts.workspaceId), eq(secretsVault.name, refreshName)))
      .limit(1).catch(() => [])
    const refreshRow = refreshRows[0]
    if (!refreshRow) return { ok: false, reason: 'no_refresh_secret' }

    const refreshPlain = await revealSecret(refreshRow.id, opts.requestedBy, 'oauth refresh')
    if (!refreshPlain) return { ok: false, reason: 'no_refresh_secret' }

    // R146.53 — bounded fetch. A provider that hangs without closing the
    // socket would otherwise pin a REFRESH_LOCKS entry forever; combined
    // with a synthetic burst that's the unbounded-map DoS class. 20s
    // is comfortably above any legit token-exchange RTT.
    const r = await fetch(provider.tokenUrl, {
      method:  'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshPlain,
        grant_type:    'refresh_token',
      }),
      signal:  AbortSignal.timeout(20_000),
    }).catch((e: Error) => {
      // Surface as parse_error rather than letting an AbortError or
      // network DNS failure escape the function and reject the lock.
      console.error('[connector-oauth] refresh fetch failed:', e.message)
      return null
    })
    if (!r) return { ok: false, reason: 'http_error' }
    if (!r.ok) {
      // 400 invalid_grant means the user revoked, or refresh TTL expired.
      // Mark account revoked + emit, but leave vault rows for forensics.
      if (r.status === 400 || r.status === 401) {
        if (account.secretRef) await updateAccountStatus(opts.workspaceId, account.id, 'revoked')
        await db.insert(events).values({
          id: uuidv7(), type: 'connector.refresh_revoked', workspaceId: opts.workspaceId,
          payload: { accountId: account.id, connectorId: account.connectorId, status: r.status },
          traceId: uuidv7(), correlationId: account.id, causationId: null,
          source: 'api/connector-oauth', version: 1, createdAt: Date.now(),
        }).catch((e: Error) => { console.error('[connector-oauth] revoked-emit:', e.message); return null })
        return { ok: false, reason: 'revoked', status: r.status }
      }
      return { ok: false, reason: 'http_error', status: r.status }
    }
    let tok: { access_token?: string; refresh_token?: string; expires_in?: number }
    try { tok = await r.json() as typeof tok } catch { return { ok: false, reason: 'parse_error' } }
    if (!tok.access_token) return { ok: false, reason: 'parse_error' }

    // Rotate access (always). Rotate refresh only when the provider
    // returned a new one — most rotating providers do; some (Slack,
    // some older Google flows) reuse the same refresh indefinitely.
    if (account.secretRef) {
      await rotateSecret(account.secretRef, tok.access_token, opts.requestedBy)
    }
    const rotated_refresh = !!tok.refresh_token && tok.refresh_token !== refreshPlain
    if (rotated_refresh) {
      await rotateSecret(refreshRow.id, tok.refresh_token!, opts.requestedBy)
    }

    // Stamp absolute expiry into account.metadata for proactive refresh.
    const expires_at = tok.expires_in ? Date.now() + (tok.expires_in * 1000) : null
    const newMeta = { ...(account.metadata as Record<string, unknown> ?? {}), expiresAt: expires_at }
    await db.update(connectorAccounts)
      .set({ metadata: newMeta, updatedAt: Date.now() })
      .where(eq(connectorAccounts.id, account.id))
      .catch((e: Error) => { console.error('[connector-oauth] meta-update:', e.message); return null })

    // Audit event — payload carries the metadata change ONLY, never the tokens.
    await db.insert(events).values({
      id: uuidv7(), type: 'connector.refresh_succeeded', workspaceId: opts.workspaceId,
      payload: { accountId: account.id, connectorId: account.connectorId, rotated_refresh, expires_at },
      traceId: uuidv7(), correlationId: account.id, causationId: null,
      source: 'api/connector-oauth', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[connector-oauth] success-emit:', e.message); return null })

    return { ok: true, rotated_refresh, expires_at }
  })
}

// ── Start ─────────────────────────────────────────────────────────────

export interface StartInput {
  workspaceId: string
  connectorId: string
  label:       string
  scopes?:     string[]
  permission?: Permission
  operatorId?: string
  /** Used to construct the redirect_uri sent to the provider. */
  apiBaseUrl:  string
}

export interface StartResult {
  state:        string
  authorizeUrl: string
}

/** R146.44 — RFC 7636 PKCE helper. base64url-encode SHA-256 of verifier. */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function buildStart(input: StartInput): StartResult {
  const provider = OAUTH_PROVIDERS[input.connectorId]
  if (!provider) throw new Error(`no OAuth provider config for '${input.connectorId}'`)
  const clientId = process.env[provider.clientIdEnv]
  if (!clientId) throw new Error(`env ${provider.clientIdEnv} not set — register an OAuth app first`)

  // 256 bits per OWASP recommendation for OAuth state. Previous 192 bits
  // was within tolerance but state doubles as a CSRF token so we use the
  // upper bound.
  const state = randomBytes(32).toString('hex')
  // R146.44 — PKCE. Per RFC 7636, the verifier is 43-128 chars from
  // [A-Z][a-z][0-9]-._~. 64 random bytes → base64url → ~86 chars, well
  // within range. Stored in PENDING so the callback can include it in
  // the token-exchange POST. Providers that don't honor code_challenge
  // ignore it harmlessly; providers that DO (Google, GitHub, Slack, all
  // modern ones) gain protection against authorization-code interception
  // — even if an attacker grabs the code from a referer leak or browser
  // history, they can't exchange it without the verifier we never expose.
  const codeVerifier  = randomBytes(64).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const codeChallenge = pkceChallenge(codeVerifier)
  pendingSet(state, {
    state,
    workspaceId: input.workspaceId,
    operatorId:  input.operatorId ?? 'default',
    label:       input.label,
    connectorId: input.connectorId,
    scopes:      input.scopes ?? provider.defaultScopes,
    permission:  input.permission ?? 'read',
    createdAt:   Date.now(),
    codeVerifier,
  })

  const redirectUri = `${input.apiBaseUrl}${provider.redirectPathOverride ?? '/api/v1/connectors/oauth/callback'}`
  const params = new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 (input.scopes ?? provider.defaultScopes).join(' '),
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    ...(provider.extraAuthParams ?? {}),
  })
  return {
    state,
    authorizeUrl: `${provider.authorizationUrl}?${params.toString()}`,
  }
}

// ── Callback (code → tokens → vault + account) ────────────────────────

export interface CallbackInput {
  state:      string
  code:       string
  apiBaseUrl: string
}

export interface CallbackResult {
  accountId:   string
  secretRef:   string
  connectorId: string
  workspaceId: string
  scopesGranted: string[]
}

interface TokenResponse {
  access_token:   string
  token_type?:    string
  scope?:         string
  refresh_token?: string
  expires_in?:    number
  // Slack
  authed_user?:   { id: string; access_token?: string; scope?: string }
  team?:          { id: string; name: string }
  // Google
  id_token?:      string
}

export async function completeCallback(input: CallbackInput): Promise<CallbackResult> {
  const pending = PENDING.get(input.state)
  if (!pending) throw new Error('unknown or expired state (start a new OAuth flow)')
  PENDING.delete(input.state)

  const provider = OAUTH_PROVIDERS[pending.connectorId]
  if (!provider) throw new Error(`no OAuth provider for '${pending.connectorId}'`)
  const clientId     = process.env[provider.clientIdEnv]
  const clientSecret = process.env[provider.clientSecretEnv]
  if (!clientId || !clientSecret) throw new Error(`OAuth env vars not set for '${pending.connectorId}'`)
  const redirectUri = `${input.apiBaseUrl}${provider.redirectPathOverride ?? '/api/v1/connectors/oauth/callback'}`

  // Exchange code → tokens. Most providers accept form-encoded; GitHub
  // also accepts JSON with the Accept header below.
  // R146.53 — same 20s timeout as the refresh path. Without it, a hung
  // provider tokenUrl would pin the API connection until the operator
  // notices their /callback hasn't returned.
  const resp = await fetch(provider.tokenUrl, {
    method:  'POST',
    headers: {
      'accept':       'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      code:          input.code,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
      // R146.44 — include PKCE verifier. Providers that issued the
      // code_challenge in the start flow require this; providers that
      // didn't ignore an unknown field. We only add it when present
      // so flows that started pre-R146.44 still complete.
      ...(pending.codeVerifier ? { code_verifier: pending.codeVerifier } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => {
    throw new Error(`OAuth token exchange network error: ${e.message}`)
  })
  if (!resp.ok) {
    // R146.65 — do NOT echo the provider response body into the error
    // message. A misconfigured provider could include the request body
    // (client_secret + refresh_token) in its 4xx response; that error
    // string then flows into errorHandler.send and reaches the operator
    // UI / logs. Keep the status code; drop the body.
    throw new Error(`OAuth token exchange failed with status ${resp.status}`)
  }
  const tok = await resp.json() as TokenResponse
  // Slack returns success in nested authed_user.access_token for v2;
  // most others return access_token at top level.
  const accessToken = tok.access_token ?? tok.authed_user?.access_token
  if (!accessToken) throw new Error('provider returned no access_token')

  // Store in vault. The access token is encrypted; refresh token (if any)
  // goes in its own vault row so reveals are tracked separately.
  const secretRef = await storeSecret({
    workspaceId: pending.workspaceId,
    name:        `${pending.connectorId}:${pending.label}:access`,
    provider:    pending.connectorId,
    value:       accessToken,
  })
  if (tok.refresh_token) {
    // FIX: previously swallowed via .catch((e: Error) => { console.error('[connector-oauth]', e.message); return null }). A failed refresh-token
    // persist means we have an access token expiring in ~1hr with no way to
    // refresh — silent auth break. Now throw so the OAuth flow returns
    // failure to the operator instead of pretending success.
    await storeSecret({
      workspaceId: pending.workspaceId,
      name:        `${pending.connectorId}:${pending.label}:refresh`,
      provider:    pending.connectorId,
      value:       tok.refresh_token,
    })
  }

  // Create the connector account
  const grantedScopes = tok.scope?.split(/[ ,]+/).filter(Boolean) ?? pending.scopes
  const account = await createAccount({
    workspaceId:      pending.workspaceId,
    connectorId:      pending.connectorId,
    label:            pending.label,
    // Use undefined (not `null as unknown as string`) — externalAccount
    // is optional in createAccount input, mapped to nullable column.
    ...(tok.team?.id ? { externalAccount: tok.team.id } : tok.authed_user?.id ? { externalAccount: tok.authed_user.id } : {}),
    secretRef,
    grantedScopes,
    permission:       pending.permission,
    createdBy:        pending.operatorId,
    metadata: {
      ...(tok.token_type ? { tokenType: tok.token_type } : {}),
      ...(tok.expires_in ? { expiresIn: tok.expires_in } : {}),
      ...(tok.team       ? { team: tok.team } : {}),
    },
  })

  await db.insert(events).values({
    id: uuidv7(), type: 'connector.oauth_completed',
    workspaceId: pending.workspaceId,
    payload: { connectorId: pending.connectorId, accountId: account.id, scopes: grantedScopes },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/connector-oauth', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[connector-oauth]', e.message); return null })

  return {
    accountId:     account.id,
    secretRef,
    connectorId:   pending.connectorId,
    workspaceId:   pending.workspaceId,
    scopesGranted: grantedScopes,
  }
}

// Suppress unused-import lint
void and; void eq; void gt; void lt
