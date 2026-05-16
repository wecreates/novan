/**
 * Delay step executor — waits N milliseconds then passes input through
 *
 * config: { ms: number }  (capped at 300 000 ms / 5 min)
 */
import { registerExecutor } from './index.js'

registerExecutor('delay', async (ctx) => {
  const ms = Math.min(Number(ctx.step.config['ms'] ?? 1_000), 300_000)
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
  // Pass previous outputs through unchanged
  return { status: 'completed', output: { waited: ms } }
})
