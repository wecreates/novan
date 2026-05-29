/**
 * hil-orchestrator.ts — Hardware-in-the-Loop test orchestration layer.
 *
 * This module is the software half of the spec's HIL system. It DOES
 * NOT replace physical lab equipment — programmable supplies,
 * oscilloscopes, environmental chambers, fault injectors all need to
 * exist physically and expose a network API. What this module DOES is:
 *
 *   - register stations and their capabilities (hardware revs, peripherals,
 *     chamber present, RF cage present, etc.)
 *   - accept job submissions from CI / developers / brain.task
 *   - schedule jobs onto stations matching the job's requirements
 *   - capture full telemetry (power, comms, scope, env, video refs)
 *     alongside pass/fail so failures have forensic depth
 *   - own the OTA campaign manager: stage rollouts, monitor post-update
 *     health, auto-rollback on regression
 *   - emit compliance evidence (firmware hash + test version + station
 *     config + timestamps + measurements) into a tamper-evident archive
 *
 * Honest scope:
 *   - Stations are network-reachable test runners the operator has built
 *     or bought. Novan does not BE the HIL rig; Novan orchestrates it.
 *   - Storage uses memories + events for now (no dedicated HIL schema
 *     yet) — round 124+ if you want a richer evidence-table.
 *   - Telemetry capture URLs are external references (S3 / blob store);
 *     Novan does not store oscilloscope captures in Postgres.
 */
import { db } from '../db/client.js'
import { events, memories } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ── Stations registry ──────────────────────────────────────────────
export interface HilStationCapabilities {
  /** Hardware revision the station physically holds. */
  hardwareRev:    string
  /** Architectures the flasher supports — esp32 / cortex-m4 / cortex-m7 / nrf52 / rp2040 / etc. */
  architectures:  string[]
  /** Peripherals wired on this station's harness. */
  peripherals:    string[]
  /** Environmental chamber present? */
  hasChamber:     boolean
  chamberRangeC?: { min: number; max: number }
  /** RF shielded enclosure for wireless conformance? */
  hasRfCage:      boolean
  /** Programmable supply present? (true = power consumption testing) */
  hasPowerMeter:  boolean
  /** Oscilloscope / logic analyzer wired? (true = timing verification) */
  hasScope:       boolean
  /** Soft availability — stations go offline for maintenance. */
  status:         'available' | 'busy' | 'maintenance' | 'offline'
  /** Network address the dispatcher posts jobs to. */
  endpoint:       string
  /** Last health check timestamp. */
  lastSeenAt:     number
}

export interface HilStation {
  id:            string
  label:         string
  capabilities:  HilStationCapabilities
}

/** Read all registered stations. Caller filters by capability for
 *  scheduling. Stations are persisted as memories with tag='hil_station'
 *  so they survive restart; future round adds a dedicated table. */
export async function listStations(): Promise<HilStation[]> {
  const rows = await db.select().from(memories)
    .where(eq(memories.source, 'hil-orchestrator'))
    .limit(200)
    .catch(() => [])
  const stations: HilStation[] = []
  for (const r of rows) {
    const tags = (r.tags as string[] | null) ?? []
    if (!tags.includes('hil_station')) continue
    try {
      const parsed = JSON.parse(r.content) as HilStation
      stations.push(parsed)
    } catch { /* skip malformed */ }
  }
  return stations
}

export async function registerStation(input: {
  workspaceId:   string
  label:         string
  capabilities:  HilStationCapabilities
}): Promise<HilStation> {
  const id = uuidv7()
  const station: HilStation = { id, label: input.label, capabilities: input.capabilities }
  await db.insert(memories).values({
    id,
    workspaceId:  input.workspaceId,
    type:         'procedural',
    content:      JSON.stringify(station),
    summary:      `HIL station: ${input.label}`,
    confidence:   1.0,
    tags:         ['hil_station', 'pinned', input.capabilities.hardwareRev],
    source:       'hil-orchestrator',
    sourceRef:    null,
    createdAt:    Date.now(),
    updatedAt:    Date.now(),
    expiresAt:    null,
  } as never).catch(() => null)
  await emit(input.workspaceId, 'hil.station_registered', { stationId: id, label: input.label })
  return station
}

