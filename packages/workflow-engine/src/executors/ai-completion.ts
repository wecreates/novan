/**
 * AI completion step executor — calls an OpenAI-compatible chat completions API
 *
 * config: { prompt: string; model?: string; maxTokens?: number; temperature?: number; systemPrompt?: string }
 * output: { content: string; model: string; tokens: { prompt: number; output: number } }
 */
import { registerExecutor } from './index.js'

interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>
  usage:   { prompt_tokens: number; completion_tokens: number }
  model:   string
}

registerExecutor('ai-completion', async (ctx) => {
  const { step, previousOutputs } = ctx
  const config      = step.config
  const prompt      = String(config['prompt'] ?? JSON.stringify(previousOutputs))
  const model       = String(config['model'] ?? 'gpt-4o-mini')
  const maxTokens   = Number(config['maxTokens'] ?? 1_000)
  const temperature = Number(config['temperature'] ?? 0.7)
  const systemPrompt = config['systemPrompt'] ? String(config['systemPrompt']) : undefined

  const apiKey  = process.env['OPENAI_API_KEY'] ?? ''
  const baseUrl = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'

  const messages: Array<{ role: string; content: string }> = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: prompt })

  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'failed', output: {}, error: `AI request failed: ${message}` }
  }

  if (!res.ok) {
    const errText = await res.text()
    return { status: 'failed', output: {}, error: `AI completion failed: ${res.status} ${errText}` }
  }

  const data = await res.json() as ChatCompletionResponse
  return {
    status: 'completed',
    output: {
      content: data.choices[0]?.message?.content ?? '',
      model:   data.model,
      tokens:  { prompt: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    },
  }
})
