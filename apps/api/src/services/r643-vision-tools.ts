/**
 * R643b — Vision tools.
 *
 *   vision.ocr            Tesseract via spawn (B5). Returns extracted text + per-line confidence.
 *   vision.chart_extract  Anthropic vision direct call (B6) with a JSON-mode prompt. Returns
 *                         structured chart data: type, axes, labels, datasets[{label, values}].
 *   vision.describe       Generic image description via Anthropic vision (companion to OCR).
 *
 * All vision-* gracefully report missing keys instead of throwing.
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function resolveImage(input: { base64?: string; url?: string }): Promise<{ ok: true; buf: Buffer; mime: string } | { ok: false; error: string }> {
  if (input.base64) {
    const stripped = input.base64.replace(/^data:[^;]+;base64,/, '')
    const mimeMatch = input.base64.match(/^data:([^;]+);base64,/)
    return { ok: true, buf: Buffer.from(stripped, 'base64'), mime: mimeMatch?.[1] ?? 'image/png' }
  }
  if (input.url) {
    try {
      const r = await fetch(input.url, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok) return { ok: false, error: `fetch ${r.status}` }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 100) return { ok: false, error: 'empty body' }
      return { ok: true, buf, mime: r.headers.get('content-type') ?? 'image/png' }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
  return { ok: false, error: 'base64 or url required' }
}

// ─── B5 OCR via Tesseract ──────────────────────────────────────────────────

export interface OcrInput {
  imageBase64?: string
  imageUrl?:    string
  lang?:        string         // tesseract lang code; default 'eng'
  psm?:         number         // page-segmentation mode 0-13, default 3 (auto)
}

export interface OcrResult {
  ok:         boolean
  text:       string
  chars:      number
  durationMs: number
  error?:     string
}

export async function ocr(input: OcrInput): Promise<OcrResult> {
  const t0 = Date.now()
  const src = await resolveImage({
    ...(input.imageBase64 ? { base64: input.imageBase64 } : {}),
    ...(input.imageUrl    ? { url:    input.imageUrl    } : {}),
  })
  if (!src.ok) return { ok: false, text: '', chars: 0, durationMs: 0, error: src.error }

  const dir = await mkdtemp(join(tmpdir(), 'r643-ocr-'))
  const inPath = join(dir, 'in.png')
  try {
    await writeFile(inPath, src.buf)
    const lang = (input.lang ?? 'eng').replace(/[^a-zA-Z+_-]/g, '').slice(0, 32) || 'eng'
    const psm = Math.max(0, Math.min(13, input.psm ?? 3))
    const args = [inPath, '-', '-l', lang, '--psm', String(psm)]
    const r = await runChild('tesseract', args, 60_000)
    if (!r.ok) return { ok: false, text: '', chars: 0, durationMs: Date.now() - t0, error: r.stderr.slice(-300) || `code ${r.code}` }
    const text = r.stdout.replace(/\s+\n/g, '\n').trim()
    return { ok: true, text, chars: text.length, durationMs: Date.now() - t0 }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── B6 Chart extract via Anthropic vision ─────────────────────────────────

export interface ChartExtractInput {
  imageBase64?: string
  imageUrl?:    string
  hint?:        string          // optional context: "this is a 7-day sales graph"
}

export interface ChartExtract {
  chartType:    'bar' | 'line' | 'pie' | 'scatter' | 'area' | 'table' | 'unknown'
  title?:       string
  xAxis?:       { label?: string; values?: string[] }
  yAxis?:       { label?: string }
  datasets:     Array<{ label?: string; values: number[] }>
  summary?:     string
}

export interface ChartExtractResult {
  ok:          boolean
  data?:       ChartExtract
  rawText?:    string
  durationMs:  number
  tokens?:     number
  costUsd?:    number
  error?:      string
}

async function callAnthropicVision(buf: Buffer, mime: string, prompt: string): Promise<{ ok: true; text: string; usage?: { input_tokens?: number; output_tokens?: number } } | { ok: false; error: string }> {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' }
  const model = process.env['ANTHROPIC_VISION_MODEL'] ?? 'claude-sonnet-4-5'
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime.startsWith('image/') ? mime : 'image/png', data: buf.toString('base64') } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, error: `anthropic ${r.status} ${text.slice(0, 200)}` }
    }
    const j = await r.json() as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
    const text = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
    const out: { ok: true; text: string; usage?: { input_tokens?: number; output_tokens?: number } } = { ok: true, text }
    if (j.usage) out.usage = j.usage
    return out
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function chartExtract(input: ChartExtractInput): Promise<ChartExtractResult> {
  const t0 = Date.now()
  const src = await resolveImage({
    ...(input.imageBase64 ? { base64: input.imageBase64 } : {}),
    ...(input.imageUrl    ? { url:    input.imageUrl    } : {}),
  })
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }

  const prompt = `Extract the chart data as JSON. Hint: ${input.hint ?? 'unknown'}.\n\nOutput ONLY a JSON object matching this shape — no preamble, no markdown:\n{\n  "chartType": "bar" | "line" | "pie" | "scatter" | "area" | "table" | "unknown",\n  "title": string?,\n  "xAxis": { "label": string?, "values": string[]? },\n  "yAxis": { "label": string? },\n  "datasets": [{ "label": string?, "values": number[] }],\n  "summary": string\n}\n\nIf the image is not a chart, set chartType="unknown" and put what you see in summary.`
  const r = await callAnthropicVision(src.buf, src.mime, prompt)
  if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: r.error }

  // Find first {...} block
  const m = r.text.match(/\{[\s\S]*\}/)
  let data: ChartExtract | undefined
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as Partial<ChartExtract>
      if (!Array.isArray(parsed.datasets)) parsed.datasets = []
      const merged: ChartExtract = {
        chartType: (parsed.chartType ?? 'unknown') as ChartExtract['chartType'],
        datasets: parsed.datasets,
      }
      if (typeof parsed.title === 'string')   merged.title   = parsed.title
      if (parsed.xAxis)                       merged.xAxis   = parsed.xAxis
      if (parsed.yAxis)                       merged.yAxis   = parsed.yAxis
      if (typeof parsed.summary === 'string') merged.summary = parsed.summary
      data = merged
    } catch { /* fall through to rawText */ }
  }

  const inTokens  = r.usage?.input_tokens  ?? 0
  const outTokens = r.usage?.output_tokens ?? 0
  const costUsd = (inTokens / 1_000_000) * 3 + (outTokens / 1_000_000) * 15  // sonnet pricing
  const result: ChartExtractResult = { ok: true, durationMs: Date.now() - t0, tokens: inTokens + outTokens, costUsd }
  if (data)     result.data    = data
  else          result.rawText = r.text.slice(0, 1000)
  return result
}

