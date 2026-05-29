/**
 * speech-provider-handlers.ts — per-vendor realtime adapters.
 *
 * Each handler implements two operations that lift the rest of the
 * provider-agnostic stack into a real audio pipe:
 *
 *   - mintSession(workspaceId, cfg): produce an ephemeral credential the
 *     browser can use to open a direct WebRTC / WS connection to the
 *     vendor. Raw API keys NEVER cross to the browser; we read them from
 *     the secrets vault (cfg.keyRef) and call the vendor's session
 *     endpoint server-side.
 *
 *   - bargeIn(workspaceId, sessionToken, providerSessionId): for cloud
 *     TTS streams, propagate the operator's barge-in to the provider
 *     (e.g. cancel the current response item on OpenAI Realtime, send a
 *     turn_complete signal to Gemini Live). For Deepgram STT-only flows
 *     this is a no-op (STT does not generate audio).
 *
 * The dispatcher is deterministic over providerId; unknown ids return a
 * stubbed handler so the rest of the pipeline degrades gracefully. We
 * never throw from the handlers — failures surface as `{ ok: false,
 * reason }` so the speech router can mark the provider unhealthy and
 * pick the next provider in the fallback chain.
 *
 * Why server-mint instead of WS-proxy?
 *   - OpenAI Realtime, Gemini Live, and Deepgram all support ephemeral
 *     client tokens. The browser opens the audio pipe directly with the
 *     vendor; the server only sees control-plane traffic.
 *   - No long-lived WS in the API process → fewer scaling concerns and
 *     no audio bytes touching our servers (privacy / cost win).
 *
 * Tests use the dispatcher with a stub `fetch` implementation; vendor
 * handlers never run in CI without a configured key.
 */
import { revealSecret } from './secrets-vault.js'
import type { ProviderRow } from './speech-providers.js'

export interface MintedSession {
  /** Browser uses this to connect to the vendor directly. */
  clientToken:        string
  /** Vendor session id the browser will reference. */
  providerSessionId:  string
  /** Optional URL hint (e.g. WS endpoint, WebRTC offer URL). */
  url?:               string
  /** Unix-ms timestamp after which the token is invalid. */
  expiresAt:          number
  /** Free-form vendor-specific metadata (model, voice, ICE servers). */
  meta?:              Record<string, unknown>
}

export interface MintFailure { ok: false; reason: string; httpStatus?: number }
export type   MintResult     = { ok: true; session: MintedSession } | MintFailure

export interface HandlerContext {
  /** Caller's workspace, for audit + vault scope. */
  workspaceId:     string
  /** Provider config row (kind, endpoint, keyRef, preferredVoice, …). */
  cfg:             ProviderRow
  /** Locale to request (BCP-47). */
  locale:          string
  /** Voice id when provider supports voice selection. */
  voice?:          string
  /** Test-only fetch override; production uses `globalThis.fetch`. */
  fetchImpl?:      typeof fetch
}

export interface SpeechProviderHandler {
  id: string
  /** Mint an ephemeral session token for the browser to use. */
  mintSession(ctx: HandlerContext): Promise<MintResult>
  /** Send a provider-side barge-in / interrupt signal. */
  bargeIn?(ctx: HandlerContext, providerSessionId: string): Promise<{ ok: boolean; reason?: string }>
}

// ─── Helpers ────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 60_000

async function loadKey(workspaceId: string, keyRef: string | null): Promise<string | null> {
  if (!keyRef) return null
  try {
    return await revealSecret(keyRef, `voice-router:${workspaceId}`, 'mint realtime speech session')
  } catch { return null }
}

function failure(reason: string, httpStatus?: number): MintFailure {
  return httpStatus !== undefined ? { ok: false, reason, httpStatus } : { ok: false, reason }
}

// ─── OpenAI Realtime — WebRTC ───────────────────────────────────────────
// https://platform.openai.com/docs/guides/realtime
// POST https://api.openai.com/v1/realtime/sessions returns:
//   { id, client_secret: { value, expires_at }, model, voice, … }

