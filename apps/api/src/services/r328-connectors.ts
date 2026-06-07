/**
 * R146.328 — connector OAuth scaffold (#5).
 *
 * Receives the OAuth callback from a connector provider, exchanges code
 * for tokens, drops the secret into secrets_vault, registers in
 * connector_credentials. Currently scaffolded for Slack/Gmail/Discord
 * shape; provider-specific exchange URLs filled per integration.
 *
 * Operator flow:
 *   1. UI hits /api/v1/oauth/:connectorId/start  → returns a redirect URL
 *   2. Operator authorizes at provider
 *   3. Provider redirects to /api/v1/oauth/:connectorId/callback?code=...
 *   4. We exchange + persist + redirect operator back to /connectors
 */
export interface OAuthConfig {
  authUrl:     string
  tokenUrl:    string
  scopes:      string[]
  // env names that hold the registered client id/secret
  clientIdEnv: string
  clientSecretEnv: string
  // Printful uses non-standard `redirect_url` instead of the OAuth2 `redirect_uri`.
  // Default 'redirect_uri'; override per-provider as needed.
  redirectParamName?: string
}

export const OAUTH_PROVIDERS: Record<string, OAuthConfig> = {
  printful: {
    authUrl:  'https://www.printful.com/oauth/authorize',
    tokenUrl: 'https://www.printful.com/oauth/token',
    scopes:   ['orders', 'sync_products', 'file_library', 'webhooks'],
    clientIdEnv:     'PRINTFUL_CLIENT_ID',
    clientSecretEnv: 'PRINTFUL_CLIENT_SECRET',
    redirectParamName: 'redirect_url',   // Printful-specific
  },
  etsy: {
    authUrl:  'https://www.etsy.com/oauth/connect',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
    scopes:   ['listings_w', 'shops_r', 'transactions_r', 'email_r'],
    clientIdEnv:     'ETSY_CLIENT_ID',
    clientSecretEnv: 'ETSY_CLIENT_SECRET',
  },
  slack: {
    authUrl:  'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes:   ['chat:write', 'channels:read', 'im:history'],
    clientIdEnv:     'SLACK_CLIENT_ID',
    clientSecretEnv: 'SLACK_CLIENT_SECRET',
  },
  gmail: {
    authUrl:  'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes:   ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    clientIdEnv:     'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
  calendar: {
    authUrl:  'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes:   ['https://www.googleapis.com/auth/calendar.readonly'],
    clientIdEnv:     'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET',
  },
}

export interface StartFlowResult {
  ok:        boolean
  redirectUrl?: string
  reason?:   string
  state?:    string
}

import { randomBytes, createHmac } from 'node:crypto'

export function startFlow(input: {
  connectorId: string
  workspaceId: string
  redirectBase: string
}): StartFlowResult {
  const cfg = OAUTH_PROVIDERS[input.connectorId]
  if (!cfg) return { ok: false, reason: `no OAuth config for ${input.connectorId}` }
  const clientId = process.env[cfg.clientIdEnv]
  if (!clientId) return { ok: false, reason: `${cfg.clientIdEnv} not configured — operator must set in env` }
  const nonce = randomBytes(16).toString('hex')
  const state = `${input.workspaceId}.${nonce}.${signState(input.workspaceId, nonce)}`
  const redirectParam = cfg.redirectParamName ?? 'redirect_uri'
  const params = new URLSearchParams({
    client_id:     clientId,
    [redirectParam]: `${input.redirectBase}/api/v1/oauth/${input.connectorId}/callback`,
    scope:         cfg.scopes.join(' '),
    state,
    response_type: 'code',
    access_type:   'offline',
    prompt:        'consent',
  })
  return { ok: true, redirectUrl: `${cfg.authUrl}?${params.toString()}`, state }
}

function signState(workspaceId: string, nonce: string): string {
  const secret = process.env['AUTH_SECRET'] ?? ''
  return createHmac('sha256', secret).update(`${workspaceId}.${nonce}`).digest('hex').slice(0, 16)
}

export function verifyState(state: string): { ok: boolean; workspaceId?: string } {
  const parts = state.split('.')
  if (parts.length !== 3) return { ok: false }
  const [ws, nonce, sig] = parts
  if (!ws || !nonce || !sig) return { ok: false }
  const expected = signState(ws, nonce)
  if (sig !== expected) return { ok: false }
  return { ok: true, workspaceId: ws }
}

export interface ExchangeResult {
  ok:           boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?:   number
  reason?:      string
}

export async function exchangeCode(input: {
  connectorId: string
  code:        string
  redirectBase: string
}): Promise<ExchangeResult> {
  const cfg = OAUTH_PROVIDERS[input.connectorId]
  if (!cfg) return { ok: false, reason: `no OAuth config for ${input.connectorId}` }
  const clientId     = process.env[cfg.clientIdEnv]
  const clientSecret = process.env[cfg.clientSecretEnv]
  if (!clientId || !clientSecret) {
    return { ok: false, reason: `${cfg.clientIdEnv} and ${cfg.clientSecretEnv} must both be set` }
  }
  try {
    const redirectParam = cfg.redirectParamName ?? 'redirect_uri'
    const body = new URLSearchParams({
      code:          input.code,
      client_id:     clientId,
      client_secret: clientSecret,
      [redirectParam]: `${input.redirectBase}/api/v1/oauth/${input.connectorId}/callback`,
      grant_type:    'authorization_code',
    })
    const res = await fetch(cfg.tokenUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal:  AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200)
      return { ok: false, reason: `provider returned ${res.status}: ${text}` }
    }
    const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!j.access_token) return { ok: false, reason: 'provider returned no access_token' }
    const result: ExchangeResult = { ok: true, accessToken: j.access_token }
    if (j.refresh_token) result.refreshToken = j.refresh_token
    if (j.expires_in) result.expiresIn = j.expires_in
    return result
  } catch (e) {
    return { ok: false, reason: `exchange failed: ${(e as Error).message}` }
  }
}
