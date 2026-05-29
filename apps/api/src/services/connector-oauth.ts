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

export function buildStart(input: StartInput): StartResult {
  const provider = OAUTH_PROVIDERS[input.connectorId]
  if (!provider) throw new Error(`no OAuth provider config for '${input.connectorId}'`)
  const clientId = process.env[provider.clientIdEnv]
  if (!clientId) throw new Error(`env ${provider.clientIdEnv} not set — register an OAuth app first`)

  // 256 bits per OWASP recommendation for OAuth state. Previous 192 bits
  // was within tolerance but state doubles as a CSRF token so we use the
  // upper bound.
  const state = randomBytes(32).toString('hex')
  pendingSet(state, {
    state,
    workspaceId: input.workspaceId,
    operatorId:  input.operatorId ?? 'default',
    label:       input.label,
    connectorId: input.connectorId,
    scopes:      input.scopes ?? provider.defaultScopes,
    permission:  input.permission ?? 'read',
    createdAt:   Date.now(),
  })

  const redirectUri = `${input.apiBaseUrl}${provider.redirectPathOverride ?? '/api/v1/connectors/oauth/callback'}`
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         (input.scopes ?? provider.defaultScopes).join(' '),
    state,
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
    }),
  })
  if (!resp.ok) {
    throw new Error(`OAuth token exchange ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`)
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