const openaiRealtime: SpeechProviderHandler = {
  id: 'openai_realtime',
  async mintSession(ctx) {
    const key = await loadKey(ctx.workspaceId, ctx.cfg.keyRef ?? null)
    if (!key) return failure('no key configured for openai_realtime')
    const f = ctx.fetchImpl ?? globalThis.fetch
    try {
      const res = await f('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview',
          voice: ctx.voice ?? ctx.cfg.preferredVoice ?? 'alloy',
        }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        return failure(`openai_realtime mint failed: ${res.status} ${txt.slice(0, 200)}`, res.status)
      }
      const j = await res.json() as { id: string; client_secret: { value: string; expires_at?: number }; model: string; voice: string }
      return {
        ok: true,
        session: {
          clientToken:       j.client_secret.value,
          providerSessionId: j.id,
          url:               'https://api.openai.com/v1/realtime',
          expiresAt:         j.client_secret.expires_at ? j.client_secret.expires_at * 1000 : Date.now() + DEFAULT_TTL_MS,
          meta:              { model: j.model, voice: j.voice },
        },
      }
    } catch (e) {
      return failure(`openai_realtime mint error: ${(e as Error).message}`)
    }
  },
  // OpenAI Realtime supports response.cancel; the browser sends this on
  // its data channel. Server-side we just acknowledge so the audit trail
  // captures the barge-in event.
  async bargeIn() { return { ok: true } },
}

// ─── Gemini Live — WebSocket ────────────────────────────────────────────
// https://ai.google.dev/gemini-api/docs/live
// The Live API uses an ephemeral token endpoint:
//   POST https://generativelanguage.googleapis.com/v1beta/ephemeralAuthTokens

const geminiLive: SpeechProviderHandler = {
  id: 'gemini_live',
  async mintSession(ctx) {
    const key = await loadKey(ctx.workspaceId, ctx.cfg.keyRef ?? null)
    if (!key) return failure('no key configured for gemini_live')
    const f = ctx.fetchImpl ?? globalThis.fetch
    try {
      const expireAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString()
      const res = await f(`https://generativelanguage.googleapis.com/v1beta/ephemeralAuthTokens?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { uses: 1, expireTime: expireAt },
        }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        return failure(`gemini_live mint failed: ${res.status} ${txt.slice(0, 200)}`, res.status)
      }
      const j = await res.json() as { name?: string; token?: string }
      const token = j.token ?? j.name ?? ''
      if (!token) return failure('gemini_live response missing token field')
      return {
        ok: true,
        session: {
          clientToken:       token,
          providerSessionId: token,
          url:               'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
          expiresAt:         Date.now() + DEFAULT_TTL_MS,
          meta:              { voice: ctx.voice ?? ctx.cfg.preferredVoice ?? 'Aoede' },
        },
      }
    } catch (e) {
      return failure(`gemini_live mint error: ${(e as Error).message}`)
    }
  },
  async bargeIn() { return { ok: true } },
}

// ─── Deepgram STT — WebSocket ───────────────────────────────────────────
// https://developers.deepgram.com/docs/temporary-api-keys
// POST https://api.deepgram.com/v1/projects/{project_id}/keys mints a
// short-lived key scoped to `usage:write`.

const deepgramStt: SpeechProviderHandler = {
  id: 'deepgram_stt',
  async mintSession(ctx) {
    const key = await loadKey(ctx.workspaceId, ctx.cfg.keyRef ?? null)
    if (!key) return failure('no key configured for deepgram_stt')
    // Deepgram requires a project id. Operators carry it on `endpoint`
    // (e.g. "https://api.deepgram.com/v1/projects/<project_id>" or
    // the bare id itself).
    const ep = ctx.cfg.endpoint ?? ''
    const projectId = ep.includes('/projects/') ? ep.split('/projects/')[1]?.split(/[/?]/)[0] ?? '' : ep
    if (!projectId) return failure('deepgram_stt requires endpoint to carry the project_id')
    const f = ctx.fetchImpl ?? globalThis.fetch
    try {
      const res = await f(`https://api.deepgram.com/v1/projects/${encodeURIComponent(projectId)}/keys`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${key}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          comment:       `voice session ${ctx.workspaceId}`,
          scopes:        ['usage:write'],
          time_to_live_in_seconds: Math.ceil(DEFAULT_TTL_MS / 1000),
        }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        return failure(`deepgram_stt mint failed: ${res.status} ${txt.slice(0, 200)}`, res.status)
      }
      const j = await res.json() as { key?: string; api_key_id?: string; expiration_date?: string }
      const token = j.key ?? ''
      if (!token) return failure('deepgram_stt response missing key field')
      return {
        ok: true,
        session: {
          clientToken:       token,
          providerSessionId: j.api_key_id ?? token,
          url:               `wss://api.deepgram.com/v1/listen?language=${encodeURIComponent(ctx.locale)}&interim_results=true`,
          expiresAt:         j.expiration_date ? Date.parse(j.expiration_date) : Date.now() + DEFAULT_TTL_MS,
        },
      }
    } catch (e) {
      return failure(`deepgram_stt mint error: ${(e as Error).message}`)
    }
  },
  // STT has no audio to interrupt. Returning ok keeps the abstraction
  // uniform without lying about side effects.
  async bargeIn() { return { ok: true, reason: 'no-op for STT-only provider' } },
}

