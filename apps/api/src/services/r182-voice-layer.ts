/**
 * R182 — Voice layer: wake word + persona + named voice + cross-device handoff.
 * Server side of "Hey Novan" — client uses WebSpeech continuous + local VAD,
 * fires this endpoint when wake word detected.
 */
import { db } from '../db/client.js'
import { voicePersona, sessionSync } from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Persona ────────────────────────────────────────────────────────

const DEFAULT_PERSONAS: Record<string, { wakeWord: string; voiceId: string; voiceProvider: string; tone: string; personaPrompt: string }> = {
  novan: {
    wakeWord: 'hey novan',
    voiceId: '21m00Tcm4TlvDq8ikWAM',  // ElevenLabs Rachel — clear pro
    voiceProvider: 'elevenlabs',
    tone: 'precise',
    personaPrompt: `You are Novan. Speak with quiet confidence — precise, brief, dry-witted. Address the operator directly. Never apologize. Never hedge with "I think". Confirm receipt with one short clause before acting. Reserved by default; warmer when the operator is.`,
  },
  jarvis_like: {
    wakeWord: 'hey novan',
    voiceId: 'pNInz6obpgDQGcFmaJgB',  // ElevenLabs Adam — British-adjacent baritone
    voiceProvider: 'elevenlabs',
    tone: 'dry',
    personaPrompt: `Speak with measured British formality. Address the operator as "sir" or "ma'am" when appropriate. Dry, faintly amused. Lead with the answer. Use "very well" when acknowledging. Anticipate the next question; don't ask "anything else?".`,
  },
  friday_like: {
    wakeWord: 'hey friday',
    voiceId: 'EXAVITQu4vr4xnSDxMaL',  // ElevenLabs Bella — warm Irish-adjacent
    voiceProvider: 'elevenlabs',
    tone: 'warm',
    personaPrompt: `Speak warmly with a hint of an Irish lilt. Address the operator by name when known. Quick, casual, helpful. Never robotic. Offer one specific suggestion after answering.`,
  },
}

export interface PersonaInput {
  name?:           string
  wakeWord?:       string
  voiceId?:        string
  voiceProvider?:  string
  personaPrompt?:  string
  tone?:           string
  responseSpeed?:  'slow' | 'normal' | 'fast'
  proactiveEnabled?: boolean
  alwaysOn?:       boolean
  preset?:         'novan' | 'jarvis_like' | 'friday_like'
}

export async function personaUpsert(workspaceId: string, input: PersonaInput): Promise<{ id: string }> {
  const preset = (input.preset ? DEFAULT_PERSONAS[input.preset] : DEFAULT_PERSONAS['novan']) ?? DEFAULT_PERSONAS['novan']!
  const name = input.name ?? input.preset ?? 'novan'
  const now = Date.now()
  const [existing] = await db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.name, name))).limit(1)
  if (existing) {
    await db.update(voicePersona).set({
      wakeWord: input.wakeWord ?? existing.wakeWord,
      voiceId: input.voiceId ?? existing.voiceId,
      voiceProvider: input.voiceProvider ?? existing.voiceProvider,
      personaPrompt: input.personaPrompt ?? existing.personaPrompt,
      tone: input.tone ?? existing.tone,
      responseSpeed: input.responseSpeed ?? existing.responseSpeed,
      proactiveEnabled: input.proactiveEnabled ?? existing.proactiveEnabled,
      alwaysOn: input.alwaysOn ?? existing.alwaysOn,
      updatedAt: now,
    }).where(eq(voicePersona.id, existing.id))
    return { id: existing.id }
  }
  const id = uuidv7()
  await db.insert(voicePersona).values({
    id, workspaceId, name,
    wakeWord: input.wakeWord ?? preset.wakeWord,
    voiceId: input.voiceId ?? preset.voiceId,
    voiceProvider: input.voiceProvider ?? preset.voiceProvider,
    personaPrompt: input.personaPrompt ?? preset.personaPrompt,
    tone: input.tone ?? preset.tone,
    responseSpeed: input.responseSpeed ?? 'normal',
    proactiveEnabled: input.proactiveEnabled ?? true,
    alwaysOn: input.alwaysOn ?? false,
    status: 'active',
    createdAt: now, updatedAt: now,
  })
  return { id }
}

export async function personaGet(workspaceId: string, name = 'novan'): Promise<typeof voicePersona.$inferSelect | null> {
  const [r] = await db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.name, name))).limit(1)
  if (r) return r
  await personaUpsert(workspaceId, { preset: 'novan' })
  const [seeded] = await db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.name, 'novan'))).limit(1)
  return seeded ?? null
}

export async function personaList(workspaceId: string): Promise<Array<typeof voicePersona.$inferSelect>> {
  return db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.status, 'active')))
    .orderBy(desc(voicePersona.createdAt))
}

/**
 * Client-side wake-word config returned at session start. Contains the
 * regex pattern + sample rate + minimum confidence for the on-device VAD.
 */
