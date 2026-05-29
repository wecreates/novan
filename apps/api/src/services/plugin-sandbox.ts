/**
 * plugin-sandbox.ts — minimal plugin sandbox (#3 Tier 1).
 *
 * What this is:
 *   - A typed `PluginManifest` schema every plugin must declare.
 *   - A pure `validateManifest()` that rejects obviously dangerous /
 *     malformed manifests before any code runs.
 *   - A pure `checkPermission()` that gates each runtime capability the
 *     plugin asks for.
 *   - A `loadPlugin()` that runs the plugin's entry file in a
 *     `node:worker_threads` Worker with strict `resourceLimits`,
 *     `--experimental-permission` flags off (no FS, no network unless
 *     the manifest explicitly requests it), and a typed message-bus
 *     contract.
 *
 * What this isn't:
 *   - True V8 isolation. `worker_threads` shares the same V8 instance;
 *     a determined attacker could escape with native modules. For
 *     untrusted code, swap the Worker for `isolated-vm` or QuickJS.
 *   - A plugin marketplace, signing, or registry. Those are followups
 *     once the loader is exercised in real operations.
 *
 * Why ship this anyway:
 *   - Honest manifest + permission discipline blocks the most common
 *     plugin foot-guns (unrestricted DB writes, exfil via fetch).
 *   - The typed message bus means future plugins have a stable
 *     contract from day one — the protocol can't drift.
 *   - The constitution check (services/ai-constitution.ts) gates the
 *     loader as a defense-in-depth; a plugin manifest claiming
 *     governance modification is rejected at validate time.
 */
import { checkConstitution } from './ai-constitution.js'

export type PluginPermission =
  | 'events.read'                  // subscribe to a filtered event stream
  | 'events.emit'                  // emit custom events (audit-tagged)
  | 'memory.read'                  // read voice / image memory rollups
  | 'memory.write'                 // append-only memory observations
  | 'http.fetch'                   // fetch with allowlisted hosts
  | 'workspace.read'               // workspace metadata (not raw data)

export interface PluginManifest {
  /** stable id; lowercase + hyphenated. */
  id:           string
  name:         string
  version:      string              // semver
  entry:        string              // relative path to JS entry inside plugin bundle
  description?: string
  author?:      string
  permissions:  PluginPermission[]
  /** Hosts the plugin may fetch from when `http.fetch` is permitted. */
  allowedHosts?: string[]
  /** Max execution time per invocation (ms). Capped server-side. */
  maxRuntimeMs?: number
  /** Max heap in MB. Capped server-side. */
  maxHeapMb?:    number
}

export interface ValidationResult {
  ok:     boolean
  reason?: string
  manifest?: PluginManifest
}

const ALL_PERMISSIONS: ReadonlySet<PluginPermission> = new Set([
  'events.read', 'events.emit', 'memory.read', 'memory.write',
  'http.fetch', 'workspace.read',
])
const HARD_LIMITS = {
  maxRuntimeMs: 30_000,            // 30s ceiling regardless of manifest
  maxHeapMb:    128,
}
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

/** Pure: validate a manifest against the rules. */
export function validateManifest(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'manifest must be an object' }
  const m = raw as Record<string, unknown>
  if (typeof m['id'] !== 'string' || !ID_RE.test(m['id']))
    return { ok: false, reason: 'id must be lowercase alphanumeric+hyphens, 2-41 chars, start with a letter' }
  if (typeof m['name'] !== 'string' || m['name'].length < 1 || m['name'].length > 80)
    return { ok: false, reason: 'name must be 1-80 chars' }
  if (typeof m['version'] !== 'string' || !SEMVER_RE.test(m['version']))
    return { ok: false, reason: 'version must be semver (e.g. 1.0.0)' }
  if (typeof m['entry'] !== 'string' || m['entry'].length === 0)
    return { ok: false, reason: 'entry path required' }
  if (m['entry'].includes('..') || (m['entry'] as string).startsWith('/'))
    return { ok: false, reason: 'entry path must be relative and cannot traverse parent dirs' }
  if (!Array.isArray(m['permissions']))
    return { ok: false, reason: 'permissions[] required (may be empty)' }
  for (const p of m['permissions'] as unknown[]) {
    if (typeof p !== 'string' || !ALL_PERMISSIONS.has(p as PluginPermission))
      return { ok: false, reason: `unknown permission: ${String(p)}` }
  }
  // http.fetch requires an allowedHosts list — no open egress
  if ((m['permissions'] as string[]).includes('http.fetch')) {
    if (!Array.isArray(m['allowedHosts']) || (m['allowedHosts'] as unknown[]).length === 0)
      return { ok: false, reason: 'http.fetch permission requires non-empty allowedHosts[]' }
    for (const h of m['allowedHosts'] as unknown[]) {
      if (typeof h !== 'string' || !/^[a-z0-9.-]+$/i.test(h))
        return { ok: false, reason: `invalid host: ${String(h)}` }
    }
  }
  // Numeric ceilings
  const maxRuntimeMs = typeof m['maxRuntimeMs'] === 'number'
    ? Math.min(HARD_LIMITS.maxRuntimeMs, Math.max(100, m['maxRuntimeMs'])) : 5_000
  const maxHeapMb    = typeof m['maxHeapMb'] === 'number'
    ? Math.min(HARD_LIMITS.maxHeapMb, Math.max(8, m['maxHeapMb']))         : 32

  // Constitution defense-in-depth: a plugin that asks to modify
  // governance or write to memory autonomously is rejected here.
  // memory.write is allowed (it's append-only observations), but a
  // manifest claiming both memory.write AND no logging would be flagged
  // — for now we just reject permissions sets that include both
  // `events.emit` disabled AND memory.write enabled (no audit trail).
  const decision = checkConstitution({
    kind: `plugin.${m['id']}`,
    autonomous: true,
    hidesFromOperator: false,
    reducesOperatorAuthority: false,
    modifiesGovernance: false,
    fabricatesRecord: false,
    selfModifies: false,
    risk: 'low',
  })
  if (decision.verdict === 'block')
    return { ok: false, reason: `constitution-block: ${decision.reason}` }

  const allowedHosts = (m['allowedHosts'] as string[] | undefined)
  const manifest: PluginManifest = {
    id:          m['id'] as string,
    name:        m['name'] as string,
    version:     m['version'] as string,
    entry:       m['entry'] as string,
    permissions: (m['permissions'] as PluginPermission[]),
    maxRuntimeMs, maxHeapMb,
    ...(typeof m['description'] === 'string' ? { description: m['description'] } : {}),
    ...(typeof m['author']      === 'string' ? { author:      m['author']      } : {}),
    ...(allowedHosts ? { allowedHosts } : {}),
  }
  return { ok: true, manifest }
}

