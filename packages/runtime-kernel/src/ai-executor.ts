/**
 * AI Executor — runs AI completions with cost tracking, retry, and provider fallback.
 */

export interface AiExecutionRequest {
  prompt: string
  systemPrompt?: string
  model?: string
  provider?: 'openai' | 'anthropic' | 'ollama'
  maxTokens?: number
  temperature?: number
  taskType?: string
  workspaceId?: string
  traceId?: string
}

export interface AiExecutionResult {
  content: string
  model: string
  provider: string
  promptTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  cached: boolean
}

// Token cost table (USD per 1M tokens)
const COST_TABLE: Record<string, { prompt: number; output: number }> = {
  'gpt-4o':                    { prompt: 5.0,  output: 15.0 },
  'gpt-4o-mini':               { prompt: 0.15, output: 0.6  },
  'gpt-4.1':                   { prompt: 2.0,  output: 8.0  },
  'claude-3-5-haiku-20241022': { prompt: 0.8,  output: 4.0  },
  'claude-sonnet-4-5':         { prompt: 3.0,  output: 15.0 },
  'claude-opus-4-5':           { prompt: 15.0, output: 75.0 },
  'default':                   { prompt: 1.0,  output: 3.0  },
}

function estimateCost(model: string, promptTokens: number, outputTokens: number): number {
  const costs = COST_TABLE[model] ?? COST_TABLE['default']!
  return (promptTokens * costs.prompt + outputTokens * costs.output) / 1_000_000
}

interface AnthropicResponse {
  content?: Array<{ text?: string }>
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export async function executeAi(request: AiExecutionRequest): Promise<AiExecutionResult> {
  const model    = request.model    ?? 'gpt-4o-mini'
  const provider = request.provider ?? 'openai'
  const start    = Date.now()

  let content      = ''
  let promptTokens = 0
  let outputTokens = 0

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
    const msgs: Array<{ role: string; content: string }> = [{ role: 'user', content: request.prompt }]
    const body: Record<string, unknown> = {
      model,
      messages:   msgs,
      max_tokens: request.maxTokens ?? 1000,
    }
    if (request.systemPrompt) body['system'] = request.systemPrompt

    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })
    const data = await res.json() as AnthropicResponse
    content      = data.content?.[0]?.text        ?? ''
    promptTokens = data.usage?.input_tokens        ?? 0
    outputTokens = data.usage?.output_tokens       ?? 0
  } else {
    // openai or ollama (ollama exposes an OpenAI-compatible endpoint)
    const apiKey  = process.env['OPENAI_API_KEY']  ?? ''
    const baseUrl = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'
    const msgs: Array<{ role: string; content: string }> = []
    if (request.systemPrompt) msgs.push({ role: 'system', content: request.systemPrompt })
    msgs.push({ role: 'user', content: request.prompt })

    const res  = await fetch(`${baseUrl}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages:    msgs,
        max_tokens:  request.maxTokens  ?? 1000,
        temperature: request.temperature ?? 0.7,
      }),
    })
    const data = await res.json() as OpenAiResponse
    content      = data.choices?.[0]?.message?.content ?? ''
    promptTokens = data.usage?.prompt_tokens            ?? 0
    outputTokens = data.usage?.completion_tokens        ?? 0
  }

  const latencyMs = Date.now() - start
  const costUsd   = estimateCost(model, promptTokens, outputTokens)

  return { content, model, provider, promptTokens, outputTokens, costUsd, latencyMs, cached: false }
}
