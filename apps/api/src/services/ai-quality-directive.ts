/**
 * R146.127 — Global AI quality directive.
 *
 * Every AI generator in the platform (chat, code, image, viral scripts,
 * business plans, prompt-evolution, ceo-orchestrator, novan-do
 * classifier, etc.) inherits this rule via the entry-point shims in
 * chat-providers.streamChat() and image-generator buildPrompt().
 *
 * Operators may override per-call by passing { suppressQualityBar: true }
 * on the streamChat opts (used only by the token-stretcher meta-prompt,
 * which already enforces a stricter bar of its own).
 *
 * Keep this constant TIGHT. It prepends to ~20 LLM system prompts and
 * every image prompt. Every token must justify itself.
 */

/** Text-LLM quality bar. ~120 tokens. */
export const QUALITY_BAR_TEXT = `[QUALITY BAR — mandatory]
- Production-grade output. No drafts, placeholders, or "TODO" markers.
- Concrete > vague. Specific > generic. Name files, functions, numbers, sources.
- Never fabricate APIs, paths, statistics, quotes, or library behavior. If uncertain, say so or ask one precise question.
- Smallest correct change. No speculative scope expansion.
- If acting requires capability you don't have, name the gap explicitly — don't pretend.
- Cite only sources you actually consulted.
- Match the surrounding code/style/conventions when editing.`

/** Image-generation quality suffix. Appended to every image prompt. */
export const QUALITY_BAR_IMAGE = ', high detail, sharp focus, professional composition, accurate proportions, no visual artifacts, no extra fingers or limbs, no watermark, no text artifacts'

/**
 * Prepend the quality bar to a system-role message, or insert one if
 * the message list lacks a system role. Idempotent: detects existing
 * "[QUALITY BAR" prefix and skips.
 */
export function injectQualityBarIntoMessages<M extends { role: string; content: string }>(messages: M[]): M[] {
  if (messages.length === 0) return messages
  // Already injected?
  if (messages.some(m => m.role === 'system' && m.content.startsWith('[QUALITY BAR'))) return messages
  const firstSystemIdx = messages.findIndex(m => m.role === 'system')
  if (firstSystemIdx >= 0) {
    const out = [...messages]
    const sys = out[firstSystemIdx]
    if (sys) out[firstSystemIdx] = { ...sys, content: `${QUALITY_BAR_TEXT}\n\n${sys.content}` }
    return out
  }
  // No system message — prepend one. Use the same shape as the first message.
  const first = messages[0]
  if (!first) return messages
  const sysMsg = { ...first, role: 'system', content: QUALITY_BAR_TEXT } as M
  return [sysMsg, ...messages]
}

/** Append the image quality suffix to a prompt. Idempotent. */
export function injectQualityBarIntoImagePrompt(prompt: string): string {
  if (!prompt) return prompt
  if (prompt.includes('high detail, sharp focus, professional composition')) return prompt
  return `${prompt.trim()}${QUALITY_BAR_IMAGE}`
}
