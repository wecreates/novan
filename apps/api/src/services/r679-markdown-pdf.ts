/**
 * R679 — Markdown → PDF.
 *
 * Renders markdown to clean HTML, pipes through headless chromium to print
 * a paginated PDF, persists to S3 via R616. Useful for the agent ecosystem:
 * "write a research summary then return a downloadable PDF".
 *
 * Container ships chromium at /usr/bin/chromium. No heavyweight dep
 * beyond what's already installed.
 */
import { spawn } from 'child_process'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

export interface PdfInput {
  markdown: string
  title?:   string
  /** Page size: 'A4' (default), 'Letter', 'Legal'. */
  format?:  'A4' | 'Letter' | 'Legal'
  /** Margin in CSS units (default '24mm'). */
  margin?:  string
  /** Save to S3 via R616 (default true). */
  persist?: boolean
}

export interface PdfResult {
  ok:        boolean
  assetId?:  string
  publicUrl?: string
  bytes?:    number
  pages?:    number
  latencyMs: number
  error?:    string
}

// Very small markdown subset — headings, paragraphs, bold/italic, code,
// fenced code blocks, lists, links. Enough for agent-generated reports
// without pulling in marked or remark.
function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let codeBuf: string[] = []
  let listStack: Array<'ul' | 'ol'> = []
  let paraBuf: string[] = []

  const flushPara = () => {
    if (paraBuf.length === 0) return
    let txt = esc(paraBuf.join(' '))
    txt = txt
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    out.push(`<p>${txt}</p>`)
    paraBuf = []
  }
  const closeLists = (toDepth = 0) => {
    while (listStack.length > toDepth) {
      const tag = listStack.pop()!
      out.push(`</${tag}>`)
    }
  }

  for (const line of lines) {
    if (inCode) {
      if (line.startsWith('```')) {
        out.push(`<pre class="lang-${esc(codeLang)}"><code>${esc(codeBuf.join('\n'))}</code></pre>`)
        inCode = false; codeBuf = []; codeLang = ''
      } else { codeBuf.push(line) }
      continue
    }
    if (line.startsWith('```')) {
      flushPara(); closeLists()
      inCode = true; codeLang = line.slice(3).trim()
      continue
    }
    const headMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headMatch) {
      flushPara(); closeLists()
      const level = headMatch[1]!.length
      out.push(`<h${level}>${esc(headMatch[2]!)}</h${level}>`)
      continue
    }
    const ulMatch = line.match(/^(\s*)[*-]\s+(.+)$/)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/)
    if (ulMatch || olMatch) {
      flushPara()
      const tag = ulMatch ? 'ul' : 'ol'
      if (listStack[listStack.length - 1] !== tag) {
        closeLists()
        out.push(`<${tag}>`)
        listStack.push(tag)
      }
      out.push(`<li>${esc((ulMatch ?? olMatch)![2]!)}</li>`)
      continue
    }
    if (line.trim() === '') {
      flushPara(); closeLists()
      continue
    }
    paraBuf.push(line)
  }
  flushPara(); closeLists()
  return out.join('\n')
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<style>
  @page { margin: 0; }
  body { font: 11pt/1.55 -apple-system,Segoe UI,sans-serif; color: #1a1a1a; max-width: 720px; margin: 0 auto; padding: 0 }
  h1 { font-size: 22pt; margin: 0 0 0.5em; }
  h2 { font-size: 16pt; margin: 1.5em 0 0.4em; border-bottom: 1px solid #ddd; padding-bottom: 0.2em }
  h3 { font-size: 13pt; margin: 1.2em 0 0.3em }
  p { margin: 0.6em 0 }
  pre { background: #f6f6f8; border: 1px solid #e0e0e6; border-radius: 4px; padding: 8px 12px; font: 9.5pt/1.45 Menlo,Consolas,monospace; overflow: hidden; white-space: pre-wrap }
  code { background: #f0f0f4; padding: 1px 4px; border-radius: 3px; font: 9.5pt Menlo,Consolas,monospace }
  pre code { background: transparent; padding: 0 }
  ul,ol { padding-left: 1.4em; margin: 0.6em 0 }
  li { margin: 0.2em 0 }
  a { color: #2a6bd0; text-decoration: none }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0 }
</style></head>
<body>${body}</body></html>`
}

export async function markdownToPdf(workspaceId: string, input: PdfInput): Promise<PdfResult> {
  const t0 = Date.now()
  if (!input.markdown?.trim()) return { ok: false, error: 'markdown required', latencyMs: 0 }

  const title = input.title ?? 'Document'
  const format = input.format ?? 'A4'
  const margin = input.margin ?? '24mm'
  const html = htmlShell(title.replace(/[<>]/g, ''), mdToHtml(input.markdown))

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'r679-'))
  const htmlPath = path.join(tmp, 'doc.html')
  const pdfPath  = path.join(tmp, 'doc.pdf')
  try {
    await writeFile(htmlPath, html, 'utf8')

    // Headless chromium → PDF
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      `--print-to-pdf=${pdfPath}`,
      `--print-to-pdf-no-header`,
      `--virtual-time-budget=2000`,
      `--paper-width=${format === 'Letter' ? 8.5 : format === 'Legal' ? 8.5 : 8.27}`,
      `--paper-height=${format === 'Letter' ? 11 : format === 'Legal' ? 14 : 11.69}`,
      `file://${htmlPath}`,
    ]
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('/usr/bin/chromium', args, { stdio: 'ignore' })
      const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* ignore */ } reject(new Error('chromium timeout')) }, 30_000)
      proc.on('exit', (code) => { clearTimeout(killer); code === 0 ? resolve() : reject(new Error(`chromium exit ${code}`)) })
      proc.on('error', reject)
    })

    const pdf = await readFile(pdfPath)
    let assetId: string | undefined
    let publicUrl: string | undefined
    const wantPersist = input.persist !== false
    if (wantPersist) {
      try {
        const { persistAsset } = await import('./r616-asset-persistence.js')
        const a = await persistAsset({
          workspaceId, kind: 'document', mime: 'application/pdf', bytes: pdf,
          prompt: title,
          metadata: { provider: 'chromium', format, margin },
        } as Parameters<typeof persistAsset>[0])
        if (a?.id) assetId = a.id
        if (a?.publicUrl) publicUrl = a.publicUrl
      } catch { /* tolerated */ }
    }

    // Rough page count from PDF count of /Type /Page entries
    const pageMatches = pdf.toString('binary').match(/\/Type\s*\/Page[^s]/g)
    const pages = pageMatches?.length ?? 1

    const result: PdfResult = {
      ok: true, bytes: pdf.length, pages,
      latencyMs: Date.now() - t0,
    }
    if (assetId)   result.assetId   = assetId
    if (publicUrl) result.publicUrl = publicUrl
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 }
  } finally {
    try { await rm(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