export function wakeWordConfig(persona: typeof voicePersona.$inferSelect): { wakeWord: string; pattern: string; minConfidence: number; sampleRateHz: number; framesMs: number; alwaysOn: boolean } {
  const words = persona.wakeWord.toLowerCase().trim().split(/\s+/)
  const pattern = `\\b${words.map(w => w.replace(/[^a-z]/g, '')).join('\\s+')}\\b`
  return {
    wakeWord: persona.wakeWord,
    pattern,
    minConfidence: 0.75,
    sampleRateHz: 16000,
    framesMs: 30,
    alwaysOn: persona.alwaysOn,
  }
}

// ─── Cross-device session sync ──────────────────────────────────────

export async function sessionPing(workspaceId: string, opts: {
  userId: string; deviceId: string; deviceKind?: string; activeChatId?: string; draftInput?: string; draftVoiceState?: Record<string, unknown>
}): Promise<{ id: string; otherDevices: Array<{ deviceId: string; deviceKind: string | null; ageSec: number }> }> {
  const now = Date.now()
  const [existing] = await db.select().from(sessionSync)
    .where(and(eq(sessionSync.workspaceId, workspaceId), eq(sessionSync.userId, opts.userId), eq(sessionSync.deviceId, opts.deviceId))).limit(1)
  let id: string
  if (existing) {
    id = existing.id
    await db.update(sessionSync).set({
      ...(opts.deviceKind ? { deviceKind: opts.deviceKind } : {}),
      ...(opts.activeChatId ? { activeChatId: opts.activeChatId } : {}),
      ...(opts.draftInput !== undefined ? { draftInput: opts.draftInput } : {}),
      ...(opts.draftVoiceState ? { draftVoiceState: opts.draftVoiceState } : {}),
      lastPingAt: now,
    }).where(eq(sessionSync.id, id))
  } else {
    id = uuidv7()
    await db.insert(sessionSync).values({
      id, workspaceId, userId: opts.userId, deviceId: opts.deviceId,
      ...(opts.deviceKind ? { deviceKind: opts.deviceKind } : {}),
      ...(opts.activeChatId ? { activeChatId: opts.activeChatId } : {}),
      ...(opts.draftInput !== undefined ? { draftInput: opts.draftInput } : {}),
      draftVoiceState: opts.draftVoiceState ?? {},
      lastPingAt: now, createdAt: now,
    })
  }
  // Other live devices in last 60s.
  const since = now - 60_000
  const others = await db.select({ deviceId: sessionSync.deviceId, deviceKind: sessionSync.deviceKind, lastPingAt: sessionSync.lastPingAt })
    .from(sessionSync)
    .where(and(
      eq(sessionSync.workspaceId, workspaceId), eq(sessionSync.userId, opts.userId),
      sql`${sessionSync.deviceId} <> ${opts.deviceId}`,
      gte(sessionSync.lastPingAt, since),
    ))
  return {
    id,
    otherDevices: others.map(o => ({ deviceId: o.deviceId, deviceKind: o.deviceKind, ageSec: Math.round((now - o.lastPingAt) / 1000) })),
  }
}

/**
 * Handoff active state from one device to another. Target device picks
 * up draftInput + activeChatId + draftVoiceState on its next ping.
 */
export async function handoff(workspaceId: string, opts: { userId: string; fromDeviceId: string; toDeviceId: string }): Promise<{ ok: boolean; payload?: { activeChatId: string | null; draftInput: string | null; draftVoiceState: Record<string, unknown> } }> {
  const [from] = await db.select().from(sessionSync)
    .where(and(eq(sessionSync.workspaceId, workspaceId), eq(sessionSync.userId, opts.userId), eq(sessionSync.deviceId, opts.fromDeviceId))).limit(1)
  if (!from) return { ok: false }
  await db.update(sessionSync).set({
    activeChatId: from.activeChatId, draftInput: from.draftInput, draftVoiceState: from.draftVoiceState, lastPingAt: Date.now(),
  })
    .where(and(eq(sessionSync.workspaceId, workspaceId), eq(sessionSync.userId, opts.userId), eq(sessionSync.deviceId, opts.toDeviceId)))
  await db.update(sessionSync).set({ lastHandoffTo: opts.toDeviceId })
    .where(eq(sessionSync.id, from.id))
  return {
    ok: true,
    payload: {
      activeChatId: from.activeChatId,
      draftInput: from.draftInput,
      draftVoiceState: from.draftVoiceState as Record<string, unknown>,
    },
  }
}

export async function devicesList(workspaceId: string, userId: string): Promise<Array<typeof sessionSync.$inferSelect>> {
  const since = Date.now() - 5 * 60_000
  return db.select().from(sessionSync)
    .where(and(eq(sessionSync.workspaceId, workspaceId), eq(sessionSync.userId, userId), gte(sessionSync.lastPingAt, since)))
    .orderBy(desc(sessionSync.lastPingAt))
}
