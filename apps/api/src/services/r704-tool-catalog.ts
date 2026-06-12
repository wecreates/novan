/**
 * R704 — Single source of truth for the agent's tool arsenal.
 *
 * For a personal power tool, the agent/chat should reach the WHOLE platform,
 * not a conservative read-only subset. This catalog is the full safe-action
 * arsenal — everything a single trusted operator wants the agent to be able
 * to do on a single chat message:
 *
 *   research · web · scrape · vision · image gen/edit · audio (TTS/STT) ·
 *   PDF · knowledge base (RAG) · GitHub intel · memory · code exec ·
 *   desktop bridge · web search.
 *
 * Excluded by default (the agent can still be handed these explicitly):
 *   - destructive: *.delete, backup.s3.prune, knowledge.delete
 *   - billing/admin: billing.*, apikey.*, killswitch.*
 *   - infra: backup.s3.run, schedule mutations
 *
 * R647/R649/R651/R663 all import FULL_ARSENAL from here so there's one list
 * to maintain.
 */

export const FULL_ARSENAL: string[] = [
  // Web + research
  'web.search', 'web.fetch', 'scrape.extract',
  'research.deep', 'research.youtube_transcript', 'research.arxiv', 'research.reddit', 'research.image_search',
  // GitHub intel
  'github.repo', 'github.release', 'github.readme',
  // Vision (OpenAI gpt-4o-mini default)
  'vision.openai.describe', 'vision.ocr', 'vision.describe', 'vision.chart_extract',
  // Image generation + edit
  'image.openai.generate', 'image.openai.edit', 'image.free.generate', 'image.free.edit',
  'image.bg_remove', 'image.upscale',
  // Audio
  'audio.openai.tts', 'audio.openai.transcribe',
  // Documents
  'pdf.text_native', 'document.pdf',
  // Knowledge base (RAG)
  'knowledge.query', 'knowledge.ingest_url', 'knowledge.ingest_text',
  'rag.query', 'kg.search', 'kg.mermaid',
  // Memory
  'memory.recall', 'memory.list', 'memory.upsert',
  // Code execution
  'code.exec',
  // Introspection
  'brain.list', 'ops.health',
  // Embeddings + semantic recall
  'embed.semantic.runs', 'embed.semantic.chat',
  // Desktop bridge (operator's local agent picks these up)
  'desktop.act',
]

/** A lighter set for pure chat (no heavyweight media gen unless asked). */
export const CHAT_ARSENAL: string[] = [
  'web.search', 'web.fetch', 'scrape.extract',
  'github.repo', 'github.release', 'github.readme',
  'vision.openai.describe',
  'knowledge.query', 'rag.query', 'kg.search',
  'memory.recall', 'memory.list',
  'embed.semantic.chat',
  'brain.list',
  // Personal-power additions: the operator wants chat to also be able to
  // generate media + run code without dropping to a separate op.
  'image.openai.generate', 'audio.openai.tts', 'audio.openai.transcribe',
  'document.pdf', 'code.exec',
]

/** Resolve the effective tool list. Caller-provided wins; else the named default. */
export function resolveTools(provided: string[] | undefined, fallback: 'full' | 'chat'): string[] {
  if (Array.isArray(provided)) return provided
  return fallback === 'full' ? FULL_ARSENAL : CHAT_ARSENAL
}
