/**
 * Tests for chat-attachments — pure validation + per-family materialization.
 */
import { describe, it, expect } from 'vitest'
import {
  validateAttachments,
  materializeOpenAI, materializeAnthropic, materializeGemini,
  parseDataUrl, hasVisionAttachment,
  type ChatAttachment,
} from '../services/chat-attachments.js'

const dataPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const dataJpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

// ─── validateAttachments ───────────────────────────────────────────────

describe('chat-attachments: validateAttachments', () => {
  it('accepts undefined / null as empty', () => {
    expect(validateAttachments(undefined).ok).toBe(true)
    expect(validateAttachments(undefined).attachments).toEqual([])
    expect(validateAttachments(null).attachments).toEqual([])
  })

  it('rejects non-array input', () => {
    expect(validateAttachments('hi').ok).toBe(false)
    expect(validateAttachments({}).ok).toBe(false)
  })

  it('caps at 6 attachments per message', () => {
    const seven = Array.from({ length: 7 }, () => ({ url: dataPng, mime: 'image/png', kind: 'image' }))
    expect(validateAttachments(seven).ok).toBe(false)
  })

  it('accepts a clean image attachment', () => {
    const r = validateAttachments([{ url: dataPng, mime: 'image/png', kind: 'image' }])
    expect(r.ok).toBe(true)
    expect(r.attachments).toHaveLength(1)
    expect(r.attachments?.[0]?.mime).toBe('image/png')
  })

  it('rejects an unknown image mime', () => {
    const r = validateAttachments([{ url: dataPng, mime: 'image/bmp', kind: 'image' }])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/mime not allowed/)
  })

  it('rejects an unknown kind', () => {
    const r = validateAttachments([{ url: dataPng, mime: 'image/png', kind: 'video' }])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/kind must be/)
  })

  it('rejects a missing url', () => {
    const r = validateAttachments([{ mime: 'image/png', kind: 'image' }])
    expect(r.ok).toBe(false)
  })

  it('rejects javascript: / file: URLs', () => {
    const r1 = validateAttachments([{ url: 'javascript:alert(1)', mime: 'image/png', kind: 'image' }])
    const r2 = validateAttachments([{ url: 'file:///etc/passwd', mime: 'image/png', kind: 'image' }])
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
  })

  it('accepts an https URL for hosted images', () => {
    const r = validateAttachments([{ url: 'https://cdn.example.com/x.png', mime: 'image/png', kind: 'image' }])
    expect(r.ok).toBe(true)
  })

  it('rejects an oversized data url', () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(6_000_001)
    const r = validateAttachments([{ url: big, mime: 'image/png', kind: 'image' }])
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too large/)
  })

  it('accepts a document mime', () => {
    const r = validateAttachments([{ url: 'https://x.com/a.pdf', mime: 'application/pdf', kind: 'document' }])
    expect(r.ok).toBe(true)
  })

  it('rejects an executable document mime', () => {
    const r = validateAttachments([{ url: 'https://x.com/a.exe', mime: 'application/x-msdownload', kind: 'document' }])
    expect(r.ok).toBe(false)
  })

  it('preserves optional name and sizeBytes', () => {
    const r = validateAttachments([{ url: dataPng, mime: 'image/png', kind: 'image', name: 'screenshot.png', sizeBytes: 1234 }])
    expect(r.attachments?.[0]?.name).toBe('screenshot.png')
    expect(r.attachments?.[0]?.sizeBytes).toBe(1234)
  })

  it('truncates absurdly long names', () => {
    const r = validateAttachments([{ url: dataPng, mime: 'image/png', kind: 'image', name: 'x'.repeat(500) }])
    expect((r.attachments?.[0]?.name ?? '').length).toBe(200)
  })

  it('lowercases mime', () => {
    const r = validateAttachments([{ url: dataPng, mime: 'IMAGE/PNG', kind: 'image' }])
    expect(r.attachments?.[0]?.mime).toBe('image/png')
  })
})

// ─── parseDataUrl ──────────────────────────────────────────────────────

describe('chat-attachments: parseDataUrl', () => {
  it('parses a base64 data url', () => {
    const r = parseDataUrl(dataPng)
    expect(r.mime).toBe('image/png')
    expect(r.data.length).toBeGreaterThan(0)
  })

  it('returns empty for a non-data url', () => {
    expect(parseDataUrl('https://x.com/x.png').mime).toBe('')
  })
})

// ─── hasVisionAttachment ───────────────────────────────────────────────

