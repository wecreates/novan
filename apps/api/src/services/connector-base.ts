/**
 * connector-base.ts — Shared OAuth + REST plumbing for platform connectors.
 *
 * Round 110 lays the groundwork the Etsy / Shopify / Printful /
 * Printify / YouTube / Instagram / TikTok / X connectors all need:
 *   - typed connector spec (auth method, scopes, base URL, rate limits)
 *   - OAuth2 authorisation-URL builder + exchange-code helper
 *   - token storage via existing connector-oauth.ts
 *   - REST client wrapper with fetchWithRetry + per-platform headers
 *   - rate-limit-aware request queue
 *
 * Honest scope:
 *   - This is the scaffold layer. Each platform's product-specific
 *     endpoints (list products, create listing, upload image, post
 *     comment, etc.) are wrapped per-connector module that imports
 *     from here.
 *   - OAuth flows require the operator to register a developer app
 *     on each platform AND set client_id/client_secret env vars.
 *     Novan does not (and cannot) ship platform OAuth credentials.
 */
import { fetchWithRetry } from './provider-retry.js'

export type AuthMethod = 'oauth2_authcode' | 'oauth2_clientcreds' | 'api_key' | 'personal_token'

export interface ConnectorSpec {
  id:                string
  name:              string
  authMethod:        AuthMethod
  authUrl?:          string
  tokenUrl?:         string
  scopes:            string[]
  baseUrl:           string
  /** Env var holding the OAuth client_id (operator sets in .env). */
  clientIdEnvVar?:   string
  clientSecretEnvVar?: string
  /** Per-second rate limit hint; client throttles to this. */
  rateLimitPerSec?:  number
  /** docs URL — surfaced to operator UI when they click "Connect ___" */
  docsUrl:           string
}

/** Build the authorisation URL the operator's browser visits to grant
 *  access. Caller supplies the redirect URI (Novan's /oauth/callback). */
export function buildOAuthAuthorizeUrl(input: {
  spec:         ConnectorSpec
  redirectUri:  string
  state:        string
  extraParams?: Record<string, string>
}): string | { error: string } {
  if (input.spec.authMethod !== 'oauth2_authcode') {
    return { error: `connector ${input.spec.id} does not use oauth2_authcode` }
  }
  if (!input.spec.authUrl) return { error: `connector ${input.spec.id} missing authUrl` }
  if (!input.spec.clientIdEnvVar) return { error: `connector ${input.spec.id} missing clientIdEnvVar` }
  const clientId = process.env[input.spec.clientIdEnvVar]
  if (!clientId) return { error: `env var ${input.spec.clientIdEnvVar} not set — operator must register a developer app on ${input.spec.name} and set this var` }
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  input.redirectUri,
    response_type: 'code',
    state:         input.state,
    scope:         input.spec.scopes.join(' '),
    ...input.extraParams,
  })
  return `${input.spec.authUrl}?${params.toString()}`
}

/** Exchange an OAuth code for tokens. */
export async function exchangeOAuthCode(input: {
  spec:         ConnectorSpec
  code:         string
  redirectUri:  string
}): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number; tokenType?: string } | { error: string }> {
  if (input.spec.authMethod !== 'oauth2_authcode') return { error: 'wrong auth method' }
  if (!input.spec.tokenUrl)          return { error: 'missing tokenUrl' }
  if (!input.spec.clientIdEnvVar)    return { error: 'missing clientIdEnvVar' }
  if (!input.spec.clientSecretEnvVar) return { error: 'missing clientSecretEnvVar' }
  const clientId     = process.env[input.spec.clientIdEnvVar]
  const clientSecret = process.env[input.spec.clientSecretEnvVar]
  if (!clientId)     return { error: `env var ${input.spec.clientIdEnvVar} not set` }
  if (!clientSecret) return { error: `env var ${input.spec.clientSecretEnvVar} not set` }

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code:          input.code,
    redirect_uri:  input.redirectUri,
    client_id:     clientId,
    client_secret: clientSecret,
  })

  const r = await fetchWithRetry(input.spec.id, input.spec.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!r.ok) return { error: `token exchange failed: status ${r.status}` }
  const text = await r.response.text()
  try {
    const j = JSON.parse(text) as {
      access_token?:  string
      refresh_token?: string
      expires_in?:    number
      token_type?:    string
    }
    if (!j.access_token) return { error: 'token response missing access_token' }
    return {
      accessToken:  j.access_token,
      ...(j.refresh_token !== undefined ? { refreshToken: j.refresh_token } : {}),
      ...(j.expires_in    !== undefined ? { expiresIn:    j.expires_in    } : {}),
      ...(j.token_type    !== undefined ? { tokenType:    j.token_type    } : {}),
    }
  } catch {
    return { error: `token response not JSON: ${text.slice(0, 200)}` }
  }
}

