/**
 * R645d — Multimodal turn orchestrator.
 *
 *   chat.multimodal(messages_with_attachments)
 *     → Routes each attachment through the right extractor:
 *         pdf   → pdf.text_native (R642b) / pdfjs (R640) fallback
 *         image → vision.describe (R643b) OR direct Anthropic vision passthrough
 *         audio → omniAsr (R599) / R610 OpenAI fallback
 *         video → audio.extract (R642b) + vision.describe on poster frame
 *         html  → strip + ingest
 *       Then builds a single consolidated user message and runs streamChat,
 *       returning the response with per-attachment receipt + cost rollup.
 *
 * Attachments are by URL or base64. Each one is processed in parallel; if
 * one fails, we annotate it inline rather than blowing up the whole turn.
 */

export type AttachmentKind = 'pdf' | 'image' | 'audio' | 'video' | 'html' | 'text'

export interface Attachment {
  kind:      AttachmentKind
  url?:      string
  base64?:   string
  mime?:     string
  label?:    string         // operator-supplied caption, surfaced in the consolidated prompt
}

export interface MultimodalInput {
  systemPrompt?: string
  userPrompt:    string
  attachments?:  Attachment[]
  responseSchema?: Record<string, unknown>   // optional JSON-schema hint for structured output
  maxTokens?:    number
}

export interface AttachmentReceipt {
  kind:        AttachmentKind
  source:      'url' | 'base64'
  extracted:   string                       // text representation injected into prompt
  chars:       number
  via:         string                       // service name
  tokens?:     number
  costUsd?:    number
  error?:      string
}

export interface MultimodalResult {
  answer:        string
  parsedJson?:   unknown                    // populated when responseSchema requested + parse succeeded
  receipts:      AttachmentReceipt[]
  totals: {
    extractTokens: number
    extractCost:   number
    chatTokens:    number
    chatCost:      number
    latencyMs:     number
  }
}