// ── Job submission + scheduling ────────────────────────────────────
export interface HilJobRequirements {
  hardwareRev?:        string
  architecture?:       string
  peripherals?:        string[]
  needsChamber?:       boolean
  needsRfCage?:        boolean
  needsPowerMeter?:    boolean
  needsScope?:         boolean
}

export interface HilJob {
  id:              string
  workspaceId:     string
  /** Firmware build artifact reference (S3 url, registry path, etc.). */
  firmwareRef:     string
  /** Build SHA — used for reproducibility verification + compliance evidence. */
  firmwareSha:     string
  /** Test plan reference — what scripts to run on the station. */
  testPlanRef:     string
  requirements:    HilJobRequirements
  /** Category surfaced in compliance reports. */
  category:        'capability' | 'power' | 'timing' | 'communication' | 'environmental' | 'fault_injection' | 'soak' | 'rf' | 'ota_campaign'
  /** Risk tier — fault_injection + soak + ota_campaign are 'high'. */
  risk:            'low' | 'medium' | 'high'
  submittedAt:     number
  /** Result is filled when station completes. */
  result?:         HilJobResult
}

export interface HilJobResult {
  stationId:        string
  startedAt:        number
  completedAt:      number
  status:           'passed' | 'failed' | 'errored' | 'timeout'
  /** Headline measurements the result-storage layer captured. */
  measurements: {
    powerMicroAmps?:   number | null
    p99LatencyUs?:     number | null
    crashFreeRate?:    number | null
  }
  /** External references to captured artifacts (scope traces, power
   *  curves, comm logs, video, env sensor readings). */
  telemetryRefs:    Array<{ kind: string; url: string }>
  notes:            string | null
}

/** Submit a job. Returns the queued job id; the scheduler picks a
 *  station and dispatches in `scheduleQueuedJobs()` (called by cron
 *  or directly). */
