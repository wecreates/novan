/**
 * chat-attachments.ts — multimodal chat input.
 *
 * Pure helpers. Validation + per-provider-family materialization. No DB.
 *
 * Wire shape stored on `messages.attachments`:
 *   { url: data: | https: , mime, kind, name?, sizeBytes? }
 *
 * Materialization converts a user-role ChatMsg with attachments into the
 * provider-native multimodal payload. The provider streamers in
 * chat-providers.ts check `msg.attachments?.length` and call the right
 * materializer below.
 */

export type AttachmentKind = 'image' | 'document' | 'reference'

export interface ChatAttachment {
  url:        string
  mime:       string
  kind:       AttachmentKind
  name?:      string
  sizeBytes?: number
}

// ─── Validation ────────────────────────────────────────────────────────

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
const ALLOWED_DOC_MIMES   = new Set(['application/pdf', 'text/plain', 'text/markdown'])
const MAX_DATA_URL_BYTES  = 6_000_000   // ~4.5 MB decoded; matches image-studio cap
const MAX_PER_MESSAGE     = 6

export interface ValidationResult {
  ok:           boolean
  reason?:      string
  attachments?: ChatAttachment[]
}

/** Validate a raw client payload. Rejects unknown mimes / oversize / >6 attachments. */
export function validateAttachments(raw: unknown): ValidationResult {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'attachments must be an array' }
  if (raw.length > MAX_PER_MESSAGE) return { ok: false, reason: `max ${MAX_PER_MESSAGE} attachments per message` }

  const out: ChatAttachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'attachment must be an object' }
    const it = item as Partial<ChatAttachment>
    const url  = typeof it.url  === 'string' ? it.url  : ''
    const mime = typeof it.mime === 'string' ? it.mime.toLowerCase() : ''
    const kind = typeof it.kind === 'string' ? it.kind : ''
    if (!url)  return { ok: false, reason: 'attachment.url required' }
    if (!mime) return { ok: false, reason: 'attachment.mime required' }
    // R146.50 — bound mime length. Flows into materializeAnthropic/Gemini
    // for non-image kinds as user-role text `[attached ${kind}: ${mime}]`.
    // Even though user-role content is model-RLHF protected, an unbounded
    // string blows past LLM context budgets and downstream storage caps.
    if (mime.length > 120) return { ok: false, reason: 'attachment.mime too long' }
    if (kind !== 'image' && kind !== 'document' && kind !== 'reference') {
      return { ok: false, reason: `attachment.kind must be image|document|reference (got ${kind})` }
    }
    // R146.50 — URL shape: data: or HTTPS only. Previous accepted http://
    // too; no legitimate use case (every LLM-provider image-fetch goes
    // through https), but a malicious provider-side image-fetcher could
    // be coaxed into hitting attacker http://internal targets resolvable
    // on the provider's infra (cloud metadata, etc — their problem, but
    // tightening the door is cheap).
    const isData  = url.startsWith('data:')
    const isHttps = /^https:\/\//i.test(url)
    if (!isData && !isHttps) return { ok: false, reason: 'attachment.url must be data: or https://' }
    if (isData && url.length > MAX_DATA_URL_BYTES) {
      return { ok: false, reason: `attachment too large (max ~${MAX_DATA_URL_BYTES} bytes base64)` }
    }
    // R146.50 — cross-check declared mime vs the mime carried INSIDE a
    // data: URL. An attacker who declares `mime: image/png` while the
    // body is `data:image/svg+xml;base64,...` would slip past the kind
    // allowlist (svg+xml not in ALLOWED_IMAGE_MIMES) and have the SVG
    // forwarded to the provider — SVGs can carry script. Reject mismatch.
    if (isData) {
      const inner = /^data:([^;,]+)/.exec(url)?.[1]?.toLowerCase()
      if (inner && inner !== mime) {
        return { ok: false, reason: `attachment.mime '${mime}' disagrees with data: URL mime '${inner}'` }
      }
    }
    if (kind === 'image' && !ALLOWED_IMAGE_MIMES.has(mime)) {
      return { ok: false, reason: `image mime not allowed: ${mime}` }
    }
    if (kind === 'document' && !ALLOWED_DOC_MIMES.has(mime)) {
      return { ok: false, reason: `document mime not allowed: ${mime}` }
    }
    const att: ChatAttachment = { url, mime, kind }
    if (typeof it.name      === 'string' && it.name.length    > 0) att.name      = it.name.slice(0, 200)
    if (typeof it.sizeBytes === 'number' && it.sizeBytes      > 0) att.sizeBytes = Math.floor(it.sizeBytes)
    out.push(att)
  }
  return { ok: true, attachments: out }
}

// ─── Per-family materialization ────────────────────────────────────────
// Returns the provider-native shape for the user message's `content` field.

/** OpenAI vision: `content` becomes an array of typed parts. */
export function materializeOpenAI(text: string, attachments: ChatAttachment[]): unknown {
  if (attachments.length === 0) return text
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text }]
  for (const a of attachments) {
    if (a.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: a.url } })
    }
    // documents currently inlined as a text reference — most OpenAI chat
    // completions endpoints don't accept arbitrary doc parts. Operator
    // can paste PDF text directly until we wire a vision-doc provider.
    else {
      parts.push({ type: 'text', text: `[attached ${a.kind}: ${a.name ?? a.mime}]` })
    }
  }
  return parts
}

/** Anthropic: `content` becomes an array with image source blocks. */
export function materializeAnthropic(text: string, attachments: ChatAttachment[]): unknown {
  if (attachments.length === 0) return text
  const blocks: Array<Record<string, unknown>> = []
  for (const a of attachments) {
    if (a.kind === 'image') {
      if (a.url.startsWith('data:')) {
        const { mime, data } = parseDataUrl(a.url)
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mime || a.mime, data } })
      } else {
        blocks.push({ type: 'image', source: { type: 'url', url: a.url } })
      }
    } else {
      blocks.push({ type: 'text', text: `[attached ${a.kind}: ${a.name ?? a.mime}]` })
    }
  }
  blocks.push({ type: 'text', text })
  return blocks
}

/** Gemini: user message becomes `{ role: 'user', parts: [...] }`. */
export function materializeGemini(text: string, attachments: ChatAttachment[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  for (const a of attachments) {
    if (a.kind === 'image' && a.url.startsWith('data:')) {
      const { mime, data } = parseDataUrl(a.url)
      parts.push({ inline_data: { mime_type: mime || a.mime, data } })
    } else if (a.kind === 'image') {
      // Gemini supports file_data with file_uri for hosted images; we
      // forward https URLs there. Provider may still reject if it can't
      // reach the host — that's a provider concern, not ours.
      parts.push({ file_data: { mime_type: a.mime, file_uri: a.url } })
    } else {
      parts.push({ text: `[attached ${a.kind}: ${a.name ?? a.mime}]` })
    }
  }
  parts.push({ text })
  return parts
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface ParsedDataUrl { mime: string; data: string }

/** Pull mime + base64 body out of `data:image/png;base64,XXXX`. */
export function parseDataUrl(url: string): ParsedDataUrl {
  // data:<mime>;base64,<data>
  const m = /^data:([^;,]+)(?:;base64)?,(.*)$/.exec(url)
  if (!m) return { mime: '', data: '' }
  return { mime: m[1] ?? '', data: m[2] ?? '' }
}

/** Does any attachment in the list require a vision-capable model? */
export function hasVisionAttachment(attachments: ChatAttachment[] | undefined | null): boolean {
  if (!attachments) return false
  return attachments.some(a => a.kind === 'image')
}