describe('chat-attachments: hasVisionAttachment', () => {
  it('true when an image is present', () => {
    expect(hasVisionAttachment([{ url: dataPng, mime: 'image/png', kind: 'image' }])).toBe(true)
  })
  it('false for documents only', () => {
    expect(hasVisionAttachment([{ url: 'https://x.com/a.pdf', mime: 'application/pdf', kind: 'document' }])).toBe(false)
  })
  it('false for null / undefined / empty', () => {
    expect(hasVisionAttachment(null)).toBe(false)
    expect(hasVisionAttachment(undefined)).toBe(false)
    expect(hasVisionAttachment([])).toBe(false)
  })
})

// ─── materializeOpenAI ─────────────────────────────────────────────────

describe('chat-attachments: materializeOpenAI', () => {
  it('returns plain string when no attachments', () => {
    expect(materializeOpenAI('hi', [])).toBe('hi')
  })

  it('builds typed parts for an image', () => {
    const atts: ChatAttachment[] = [{ url: dataPng, mime: 'image/png', kind: 'image' }]
    const out = materializeOpenAI('what is this?', atts) as Array<Record<string, unknown>>
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(out[1]).toMatchObject({ type: 'image_url', image_url: { url: dataPng } })
  })

  it('text-references documents (no doc-part support)', () => {
    const atts: ChatAttachment[] = [{ url: 'https://x.com/a.pdf', mime: 'application/pdf', kind: 'document', name: 'notes.pdf' }]
    const out = materializeOpenAI('summarize', atts) as Array<Record<string, unknown>>
    expect(out[1]).toMatchObject({ type: 'text' })
    expect(String(out[1]?.['text'])).toMatch(/notes\.pdf/)
  })
})

// ─── materializeAnthropic ──────────────────────────────────────────────

describe('chat-attachments: materializeAnthropic', () => {
  it('returns plain string when no attachments', () => {
    expect(materializeAnthropic('hi', [])).toBe('hi')
  })

  it('decodes data URL into base64 source block', () => {
    const atts: ChatAttachment[] = [{ url: dataPng, mime: 'image/png', kind: 'image' }]
    const out = materializeAnthropic('what is this?', atts) as Array<Record<string, unknown>>
    const imgBlock = out.find(b => b['type'] === 'image') as { source?: { type?: string; media_type?: string; data?: string } } | undefined
    expect(imgBlock?.source?.type).toBe('base64')
    expect(imgBlock?.source?.media_type).toBe('image/png')
    expect((imgBlock?.source?.data ?? '').length).toBeGreaterThan(0)
  })

  it('uses url source for https images', () => {
    const atts: ChatAttachment[] = [{ url: 'https://x.com/x.png', mime: 'image/png', kind: 'image' }]
    const out = materializeAnthropic('look', atts) as Array<Record<string, unknown>>
    const imgBlock = out.find(b => b['type'] === 'image') as { source?: { type?: string; url?: string } } | undefined
    expect(imgBlock?.source?.type).toBe('url')
    expect(imgBlock?.source?.url).toBe('https://x.com/x.png')
  })

  it('puts text block last for prompt-after-image behavior', () => {
    const atts: ChatAttachment[] = [{ url: dataPng, mime: 'image/png', kind: 'image' }]
    const out = materializeAnthropic('describe', atts) as Array<Record<string, unknown>>
    expect(out[out.length - 1]).toMatchObject({ type: 'text', text: 'describe' })
  })
})

// ─── materializeGemini ─────────────────────────────────────────────────

describe('chat-attachments: materializeGemini', () => {
  it('builds inline_data for data URLs', () => {
    const atts: ChatAttachment[] = [{ url: dataJpg, mime: 'image/jpeg', kind: 'image' }]
    const parts = materializeGemini('see this', atts)
    const img = parts.find(p => 'inline_data' in p) as { inline_data?: { mime_type?: string; data?: string } } | undefined
    expect(img?.inline_data?.mime_type).toBe('image/jpeg')
    expect((img?.inline_data?.data ?? '').length).toBeGreaterThan(0)
  })

  it('builds file_data for https images', () => {
    const atts: ChatAttachment[] = [{ url: 'https://x.com/x.png', mime: 'image/png', kind: 'image' }]
    const parts = materializeGemini('see this', atts)
    const f = parts.find(p => 'file_data' in p) as { file_data?: { mime_type?: string; file_uri?: string } } | undefined
    expect(f?.file_data?.file_uri).toBe('https://x.com/x.png')
  })

  it('always appends a text part for the user message body', () => {
    const atts: ChatAttachment[] = [{ url: dataPng, mime: 'image/png', kind: 'image' }]
    const parts = materializeGemini('describe please', atts)
    expect(parts[parts.length - 1]).toEqual({ text: 'describe please' })
  })

  it('handles empty attachments by returning just a text part', () => {
    expect(materializeGemini('hi', [])).toEqual([{ text: 'hi' }])
  })
})
