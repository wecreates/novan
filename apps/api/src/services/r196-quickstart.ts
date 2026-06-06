/**
 * R196 — Operator quickstart + single-shot platform status.
 *
 * platformStatus: one call returns radar ticker + open issues + open
 * findings + cron coverage + provider health + queue depths. The widget
 * Novan Console + an operator's first /admin/brain call should hit.
 *
 * quickstart: walks a brand-new workspace through the first 4 setup
 * steps in one call, returning the operator's checklist:
 *   1. Default voice persona seeded
 *   2. A starter director profile created (cinematic_short)
 *   3. A "first contact" ISA seeded for video.pai.run
 *   4. Feature flags inspected — returns the ones operator should toggle
 */
import { db } from '../db/client.js'
import {
  events, issues, pentestFinding, selfDevFinding, threatRadarSnapshot,
  voicePersona, directorProfile, videoIsa, featureFlag,
} from '../db/schema.js'
import { and, eq, desc, sql, gte, isNull } from 'drizzle-orm'

// ─── platform.status — single-call snapshot ──────────────────────────

export async function platformStatus(workspaceId: string): Promise<{
  radarLine: string
  radarOpen: number; radarCritical: number; radarHigh: number
  openIssues: number; openPentestCrit: number
  openSelfDevFindings: number
  cronFiresLast6h: number
  recentErrors: number
  flags: { enabled: number; disabled: number; disabledKeys: string[] }
  uptime: { snapshotsTotal: number }
  backup: { status: string; ageHours: number | null; newest: string | null }
  generatedAt: number
}> {
  const since6h = Date.now() - 6 * 60 * 60_000

  const [radarLatest] = await db.select().from(threatRadarSnapshot)
    .where(eq(threatRadarSnapshot.workspaceId, workspaceId))
    .orderBy(desc(threatRadarSnapshot.scanAt)).limit(1)

  const radarLine = radarLatest
    ? (radarLatest.openTotal === 0
        ? 'Scanning… all clear.'
        : `Scanning… ${radarLatest.openTotal} issue${radarLatest.openTotal === 1 ? '' : 's'}${radarLatest.criticalCount > 0 ? ` · ${radarLatest.criticalCount} critical` : ''}${radarLatest.highCount > 0 ? ` · ${radarLatest.highCount} high` : ''}`)
    : 'Scanning… no snapshots yet.'

  const [issueCounts] = await db.select({ n: sql<number>`count(*)::int` })
    .from(issues).where(and(eq(issues.workspaceId, workspaceId), eq(issues.status, 'open')))
  const [pentestCounts] = await db.select({ n: sql<number>`count(*)::int` })
    .from(pentestFinding)
    .where(and(eq(pentestFinding.workspaceId, workspaceId), eq(pentestFinding.status, 'open'), sql`${pentestFinding.severity} IN ('critical','high')`))
  const [sdFindCounts] = await db.select({ n: sql<number>`count(*)::int` })
    .from(selfDevFinding).where(and(eq(selfDevFinding.workspaceId, workspaceId), eq(selfDevFinding.status, 'open')))

  const [cronFires] = await db.select({ n: sql<number>`count(*)::int` })
    .from(events).where(and(sql`${events.type} LIKE 'cron.%'`, gte(events.createdAt, since6h)))
  const [errCounts] = await db.select({ n: sql<number>`count(*)::int` })
    .from(events).where(and(
      eq(events.workspaceId, workspaceId),
      sql`(${events.type} LIKE 'cron.error%' OR ${events.type} LIKE '%failed%')`,
      gte(events.createdAt, since6h),
    ))

  const flagsAll = await db.select().from(featureFlag)
  const disabled = flagsAll.filter(f => !f.enabled)

  const [snapshotsAll] = await db.select({ n: sql<number>`count(*)::int` })
    .from(threatRadarSnapshot).where(eq(threatRadarSnapshot.workspaceId, workspaceId))

  // R146.218 — backup freshness check
  let backupSummary: { status: string; ageHours: number | null; newest: string | null } = { status: 'unknown', ageHours: null, newest: null }
  try {
    const { backupHealth } = await import('./r218-backup-health.js')
    const b = await backupHealth()
    backupSummary = { status: b.status, ageHours: b.ageHours, newest: b.newestFilename }
  } catch { /* tolerated */ }

  return {
    radarLine,
    radarOpen: Number(radarLatest?.openTotal ?? 0),
    radarCritical: Number(radarLatest?.criticalCount ?? 0),
    radarHigh: Number(radarLatest?.highCount ?? 0),
    openIssues: Number(issueCounts?.n ?? 0),
    openPentestCrit: Number(pentestCounts?.n ?? 0),
    openSelfDevFindings: Number(sdFindCounts?.n ?? 0),
    cronFiresLast6h: Number(cronFires?.n ?? 0),
    recentErrors: Number(errCounts?.n ?? 0),
    flags: {
      enabled: flagsAll.filter(f => f.enabled).length,
      disabled: disabled.length,
      disabledKeys: disabled.map(f => f.key),
    },
    uptime: { snapshotsTotal: Number(snapshotsAll?.n ?? 0) },
    backup: backupSummary,
    generatedAt: Date.now(),
  }
}

