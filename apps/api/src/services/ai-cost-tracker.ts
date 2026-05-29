/**
 * ai-cost-tracker.ts — single helper to record `ai_usage` rows from
 * any integration call (TTS, Whisper, vision, image-gen, code-gen, etc).
 *
 * Previously: cost tracking only happened inside `chat-providers.ts`.
 * Every other integration (voiceover, caption, video-analyzer,
 * thumbnail-generator, music-multimodal, ai-broll-generator,
 * code-agent) burned tokens invisible to budget-guard. Operators
 * could not see WHERE spend went.
 *
 * Fire-and-forget design: callers `void recordAiUsage({...})` and the
 * write happens in the background. Failures are logged but don't fail
 * the parent op.
 */

import { db } from '../db/client.js'
import { aiUsage } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

export interface AiCostInput {
  workspaceId:  string
  provider:     string                  // 'groq' | 'openai' | 'anthropic' | 'gemini' | 'elevenlabs' | 'playht' | 'runway' | 'luma' | 'replicate' | etc
  model:        string
  promptTokens: number
  outputTokens: number
  costUsd:      number
  latencyMs:    number
  taskType:     'chat' | 'codegen' | 'tts' | 'whisper' | 'vision' | 'image-gen' | 'video-gen' | 'embedding' | 'other'
  cached?:      boolean
  traceId?:     string
  workflowRunId?: string
}

export function recordAiUsage(input: AiCostInput): void {
  // Fire-and-forget — do not block the caller on telemetry insert.
  void (async () => {
    try {
      await db.insert(aiUsage).values({
        id:            uuidv7(),
        workspaceId:   input.workspaceId,
        provider:      input.provider,
        model:         input.model,
        promptTokens:  input.promptTokens,
        outputTokens:  input.outputTokens,
        costUsd:       input.costUsd,
        latencyMs:     input.latencyMs,
        cached:        input.cached ?? false,
        taskType:      input.taskType,
        timestamp:     Date.now(),
        traceId:       input.traceId ?? null,
        workflowRunId: input.workflowRunId ?? null,
      })
    } catch (e) {
      // Don't crash the parent op on telemetry write failure
      console.error('[ai-cost-tracker] failed to record ai_usage:', (e as Error).message)
    }
  })()
}