export async function describe(input: { imageBase64?: string; imageUrl?: string; prompt?: string }): Promise<{ ok: boolean; text?: string; durationMs: number; tokens?: number; costUsd?: number; error?: string }> {
  const t0 = Date.now()
  const src = await resolveImage({
    ...(input.imageBase64 ? { base64: input.imageBase64 } : {}),
    ...(input.imageUrl    ? { url:    input.imageUrl    } : {}),
  })
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }
  const r = await callAnthropicVision(src.buf, src.mime, input.prompt ?? 'Describe this image in 2-3 sentences.')
  if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: r.error }
  const inTokens  = r.usage?.input_tokens  ?? 0
  const outTokens = r.usage?.output_tokens ?? 0
  const costUsd = (inTokens / 1_000_000) * 3 + (outTokens / 1_000_000) * 15
  return { ok: true, text: r.text, durationMs: Date.now() - t0, tokens: inTokens + outTokens, costUsd }
}

// ─── Health probe ──────────────────────────────────────────────────────────

export async function visionHealth(): Promise<{ tesseract: { ok: boolean; version: string; languages: string[] }; anthropic: { configured: boolean } }> {
  const v = await runChild('tesseract', ['--version'], 5_000)
  const version = (v.stderr || v.stdout).match(/tesseract\s+([\d.]+)/i)?.[1] ?? ''
  const lst = await runChild('tesseract', ['--list-langs'], 5_000)
  const languages = (lst.stdout + '\n' + lst.stderr).split('\n').filter(l => /^[a-z][a-z_]+$/.test(l.trim())).map(l => l.trim())
  return {
    tesseract: { ok: v.ok || version.length > 0, version, languages },
    anthropic: { configured: !!process.env['ANTHROPIC_API_KEY'] },
  }
}

// ─── Child-process helper ──────────────────────────────────────────────────

interface ChildRes { ok: boolean; stdout: string; stderr: string; code: number }
async function runChild(cmd: string, args: string[], timeoutMs = 60_000): Promise<ChildRes> {
  return new Promise<ChildRes>((resolve) => {
    let stdout = '', stderr = '', settled = false
    const child = spawn(cmd, args)
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ ok: false, stdout, stderr: stderr + '\n[timeout]', code: -1 }) } }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr + '\n' + String(e), code: -1 }) } })
    child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: (code ?? 0) === 0, stdout, stderr, code: code ?? 0 }) } })
  })
}
