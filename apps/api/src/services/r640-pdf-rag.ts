/**
 * R640 — PDF ingestion for RAG (E1).
 *
 * Reuses R621's chunk + embed + store pipeline. This module adds
 * just the PDF text extraction step on top, via pdfjs-dist (pure JS,
 * no native bindings — runs cleanly in Docker on alpine).
 *
 * Surface:
 *   rag.ingest_pdf — accept pdfBase64 or pdfUrl + name, extract text,
 *                    pass to R621.ingest.
 */
import { Buffer } from 'node:buffer'

export interface PdfIngestInput {
  name:       string
  pdfBase64?: string
  pdfUrl?:    string
  maxPages?:  number       // hard cap to avoid huge PDFs
}

export interface PdfIngestResult {
  docId:        string
  pages:        number
  pagesParsed:  number
  textChars:    number
  chunksCount:  number
  embedded:     number
}

async function loadPdfJs() {
  // pdfjs-dist uses workers internally; in Node we use the legacy build
  // which is single-threaded and runs without a worker URL.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs
}

async function resolvePdfBytes(input: PdfIngestInput): Promise<Buffer> {
  if (input.pdfBase64) {
    const stripped = input.pdfBase64.replace(/^data:[^;]+;base64,/, '')
    return Buffer.from(stripped, 'base64')
  }
  if (input.pdfUrl) {
    const r = await fetch(input.pdfUrl, { signal: AbortSignal.timeout(60_000) })
    if (!r.ok) throw new Error(`pdf fetch ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  throw new Error('pdfBase64 or pdfUrl required')
}

export async function ingestPdf(workspaceId: string, input: PdfIngestInput): Promise<PdfIngestResult> {
  if (!input.name?.trim()) throw new Error('name required')
  const bytes = await resolvePdfBytes(input)
  if (bytes.length < 100) throw new Error('pdf too small / invalid')
  if (bytes.length > 50 * 1024 * 1024) throw new Error('pdf >50MB — split first')

  const pdfjs = await loadPdfJs()
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts:    true,
    disableFontFace:   true,
    standardFontDataUrl: undefined,
    isEvalSupported:   false,
  } as Parameters<typeof pdfjs.getDocument>[0])
  const doc = await loadingTask.promise

  const pages = doc.numPages
  const cap = Math.max(1, Math.min(pages, input.maxPages ?? 200))
  const chunks: string[] = []
  let pagesParsed = 0

  for (let i = 1; i <= cap; i++) {
    try {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = (content.items as Array<{ str?: string }>)
        .map(it => it.str ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text.length > 0) chunks.push(`[Page ${i}]\n${text}`)
      pagesParsed++
      page.cleanup()
    } catch { /* skip malformed page */ }
  }
  await doc.destroy()

  const fullText = chunks.join('\n\n').trim()
  if (fullText.length < 50) throw new Error('pdf extracted no usable text')

  const { ingest } = await import('./r621-document-rag.js')
  const ing = await ingest(workspaceId, {
    name: input.name.slice(0, 200),
    text: fullText,
    mime: 'application/pdf',
  })

  return {
    docId:       ing.docId,
    pages,
    pagesParsed,
    textChars:   fullText.length,
    chunksCount: ing.chunksCount,
    embedded:    ing.embedded,
  }
}