/** Per-platform request — uses fetchWithRetry + applies rate-limit
 *  throttling on a simple per-connector token-bucket. */
const _lastRequestAt: Record<string, number> = {}

export async function connectorRequest(input: {
  spec:        ConnectorSpec
  accessToken: string
  path:        string                  // appended to baseUrl
  method?:     'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  query?:      Record<string, string | number | boolean>
  body?:       unknown
  headers?:    Record<string, string>
}): Promise<{ ok: true; status: number; data: unknown } | { ok: false; error: string; status?: number }> {
  // Naive throttle: ensure ≥ (1000 / rateLimitPerSec) ms between calls.
  const rps = input.spec.rateLimitPerSec ?? 5
  const minGap = 1000 / rps
  const now = Date.now()
  const last = _lastRequestAt[input.spec.id] ?? 0
  if (now - last < minGap) {
    await new Promise(r => setTimeout(r, minGap - (now - last)))
  }
  _lastRequestAt[input.spec.id] = Date.now()

  const url = (() => {
    const base = input.spec.baseUrl.replace(/\/$/, '')
    const path = input.path.startsWith('/') ? input.path : `/${input.path}`
    if (!input.query) return `${base}${path}`
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(input.query)) qs.set(k, String(v))
    return `${base}${path}?${qs.toString()}`
  })()

  const r = await fetchWithRetry(input.spec.id, url, {
    method: input.method ?? 'GET',
    headers: {
      'Authorization': `Bearer ${input.accessToken}`,
      ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...input.headers,
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  })
  if (!r.ok) return { ok: false, error: `${input.spec.id} request failed (attempts ${r.attempts})`, status: r.status }
  const text = await r.response.text()
  let data: unknown = text
  try { data = JSON.parse(text) } catch { /* not JSON — keep string */ }
  return { ok: true, status: r.response.status, data }
}

/** Platform specs the rest of the connector modules import. Per-platform
 *  endpoint wrappers live in their own files (round 111-112). */