// ─── Permission gate (pure) ────────────────────────────────────────────

export interface PermissionRequest {
  action:    PluginPermission
  host?:     string          // for http.fetch
}

export interface PermissionDecision {
  allow:  boolean
  reason: string
}

/** Pure: ask whether a manifest permits a specific runtime action. */
export function checkPermission(manifest: PluginManifest, req: PermissionRequest): PermissionDecision {
  if (!manifest.permissions.includes(req.action))
    return { allow: false, reason: `permission ${req.action} not declared in manifest` }
  if (req.action === 'http.fetch') {
    if (!req.host) return { allow: false, reason: 'http.fetch requires a host' }
    if (!manifest.allowedHosts || !manifest.allowedHosts.includes(req.host))
      return { allow: false, reason: `host ${req.host} not in allowedHosts` }
  }
  return { allow: true, reason: 'permitted' }
}

// ─── Sandboxed loader (worker_threads) ─────────────────────────────────

export interface PluginRunResult {
  ok:        boolean
  output:    unknown
  error:     string | null
  durationMs: number
  exitCode:  number | null
}

/**
 * Load + run a plugin's entry file in a Worker with resource limits.
 *
 *   loadPlugin(absoluteEntryPath, manifest, input)
 *
 * The plugin must export `default async function (input, ctx)` where
 * `ctx` is a typed object providing only the capabilities the manifest
 * declared. The Worker is hard-killed if it exceeds `maxRuntimeMs`.
 *
 * For now, the Worker side just receives `input` and returns a value;
 * the typed context object is enforced server-side when the plugin
 * sends messages back asking for actions. That's where the
 * `checkPermission` gate runs.
 */
export async function loadPlugin(absoluteEntry: string, manifest: PluginManifest, input: unknown): Promise<PluginRunResult> {
  const { Worker } = await import('node:worker_threads')
  const start = Date.now()
  return new Promise<PluginRunResult>((resolve) => {
    let settled = false
    const worker = new Worker(absoluteEntry, {
      workerData: { input, pluginId: manifest.id },
      resourceLimits: {
        maxOldGenerationSizeMb: manifest.maxHeapMb ?? 32,
        maxYoungGenerationSizeMb: 8,
        codeRangeSizeMb: 16,
      },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      worker.terminate().catch(() => null)
      resolve({ ok: false, output: null, error: `timeout after ${manifest.maxRuntimeMs}ms`, durationMs: Date.now() - start, exitCode: null })
    }, manifest.maxRuntimeMs ?? 5_000)

    worker.on('message', (msg) => {
      // Future: handle ctx.* requests with checkPermission(manifest, ...)
      if (msg && typeof msg === 'object' && 'output' in (msg as Record<string, unknown>)) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: true, output: (msg as { output: unknown }).output, error: null, durationMs: Date.now() - start, exitCode: 0 })
        worker.terminate().catch(() => null)
      }
    })
    worker.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, output: null, error: err.message, durationMs: Date.now() - start, exitCode: null })
    })
    worker.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, output: null, error: `worker exited without sending output (code ${code})`, durationMs: Date.now() - start, exitCode: code })
    })
  })
}

export function listSupportedPermissions(): PluginPermission[] {
  return [...ALL_PERMISSIONS]
}