export async function submitJob(input: Omit<HilJob, 'id' | 'submittedAt' | 'result'>): Promise<HilJob> {
  const job: HilJob = {
    id:           uuidv7(),
    submittedAt:  Date.now(),
    ...input,
  }
  await db.insert(events).values({
    id: uuidv7(), type: 'hil.job_submitted', workspaceId: input.workspaceId,
    payload: { jobId: job.id, category: job.category, risk: job.risk, requirements: job.requirements, firmwareSha: job.firmwareSha },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'hil-orchestrator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return job
}

/** Match a job to an available station. Greedy first-fit by
 *  requirement coverage; future round upgrades to bin-packing. */
export function matchStation(job: HilJob, stations: HilStation[]): HilStation | null {
  for (const s of stations) {
    if (s.capabilities.status !== 'available') continue
    const r = job.requirements
    if (r.hardwareRev    && s.capabilities.hardwareRev !== r.hardwareRev) continue
    if (r.architecture   && !s.capabilities.architectures.includes(r.architecture)) continue
    if (r.peripherals    && !r.peripherals.every(p => s.capabilities.peripherals.includes(p))) continue
    if (r.needsChamber   && !s.capabilities.hasChamber)    continue
    if (r.needsRfCage    && !s.capabilities.hasRfCage)     continue
    if (r.needsPowerMeter && !s.capabilities.hasPowerMeter) continue
    if (r.needsScope     && !s.capabilities.hasScope)      continue
    return s
  }
  return null
}

// ── OTA campaign manager ───────────────────────────────────────────
export interface OtaCampaign {
  id:                 string
  workspaceId:        string
  firmwareSha:        string
  fromVersionGlob:    string             // semver pattern of devices eligible to receive update
  toVersion:          string
  /** Staged rollout — operator chooses cautious / standard / fast. */
  stagedRollout: Array<{
    stage:           string
    targetDevicePct: number
    soakHours:       number
    rollbackTriggers: string[]
  }>
  status:             'staged' | 'rolling' | 'completed' | 'rolled_back' | 'paused'
  currentStage:       number
  /** Telemetry the OTA monitor cares about (filled as rollout proceeds). */
  telemetry: {
    devicesUpdated:        number
    devicesBricked:        number
    postUpdateFailureRate: number
    averageInstallSeconds: number
  }
  createdAt:          number
  updatedAt:          number
}

export function defaultOtaStaging(policy: 'cautious' | 'standard' | 'fast'): OtaCampaign['stagedRollout'] {
  if (policy === 'fast') {
    return [{ stage: 'production_100', targetDevicePct: 100, soakHours: 0, rollbackTriggers: [] }]
  }
  if (policy === 'standard') {
    return [
      { stage: 'internal',  targetDevicePct: 1,   soakHours: 24,  rollbackTriggers: ['any crash on boot'] },
      { stage: 'beta_5',    targetDevicePct: 5,   soakHours: 72,  rollbackTriggers: ['post-update failure rate > 1%'] },
      { stage: 'staged_25', targetDevicePct: 25,  soakHours: 168, rollbackTriggers: ['post-update failure rate > 0.5%', 'crash rate > 2× baseline'] },
      { stage: 'full',      targetDevicePct: 100, soakHours: 0,   rollbackTriggers: [] },
    ]
  }
  // cautious — fleet-wide hardware deployment
  return [
    { stage: 'hil_lab',     targetDevicePct: 0,   soakHours: 168, rollbackTriggers: ['any HIL failure'] },
    { stage: 'internal',    targetDevicePct: 1,   soakHours: 168, rollbackTriggers: ['any crash on boot', 'any battery anomaly'] },
    { stage: 'beta_5',      targetDevicePct: 5,   soakHours: 168, rollbackTriggers: ['post-update failure rate > 1%'] },
    { stage: 'staged_25',   targetDevicePct: 25,  soakHours: 168, rollbackTriggers: ['post-update failure rate > 0.5%'] },
    { stage: 'staged_50',   targetDevicePct: 50,  soakHours: 168, rollbackTriggers: ['post-update failure rate > 0.5%'] },
    { stage: 'full',        targetDevicePct: 100, soakHours: 0,   rollbackTriggers: [] },
  ]
}

/** Decide whether the current OTA stage triggers a rollback. The
 *  spec calls out: "Every OTA campaign should have been rehearsed in
 *  HIL against the version distribution that exists in the field." */
export function evaluateRollbackTriggers(input: {
  campaign: OtaCampaign
  telemetry: OtaCampaign['telemetry']
}): { shouldRollback: boolean; matchedTrigger: string | null } {
  const stage = input.campaign.stagedRollout[input.campaign.currentStage]
  if (!stage) return { shouldRollback: false, matchedTrigger: null }
  for (const trigger of stage.rollbackTriggers) {
    if (/post-update failure rate > 1%/.test(trigger) && input.telemetry.postUpdateFailureRate > 0.01) {
      return { shouldRollback: true, matchedTrigger: trigger }
    }
    if (/post-update failure rate > 0.5%/.test(trigger) && input.telemetry.postUpdateFailureRate > 0.005) {
      return { shouldRollback: true, matchedTrigger: trigger }
    }
    if (/any crash on boot/.test(trigger) && input.telemetry.devicesBricked > 0) {
      return { shouldRollback: true, matchedTrigger: trigger }
    }
  }
  return { shouldRollback: false, matchedTrigger: null }
}

// ── Compliance evidence archiver ───────────────────────────────────
/** Append a compliance-evidence record. The spec calls this out for
 *  FCC/CE/UL/FDA/FIPS audits: "Years later, when an auditor asks
 *  'show me that this device passed thermal testing at this temperature
 *  with this firmware version,' you can produce it."
 *
 *  Stored in memories with tag='compliance_evidence' + 'pinned' so it
 *  bypasses decay forever. Real production deploys should add a
 *  dedicated tamper-evident table; this is the minimal first step. */
export async function archiveComplianceEvidence(input: {
  workspaceId:  string
  jobId:        string
  firmwareSha:  string
  testVersion:  string
  stationId:    string
  category:     HilJob['category']
  measurements: HilJobResult['measurements']
  telemetryRefs: HilJobResult['telemetryRefs']
  passed:       boolean
  certifications?: string[]    // e.g. ['FCC', 'CE', 'UL']
}): Promise<string> {
  const id = uuidv7()
  await db.insert(memories).values({
    id,
    workspaceId:  input.workspaceId,
    type:         'episodic',
    content:      JSON.stringify({
      jobId:         input.jobId,
      firmwareSha:   input.firmwareSha,
      testVersion:   input.testVersion,
      stationId:     input.stationId,
      category:      input.category,
      measurements:  input.measurements,
      telemetryRefs: input.telemetryRefs,
      passed:        input.passed,
      certifications: input.certifications ?? [],
      capturedAt:    Date.now(),
    }),
    summary:      `Compliance evidence: ${input.category} · ${input.firmwareSha.slice(0, 12)} · ${input.passed ? 'PASS' : 'FAIL'}`,
    confidence:   1.0,
    tags:         ['compliance_evidence', 'pinned', input.category, ...(input.certifications ?? [])],
    source:       'hil-orchestrator',
    sourceRef:    input.jobId,
    createdAt:    Date.now(),
    updatedAt:    Date.now(),
    expiresAt:    null,
  } as never).catch(() => null)
  return id
}

/** Generate a traceability matrix linking requirements → tests →
 *  test results. The spec: "Traceability matrices that link requirements
 *  to tests to test results become the compliance backbone." */
export async function generateTraceabilityMatrix(input: {
  workspaceId:    string
  firmwareSha:    string
  certifications?: string[]
}): Promise<{
  firmwareSha:   string
  evidenceRows:  Array<{ category: HilJob['category']; passed: boolean; jobId: string; stationId: string; capturedAt: number }>
  coverage:      Record<HilJob['category'], boolean>
  missing:       HilJob['category'][]
}> {
  const rows = await db.select({ content: memories.content }).from(memories)
    .where(and(
      eq(memories.workspaceId, input.workspaceId),
      eq(memories.source, 'hil-orchestrator'),
    ))
    .orderBy(desc(memories.createdAt))
    .limit(500)
    .catch(() => [])

  const evidenceRows: Array<{ category: HilJob['category']; passed: boolean; jobId: string; stationId: string; capturedAt: number }> = []
  for (const r of rows) {
    try {
      const e = JSON.parse(r.content) as {
        firmwareSha?: string; category?: HilJob['category']; passed?: boolean
        jobId?: string; stationId?: string; capturedAt?: number; certifications?: string[]
      }
      if (e.firmwareSha !== input.firmwareSha) continue
      if (input.certifications && input.certifications.length > 0 &&
          !input.certifications.some(c => (e.certifications ?? []).includes(c))) continue
      if (!e.category || !e.jobId || !e.stationId) continue
      evidenceRows.push({
        category:   e.category,
        passed:     Boolean(e.passed),
        jobId:      e.jobId,
        stationId:  e.stationId,
        capturedAt: e.capturedAt ?? 0,
      })
    } catch { /* skip */ }
  }

  const required: HilJob['category'][] = ['capability', 'power', 'timing', 'communication', 'environmental']
  const coverage = required.reduce((acc, c) => {
    acc[c] = evidenceRows.some(e => e.category === c && e.passed)
    return acc
  }, {} as Record<HilJob['category'], boolean>)
  const missing = required.filter(c => !coverage[c])

  return { firmwareSha: input.firmwareSha, evidenceRows, coverage, missing }
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'hil-orchestrator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}