export const SPECS: Record<string, ConnectorSpec> = {
  etsy: {
    id: 'etsy', name: 'Etsy',
    authMethod: 'oauth2_authcode',
    authUrl:    'https://www.etsy.com/oauth/connect',
    tokenUrl:   'https://api.etsy.com/v3/public/oauth/token',
    scopes:     ['listings_r', 'listings_w', 'shops_r', 'shops_w', 'transactions_r', 'profile_r'],
    baseUrl:    'https://api.etsy.com/v3/application',
    clientIdEnvVar:     'ETSY_KEYSTRING',
    clientSecretEnvVar: 'ETSY_SHARED_SECRET',
    rateLimitPerSec:    10,
    docsUrl:    'https://developer.etsy.com/documentation/essentials/authentication/',
  },
  shopify: {
    id: 'shopify', name: 'Shopify',
    authMethod: 'oauth2_authcode',
    // Shopify shop-specific URL — the connector module substitutes
    // {shop} before invoking buildOAuthAuthorizeUrl.
    authUrl:    'https://{shop}.myshopify.com/admin/oauth/authorize',
    tokenUrl:   'https://{shop}.myshopify.com/admin/oauth/access_token',
    scopes:     ['read_products', 'write_products', 'read_orders', 'write_orders', 'read_customers', 'read_inventory', 'write_inventory'],
    baseUrl:    'https://{shop}.myshopify.com/admin/api/2024-10',
    clientIdEnvVar:     'SHOPIFY_API_KEY',
    clientSecretEnvVar: 'SHOPIFY_API_SECRET',
    rateLimitPerSec:    4,    // Shopify leaky bucket
    docsUrl:    'https://shopify.dev/docs/apps/auth/oauth',
  },
  printful: {
    id: 'printful', name: 'Printful',
    authMethod: 'oauth2_authcode',
    authUrl:    'https://www.printful.com/oauth/authorize',
    tokenUrl:   'https://www.printful.com/oauth/token',
    scopes:     ['orders', 'products', 'webhooks', 'sync_products'],
    baseUrl:    'https://api.printful.com',
    clientIdEnvVar:     'PRINTFUL_CLIENT_ID',
    clientSecretEnvVar: 'PRINTFUL_CLIENT_SECRET',
    rateLimitPerSec:    2,
    docsUrl:    'https://developers.printful.com/docs/',
  },
  printify: {
    id: 'printify', name: 'Printify',
    authMethod: 'personal_token',     // Printify uses personal access tokens, not OAuth
    scopes:     [],
    baseUrl:    'https://api.printify.com/v1',
    rateLimitPerSec: 10,
    docsUrl:    'https://developers.printify.com/',
  },
  youtube: {
    id: 'youtube', name: 'YouTube (Data API v3)',
    authMethod: 'oauth2_authcode',
    authUrl:    'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:   'https://oauth2.googleapis.com/token',
    scopes:     [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    baseUrl:    'https://www.googleapis.com/youtube/v3',
    clientIdEnvVar:     'GOOGLE_OAUTH_CLIENT_ID',
    clientSecretEnvVar: 'GOOGLE_OAUTH_CLIENT_SECRET',
    rateLimitPerSec:    10,
    docsUrl:    'https://developers.google.com/youtube/v3/guides/authentication',
  },
  instagram: {
    id: 'instagram', name: 'Instagram Graph API (via Meta)',
    authMethod: 'oauth2_authcode',
    authUrl:    'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl:   'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes:     ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'pages_show_list', 'pages_read_engagement'],
    baseUrl:    'https://graph.facebook.com/v21.0',
    clientIdEnvVar:     'META_APP_ID',
    clientSecretEnvVar: 'META_APP_SECRET',
    rateLimitPerSec:    4,
    docsUrl:    'https://developers.facebook.com/docs/instagram-api/',
  },
  tiktok: {
    id: 'tiktok', name: 'TikTok for Developers',
    authMethod: 'oauth2_authcode',
    authUrl:    'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl:   'https://open.tiktokapis.com/v2/oauth/token/',
    scopes:     ['user.info.basic', 'video.publish', 'video.upload', 'video.list'],
    baseUrl:    'https://open.tiktokapis.com/v2',
    clientIdEnvVar:     'TIKTOK_CLIENT_KEY',
    clientSecretEnvVar: 'TIKTOK_CLIENT_SECRET',
    rateLimitPerSec:    5,
    docsUrl:    'https://developers.tiktok.com/doc/login-kit-web/',
  },
  x: {
    id: 'x', name: 'X (formerly Twitter) API v2',
    authMethod: 'oauth2_authcode',
    authUrl:    'https://twitter.com/i/oauth2/authorize',
    tokenUrl:   'https://api.twitter.com/2/oauth2/token',
    scopes:     ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    baseUrl:    'https://api.twitter.com/2',
    clientIdEnvVar:     'X_CLIENT_ID',
    clientSecretEnvVar: 'X_CLIENT_SECRET',
    rateLimitPerSec:    3,
    docsUrl:    'https://developer.x.com/en/docs/authentication/oauth-2-0',
  },
}

/** Return a connector spec by id, or null. Used by the connectors
 *  route to surface "Connect ___" affordances + their docs URL. */
export function getConnectorSpec(id: string): ConnectorSpec | null {
  return SPECS[id] ?? null
}

/** Public listing of all known connectors + which env vars they need.
 *  Operator UI uses this to render the "Available connectors" tile
 *  and surface missing-env-var warnings. */
export function listConnectorSpecs(): Array<ConnectorSpec & { ready: boolean; missingEnv: string[] }> {
  return Object.values(SPECS).map(s => {
    const missingEnv: string[] = []
    if (s.clientIdEnvVar     && !process.env[s.clientIdEnvVar])     missingEnv.push(s.clientIdEnvVar)
    if (s.clientSecretEnvVar && !process.env[s.clientSecretEnvVar]) missingEnv.push(s.clientSecretEnvVar)
    return { ...s, ready: missingEnv.length === 0, missingEnv }
  })
}
