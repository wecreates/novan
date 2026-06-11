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
  name:        string
  pdfBase64?:  string
  pdfUrl?:     string
  maxPages?:   number       // hard cap to avoid huge PDFs
  perPageDoc?: boolean      // R641c: when true, ingest each page as its own RAG doc (preserves page boundaries for citations)
}

export interface PdfIngestResult {
  docId:        string
  docIds?:      string[]     // populated when perPageDoc=true
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
  const pageTexts: string[] = []
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
      pageTexts.push(text)
      if (text.length > 0) pagesParsed++
      page.cleanup()
    } catch {
      pageTexts.push('')   // keep page index aligned even on failure
    }
  }
  await doc.destroy()

  const { ingest } = await import('./r621-document-rag.js')

  if (input.perPageDoc) {
    // R641c — one RAG doc per page so retrieval cites [Page N] cleanly
    const docIds: string[] = []
    let totalChars = 0
    let totalChunks = 0
    let totalEmbedded = 0
    for (let i = 0; i < pageTexts.length; i++) {
      const t = pageTexts[i] ?? ''
      if (t.length < 50) continue
      try {
        const ing = await ingest(workspaceId, {
          name: `${input.name.slice(0, 180)} — page ${i + 1}/${pages}`,
          text: t,
          mime: 'application/pdf',
        })
        docIds.push(ing.docId)
        totalChars += t.length
        totalChunks += ing.chunksCount
        totalEmbedded += ing.embedded
      } catch { /* skip page */ }
    }
    if (docIds.length === 0) throw new Error('pdf extracted no usable text on any page')
    return {
      docId:       docIds[0] ?? '',
      docIds,
      pages,
      pagesParsed,
      textChars:   totalChars,
      chunksCount: totalChunks,
      embedded:    totalEmbedded,
    }
  }

  // Single-doc mode — preserve [Page N] markers between page bodies so
  // R621.query results still reference page numbers.
  const fullText = pageTexts.map((t, i) => t ? `[Page ${i + 1}]\n${t}` : '').filter(Boolean).join('\n\n').trim()
  if (fullText.length < 50) throw new Error('pdf extracted no usable text')

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