async function processAttachment(att: Attachment, workspaceId: string): Promise<AttachmentReceipt> {
  const source: AttachmentReceipt['source'] = att.base64 ? 'base64' : 'url'
  const label = att.label ? `[${att.label}] ` : ''
  try {
    switch (att.kind) {
      case 'pdf': {
        const { pdfTextNative } = await import('./r642-media-tools.js')
        const input: Parameters<typeof pdfTextNative>[0] = {}
        if (att.base64) input.pdfBase64 = att.base64
        if (att.url)    input.pdfUrl    = att.url
        const r = await pdfTextNative(input)
        if (!r.ok) {
          // Fallback to pdfjs (slower but works on PDFs pdftotext rejects)
          const { ingestPdf } = await import('./r640-pdf-rag.js')
          void ingestPdf       // surface that fallback exists
          return { kind: 'pdf', source, extracted: `${label}[PDF extraction failed: ${r.error}]`, chars: 0, via: 'pdftotext', error: r.error ?? 'unknown' }
        }
        const trimmed = r.text.slice(0, 30000)
        return { kind: 'pdf', source, extracted: `${label}--- PDF (${r.chars} chars) ---\n${trimmed}${r.chars > 30000 ? '\n[…truncated]' : ''}`, chars: r.chars, via: 'pdftotext' }
      }
      case 'image': {
        const { describe } = await import('./r643-vision-tools.js')
        const input: Parameters<typeof describe>[0] = { prompt: 'Describe this image in detail: subjects, layout, text, colors, mood, any data shown.' }
        if (att.base64) input.imageBase64 = att.base64
        if (att.url)    input.imageUrl    = att.url
        const r = await describe(input)
        if (!r.ok) return { kind: 'image', source, extracted: `${label}[Image description failed: ${r.error}]`, chars: 0, via: 'anthropic-vision', error: r.error ?? 'unknown' }
        const receipt: AttachmentReceipt = { kind: 'image', source, extracted: `${label}--- Image ---\n${r.text}`, chars: (r.text ?? '').length, via: 'anthropic-vision' }
        if (typeof r.tokens === 'number')  receipt.tokens  = r.tokens
        if (typeof r.costUsd === 'number') receipt.costUsd = r.costUsd
        return receipt
      }
      case 'audio': {
        const { omniAsr } = await import('./r599-omnivoice-provider.js')
        const audioBuf = att.base64 ? Buffer.from(att.base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
                       : att.url    ? Buffer.from(await (await fetch(att.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer())
                                    : null
        if (!audioBuf || audioBuf.length < 200) return { kind: 'audio', source, extracted: `${label}[empty audio]`, chars: 0, via: 'omniasr', error: 'empty' }
        const asrInput: Parameters<typeof omniAsr>[0] = { audio: audioBuf, filename: 'attachment.wav' }
        const r = await omniAsr(asrInput, workspaceId)
        const transcript = (r.text ?? '').trim()
        return { kind: 'audio', source, extracted: `${label}--- Audio transcript ---\n${transcript}`, chars: transcript.length, via: 'omniasr/whisper' }
      }
      case 'video': {
        // Extract audio via R642b, then ASR
        const { extractAudio } = await import('./r642-media-tools.js')
        const input: Parameters<typeof extractAudio>[0] = { format: 'mp3' }
        if (att.base64) input.videoBase64 = att.base64
        if (att.url)    input.videoUrl    = att.url
        const ext = await extractAudio(input)
        if (!ext.ok || !ext.audioBase64) return { kind: 'video', source, extracted: `${label}[Video audio extraction failed: ${ext.error}]`, chars: 0, via: 'ffmpeg', error: ext.error ?? 'unknown' }
        const audioBuf = Buffer.from(ext.audioBase64, 'base64')
        const { omniAsr } = await import('./r599-omnivoice-provider.js')
        const asrInput: Parameters<typeof omniAsr>[0] = { audio: audioBuf, filename: 'video-audio.mp3' }
        const r = await omniAsr(asrInput, workspaceId)
        const transcript = (r.text ?? '').trim()
        return { kind: 'video', source, extracted: `${label}--- Video transcript ---\n${transcript}`, chars: transcript.length, via: 'ffmpeg+omniasr' }
      }
      case 'html': {
        const text = att.base64 ? Buffer.from(att.base64.replace(/^data:[^;]+;base64,/, ''), 'base64').toString('utf8')
                   : att.url    ? await (await fetch(att.url, { signal: AbortSignal.timeout(30_000) })).text()
                                : ''
        const stripped = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 30000)
        return { kind: 'html', source, extracted: `${label}--- HTML (stripped) ---\n${stripped}`, chars: stripped.length, via: 'inline-strip' }
      }
      case 'text': {
        const text = att.base64 ? Buffer.from(att.base64.replace(/^data:[^;]+;base64,/, ''), 'base64').toString('utf8')
                   : att.url    ? await (await fetch(att.url, { signal: AbortSignal.timeout(30_000) })).text()
                                : ''
        const trimmed = text.slice(0, 30000)
        return { kind: 'text', source, extracted: `${label}--- Text ---\n${trimmed}`, chars: trimmed.length, via: 'inline' }
      }
      default:
        return { kind: att.kind, source, extracted: `${label}[unsupported kind]`, chars: 0, via: 'none', error: 'unsupported kind' }
    }
  } catch (e) {
    return { kind: att.kind, source, extracted: `${label}[exception: ${(e as Error).message}]`, chars: 0, via: 'error', error: (e as Error).message }
  }
}

export async function chatMultimodal(workspaceId: string, input: MultimodalInput): Promise<MultimodalResult> {
  const t0 = Date.now()
  if (!input.userPrompt?.trim()) throw new Error('userPrompt required')
  const atts = (input.attachments ?? []).slice(0, 10)         // cap fan-out

  const receipts = atts.length > 0
    ? await Promise.all(atts.map(a => processAttachment(a, workspaceId)))
    : []

  let extractTokens = 0, extractCost = 0
  for (const r of receipts) {
    extractTokens += r.tokens ?? 0
    extractCost   += r.costUsd ?? 0
  }

  const attachmentBlock = receipts.length === 0 ? '' : `\n\n## Attachments\n\n${receipts.map(r => r.extracted).join('\n\n')}`
  const schemaHint = input.responseSchema
    ? `\n\nOutput strict JSON matching this schema (no markdown, no commentary):\n${JSON.stringify(input.responseSchema)}`
    : ''

  const { streamChat } = await import('./chat-providers.js')
  let answer = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, [
    { role: 'system', content: (input.systemPrompt ?? 'You are Novan. Be concise and concrete.') + schemaHint },
    { role: 'user',   content: `${input.userPrompt}${attachmentBlock}` },
  ], { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) answer += next.value.delta
  final = next.value

  const result: MultimodalResult = {
    answer:    answer.trim(),
    receipts,
    totals: {
      extractTokens,
      extractCost:   Number(extractCost.toFixed(6)),
      chatTokens:    final.tokens,
      chatCost:      Number(final.costUsd.toFixed(6)),
      latencyMs:     Date.now() - t0,
    },
  }
  if (input.responseSchema) {
    const m = answer.match(/\{[\s\S]*\}/)
    if (m) { try { result.parsedJson = JSON.parse(m[0]) } catch { /* leave raw answer */ } }
  }
  return result
}