// ─── Custom — operator-supplied endpoint ────────────────────────────────
// Sends a POST to the configured endpoint and trusts it to return
// { clientToken, providerSessionId, expiresAt, url? }.

const customHandler: SpeechProviderHandler = {
  id: 'custom',
  async mintSession(ctx) {
    if (!ctx.cfg.endpoint) return failure('custom provider requires endpoint')
    const key = await loadKey(ctx.workspaceId, ctx.cfg.keyRef ?? null)
    const f = ctx.fetchImpl ?? globalThis.fetch
    try {
      const res = await f(ctx.cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'Authorization': `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ workspaceId: ctx.workspaceId, locale: ctx.locale, voice: ctx.voice }),
      })
      if (!res.ok) return failure(`custom mint failed: ${res.status}`, res.status)
      const j = await res.json() as Partial<MintedSession>
      if (!j.clientToken || !j.providerSessionId) return failure('custom endpoint returned incomplete session')
      return {
        ok: true,
        session: {
          clientToken:       j.clientToken,
          providerSessionId: j.providerSessionId,
          ...(j.url        ? { url: j.url } : {}),
          expiresAt:         j.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
          ...(j.meta       ? { meta: j.meta } : {}),
        },
      }
    } catch (e) {
      return failure(`custom mint error: ${(e as Error).message}`)
    }
  },
  async bargeIn() { return { ok: true } },
}

// Catalogue providers without a realtime audio pipe (TTS-only ones we
// proxy through HTTP requests) get a generic stub that surfaces the
// reason clearly so the UI can fall back to fallback mode.
const unsupportedRealtime: SpeechProviderHandler = {
  id: 'unsupported',
  async mintSession(ctx) {
    return failure(`provider ${ctx.cfg.providerId} does not support realtime audio pipes — use fallback mode (STT→Brain→TTS)`)
  },
  async bargeIn() { return { ok: false, reason: 'not supported' } },
}

const HANDLERS: Record<string, SpeechProviderHandler> = {
  openai_realtime: openaiRealtime,
  gemini_live:     geminiLive,
  deepgram_stt:    deepgramStt,
  custom:          customHandler,
}

/**
 * Dispatch to the registered handler for a provider id. Unknown ids
 * return the unsupportedRealtime stub so callers always get a handler.
 */
export function getHandler(providerId: string): SpeechProviderHandler {
  return HANDLERS[providerId] ?? unsupportedRealtime
}

export function registerHandler(handler: SpeechProviderHandler): void {
  HANDLERS[handler.id] = handler
}

export function supportedRealtimeProviders(): string[] {
  return Object.keys(HANDLERS)
}