// ─── platform.quickstart — first-run setup wizard ────────────────────

export async function quickstart(workspaceId: string): Promise<{
  steps: Array<{ name: string; status: 'created' | 'existed' | 'skipped'; detail?: string }>
  nextActions: string[]
}> {
  const steps: Array<{ name: string; status: 'created' | 'existed' | 'skipped'; detail?: string }> = []

  // 1. Voice persona
  const [persona] = await db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.name, 'novan'))).limit(1)
  if (persona) steps.push({ name: 'voice_persona', status: 'existed', detail: 'novan persona present' })
  else {
    try {
      const { personaUpsert } = await import('./r182-voice-layer.js')
      const r = await personaUpsert(workspaceId, { preset: 'novan' })
      steps.push({ name: 'voice_persona', status: 'created', detail: `id=${r.id.slice(0, 8)}` })
    } catch (e) { steps.push({ name: 'voice_persona', status: 'skipped', detail: (e as Error).message }) }
  }

  // 2. Starter director profile
  const [dp] = await db.select().from(directorProfile)
    .where(and(eq(directorProfile.workspaceId, workspaceId), eq(directorProfile.name, 'cinematic-short-default'))).limit(1)
  if (dp) steps.push({ name: 'director_profile', status: 'existed' })
  else {
    try {
      const { profileCreate } = await import('./r166-director-controls.js')
      const r = await profileCreate(workspaceId, {
        name: 'cinematic-short-default',
        cameraBody: 'arri_alexa_35', lens: 'zeiss_supreme_50', focalMm: 50, aperture: 2.0,
        motions: ['push_in', 'handheld'], colorGrade: 'teal_orange', vibe: 'cinematic_short',
      })
      steps.push({ name: 'director_profile', status: 'created', detail: `id=${r.id.slice(0, 8)}` })
    } catch (e) { steps.push({ name: 'director_profile', status: 'skipped', detail: (e as Error).message }) }
  }

  // 3. First-contact ISA
  const [existing] = await db.select({ id: videoIsa.id }).from(videoIsa)
    .where(and(eq(videoIsa.workspaceId, workspaceId), eq(videoIsa.title, 'First Contact'))).limit(1)
  if (existing) steps.push({ name: 'starter_isa', status: 'existed' })
  else {
    try {
      const { isaCreate } = await import('./r160-pai-video-loop.js')
      const r = await isaCreate(workspaceId, {
        title: 'First Contact',
        brief: 'A 30-second short-form intro that hooks the viewer in the first 2.5 seconds and ends with a clear CTA. Tone matches the workspace brand voice. Goal: get the operator their first 100 sustained-attention viewers.',
        target: { platform: 'tiktok', durationSec: 30, aspect: '9:16', ctaType: 'follow_for_more' },
      })
      steps.push({ name: 'starter_isa', status: 'created', detail: `id=${r.id.slice(0, 8)}` })
    } catch (e) { steps.push({ name: 'starter_isa', status: 'skipped', detail: (e as Error).message }) }
  }

  // 4. Inspect feature flags
  const flagsAll = await db.select().from(featureFlag)
  const disabled = flagsAll.filter(f => !f.enabled)
  steps.push({
    name: 'feature_flags',
    status: 'existed',
    detail: `${flagsAll.length} flags loaded, ${disabled.length} disabled (${disabled.map(f => f.key).join(', ') || 'none'})`,
  })

  const nextActions: string[] = [
    'Open /console.html to see the live operator dashboard.',
    'account.add → connect at least one social platform (TikTok / Instagram / YouTube / X).',
    'pod.store.create → register at least one POD store if doing POD.',
    'video.pai.run with isaId=<First Contact id> → first real PAI cycle.',
    'flag.set { key:"self_dev_inspect_enabled", enabled:true } → enable autonomous self-dev inspect.',
  ]
  return { steps, nextActions }
}
