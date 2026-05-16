/**
 * HTTP step executor — makes HTTP requests
 *
 * config: { url: string; method?: string; headers?: Record<string,string>; body?: unknown; timeout?: number }
 * output: { status: number; headers: Record<string,string>; body: unknown }
 */
import { registerExecutor } from './index.js'

registerExecutor('http', async (ctx) => {
  const { config } = ctx.step
  const url     = String(config['url'] ?? '')
  const method  = String(config['method'] ?? 'GET').toUpperCase()
  const headers = (config['headers'] as Record<string, string>) ?? {}
  const timeout = Number(config['timeout'] ?? 30_000)

  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(method !== 'GET' && method !== 'HEAD'
        ? { body: JSON.stringify(config['body'] ?? ctx.previousOutputs) }
        : {}),
      signal: ctrl.signal,
    })

    const text = await res.text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = text }

    const outHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { outHeaders[k] = v })

    return { status: 'completed', output: { status: res.status, headers: outHeaders, body } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'failed', output: {}, error: message }
  } finally {
    clearTimeout(timer)
  }
})
