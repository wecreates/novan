/**
 * R608 — Connector audit, setup guides, and wire-checks.
 *
 * R581 tracks WHICH connectors exist and whether their env vars are set.
 * R608 adds three things on top:
 *
 *   1. connector.audit  — for each connector, report:
 *        * configured (from env-var presence)
 *        * lastOk / lastFail / consecutiveFails (from R581 health)
 *        * setupHint (where to get the key, what URL, what kind of account)
 *        * probeOp (which brain op to call to verify it works now)
 *        * status: 'green' (live) | 'yellow' (configured but never probed)
 *                | 'orange' (probe op exists but not configured)
 *                | 'red' (probe-op-less + unconfigured + no doc) — operator must handle
 *
 *   2. connector.wire_check — parallel call to every connector that has a
 *      probeOp; returns ok/fail per connector. Mirrors the "wire ALL"
 *      operator command.
 *
 *   3. R602 stuck-job reaper — autobrowser jobs stuck in 'running' >120s
 *      get marked failed with a 'reaped' reason so the recent-jobs UI is
 *      honest and any caller polling jobs gets a terminal state.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

// ─── Setup hints (one source of truth) ───────────────────────────────────────

interface SetupHint {
  connectorId:  string
  description:  string
  envVars:      string[]
  signupUrl?:   string
  docsUrl?:     string
  probeOp?:     string     // brain op the operator can call to verify
  notes?:       string
}

const SETUP_HINTS: Record<string, SetupHint> = {
  // POD platforms
  gumroad: {
    connectorId: 'gumroad',
    description: 'Gumroad — digital + POD revenue webhook receiver',
    envVars: ['GUMROAD_WEBHOOK_TOKEN'],
    signupUrl: 'https://app.gumroad.com/dashboard',
    docsUrl: 'https://help.gumroad.com/article/144-pings',
    notes: 'Generate a webhook ping URL token on Gumroad, paste into env.',
  },
  tiktok_shop: {
    connectorId: 'tiktok_shop',
    description: 'TikTok Shop — order webhooks',
    envVars: ['TIKTOK_WEBHOOK_TOKEN'],
    signupUrl: 'https://partner.tiktokshop.com/',
    notes: 'Approved seller required. Configure webhook endpoint after approval.',
  },
  inprnt: { connectorId: 'inprnt', description: 'INPRNT — fine-art print marketplace', envVars: [], signupUrl: 'https://www.inprnt.com/', notes: 'Manual seller application; no public API.' },
  fine_art_america: { connectorId: 'fine_art_america', description: 'Fine Art America — POD + Pixels.com sync', envVars: [], signupUrl: 'https://fineartamerica.com/joinpremium.html', notes: 'Premium seller required for storefront.' },
  redbubble: { connectorId: 'redbubble', description: 'Redbubble — apparel + accessories POD', envVars: [], signupUrl: 'https://www.redbubble.com/portfolio/signup', notes: 'Account-only; no public API yet.' },
  etsy: {
    connectorId: 'etsy', description: 'Etsy — handmade + digital marketplace OAuth',
    envVars: ['ETSY_API_KEY'],
    signupUrl: 'https://www.etsy.com/developers/your-apps',
    docsUrl:   'https://developers.etsy.com/documentation/',
    notes: 'Create app, complete OAuth onboarding to receive API key.',
  },
  zazzle:      { connectorId: 'zazzle',      description: 'Zazzle — POD apparel + home goods', envVars: [], signupUrl: 'https://www.zazzle.com/sell',  notes: 'Designer account only; manual upload.' },
  spreadshirt: { connectorId: 'spreadshirt', description: 'Spreadshirt — POD apparel',         envVars: [], signupUrl: 'https://www.spreadshirt.com/shop/open' },
  teepublic:   { connectorId: 'teepublic',   description: 'TeePublic — apparel POD',           envVars: [], signupUrl: 'https://www.teepublic.com/get_started' },
  displate:    { connectorId: 'displate',    description: 'Displate — metal-print POD',        envVars: [], signupUrl: 'https://displate.com/sell-on-displate' },
  threadless:  { connectorId: 'threadless',  description: 'Threadless — community POD',        envVars: [], signupUrl: 'https://www.threadless.com/make/sell-art-online/' },
  printful: {
    connectorId: 'printful',
    description: 'Printful — POD fulfillment API for TikTok Shop sync',
    envVars: ['PRINTFUL_API_KEY'],
    signupUrl: 'https://www.printful.com/dashboard/store',
    docsUrl:   'https://developers.printful.com/docs/',
    notes:     'API key from Settings → API. Wires to TikTok Shop after approval.',
  },

  // Image gen
  replicate:    { connectorId: 'replicate',   description: 'Replicate — hosted image/video models (LTX-2, SVD, Luma, etc.)', envVars: ['REPLICATE_API_TOKEN'], signupUrl: 'https://replicate.com/account/api-tokens', probeOp: 'video.ltx.health' },
  fal:          { connectorId: 'fal',          description: 'fal.ai — fast image inference',   envVars: ['FAL_KEY', 'FAL_API_KEY'], signupUrl: 'https://fal.ai/dashboard/keys' },
  openai:       { connectorId: 'openai',       description: 'OpenAI — image-gen (DALL·E) + embeddings + chat',  envVars: ['OPENAI_API_KEY'], signupUrl: 'https://platform.openai.com/api-keys' },
  stability:    { connectorId: 'stability',    description: 'Stability AI — SDXL / SD3 image-gen',  envVars: ['STABILITY_API_KEY'], signupUrl: 'https://platform.stability.ai/account/keys' },
  huggingface:  { connectorId: 'huggingface',  description: 'HuggingFace Inference — image-gen + video', envVars: ['HF_TOKEN'], signupUrl: 'https://huggingface.co/settings/tokens' },
  cloudflare_ai:{ connectorId: 'cloudflare_ai',description: 'Cloudflare Workers AI — image gen',envVars: ['CF_API_TOKEN'], signupUrl: 'https://dash.cloudflare.com/profile/api-tokens' },

  // Email
  postmark: {
    connectorId: 'postmark', description: 'Postmark — transactional email (R578 backend)',
    envVars: ['POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'],
    signupUrl: 'https://account.postmarkapp.com/sign_up',
    docsUrl:   'https://postmarkapp.com/developer/api/email-api',
    notes:     'Both vars required: server token + verified sender address.',
  },

  // Storage
  offsite_s3: {
    connectorId: 'offsite_s3', description: 'Offsite S3-compatible storage (DO Spaces, R2, AWS S3) — R543 backups',
    envVars: ['NOVAN_OFFSITE_S3_ENDPOINT', 'NOVAN_OFFSITE_S3_ACCESS_KEY', 'NOVAN_OFFSITE_S3_SECRET_KEY', 'NOVAN_OFFSITE_S3_BUCKET'],
    signupUrl: 'https://cloud.digitalocean.com/spaces',
    notes:     'Recommend DO Spaces; same provider as droplet keeps egress free.',
  },

  // Push
  web_push_vapid: {
    connectorId: 'web_push_vapid', description: 'VAPID web-push keys (R129 PWA push)',
    envVars: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    notes: 'Generate via `npx web-push generate-vapid-keys`. Subject = mailto:you@domain.',
  },

  // Voice
  omnivoice: {
    connectorId: 'omnivoice', description: 'OmniVoice Studio — local self-hosted TTS / ASR / clone / dub (R599)',
    envVars: ['OMNIVOICE_BASE_URL'],
    signupUrl: 'https://github.com/debpalash/OmniVoice-Studio/releases/latest',
    notes:     'Install local OmniVoice Studio app; set OMNIVOICE_BASE_URL=http://localhost:8000.',
    probeOp:   'voice.omni.health',
  },

  // Music
  acestep: {
    connectorId: 'acestep', description: 'ACE-Step — local music generation API (R600 song replicate backbone)',
    envVars: ['ACESTEP_BASE_URL'],
    docsUrl: 'https://github.com/ace-step/ACE-Step',
    notes: 'Service auto-spawns via R600 music.status when ACESTEP_BASE_URL points to a running server.',
    probeOp: 'music.status',
  },
}

// ─── Public surface ──────────────────────────────────────────────────────────

export type Status = 'green' | 'yellow' | 'orange' | 'red'

export interface AuditedConnector {
  connectorId:       string
  kind:              string
  configured:        boolean
  envVarsExpected:   string[]
  envVarsMissing:    string[]
  status:            Status
  lastOkAt:          number | null
  lastFailAt:        number | null
  consecutiveFails:  number
  description?:      string
  signupUrl?:        string
  docsUrl?:          string
  probeOp?:          string
  notes?:            string
}

export async function auditConnectors(workspaceId: string): Promise<AuditedConnector[]> {
  const { db: dbRef } = await import('../db/client.js')
  void dbRef
  const { connectorRegistry } = await import('./r581-connector-health.js')
  const observed = await connectorRegistry(workspaceId)

  const out: AuditedConnector[] = []
  for (const row of observed) {
    const id = row.connectorId
    const hint = SETUP_HINTS[id]
    const envVarsExpected = hint?.envVars ?? []
    const envVarsMissing = envVarsExpected.filter(v => !process.env[v])
    const configured = row.configured
    let status: Status = 'green'
    if (!configured && envVarsExpected.length === 0 && !hint?.signupUrl) status = 'red'
    else if (!configured && hint?.probeOp) status = 'orange'
    else if (!configured) status = 'orange'
    else if (configured && !row.lastOkAt && !row.lastFailAt) status = 'yellow'
    else if (configured && row.consecutiveFails > 0) status = 'orange'

    const audited: AuditedConnector = {
      connectorId: id, kind: row.kind, configured,
      envVarsExpected, envVarsMissing,
      status,
      lastOkAt:          row.lastOkAt ?? null,
      lastFailAt:        row.lastFailAt ?? null,
      consecutiveFails:  row.consecutiveFails,
    }
    if (hint?.description) audited.description = hint.description
    if (hint?.signupUrl)   audited.signupUrl   = hint.signupUrl
    if (hint?.docsUrl)     audited.docsUrl     = hint.docsUrl
    if (hint?.probeOp)     audited.probeOp     = hint.probeOp
    if (hint?.notes)       audited.notes       = hint.notes
    out.push(audited)
  }
  // Stable sort: red → orange → yellow → green, then by kind, then id.
  const rank: Record<Status, number> = { red: 0, orange: 1, yellow: 2, green: 3 }
  out.sort((a, b) => rank[a.status] - rank[b.status] || a.kind.localeCompare(b.kind) || a.connectorId.localeCompare(b.connectorId))
  return out
}

// ─── Wire-check: parallel probe of every connector with a probeOp ───────────

export interface WireCheckResult {
  connectorId: string
  probeOp:     string
  ok:          boolean
  result?:     unknown
  error?:      string
  durationMs:  number
}

export async function wireCheck(workspaceId: string): Promise<{ summary: { total: number; ok: number; fail: number; skipped: number }; checks: WireCheckResult[] }> {
  const audited = await auditConnectors(workspaceId)
  const probable = audited.filter(a => a.probeOp)
  const { OPERATIONS } = await import('./brain-task.js') as { OPERATIONS: Record<string, { handler: (ws: string, params: Record<string, unknown>) => Promise<unknown> }> }

  const checks = await Promise.all(probable.map(async (a): Promise<WireCheckResult> => {
    const t0 = Date.now()
    const spec = OPERATIONS[a.probeOp!]
    if (!spec) return { connectorId: a.connectorId, probeOp: a.probeOp!, ok: false, error: 'probe op not registered', durationMs: 0 }
    try {
      const r = await Promise.race([
        spec.handler(workspaceId, {}),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('probe timeout 15s')), 15_000)),
      ])
      const ok = !!(r && typeof r === 'object' && (('ok' in r && (r as { ok: unknown }).ok === true) || ('status' in r && (r as { status: unknown }).status === 'ok')))
      return { connectorId: a.connectorId, probeOp: a.probeOp!, ok, result: r, durationMs: Date.now() - t0 }
    } catch (e) {
      return { connectorId: a.connectorId, probeOp: a.probeOp!, ok: false, error: (e as Error).message.slice(0, 200), durationMs: Date.now() - t0 }
    }
  }))

  const ok = checks.filter(c => c.ok).length
  const fail = checks.filter(c => !c.ok).length
  return { summary: { total: audited.length, ok, fail, skipped: audited.length - probable.length }, checks }
}

// ─── R602 stuck-job reaper ──────────────────────────────────────────────────

const REAP_AFTER_MS = 2 * 60_000

export async function reapStuckAutobrowserJobs(): Promise<{ reaped: number }> {
  const cutoff = Date.now() - REAP_AFTER_MS
  const r = await db.execute(sql`
    UPDATE autobrowser_jobs
    SET status = 'failed',
        error = COALESCE(error, '') || ' [r608: reaped >2m running]',
        ended_at = ${Date.now()}
    WHERE status = 'running' AND COALESCE(started_at, created_at) <= ${cutoff}
    RETURNING id
  `).catch(() => [] as unknown[])
  return { reaped: (r as Array<{ id: string }>).length }
}

// ─── HTML widget for dashboard injection ────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function renderAuditWidget(workspaceId: string): Promise<string> {
  const audited = await auditConnectors(workspaceId)
  const counts = { green: 0, yellow: 0, orange: 0, red: 0 }
  for (const c of audited) counts[c.status]++
  const dotColor: Record<Status, string> = { green: '#22c55e', yellow: '#facc15', orange: '#fb923c', red: '#ef4444' }
  const rows = audited.map(c => `
    <tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor[c.status]};margin-right:6px"></span>${escapeHtml(c.connectorId)}</td>
      <td><span style="font-size:11px;color:#a1a1aa">${escapeHtml(c.kind)}</span></td>
      <td style="font-size:11px;color:${c.configured ? '#22c55e' : '#fb923c'}">${c.configured ? 'configured' : 'not configured'}</td>
      <td style="font-size:11px;color:#a1a1aa">${c.envVarsMissing.length > 0 ? 'missing: <code>' + c.envVarsMissing.map(escapeHtml).join('</code> <code>') + '</code>' : c.envVarsExpected.length === 0 ? 'no env vars' : 'all set'}</td>
      <td style="font-size:11px">${c.signupUrl ? `<a href="${escapeHtml(c.signupUrl)}" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:none">setup →</a>` : '<span style="color:#71717a">—</span>'}</td>
    </tr>
  `).join('')
  return `<div class="card" style="margin-top:18px">
    <h2>Connectors (R608) — ${counts.green} live · ${counts.yellow} config-only · ${counts.orange} needs setup · ${counts.red} no path</h2>
    <table style="font-size:12px"><thead><tr><th>Connector</th><th>Kind</th><th>Status</th><th>Env vars</th><th></th></tr></thead><tbody>
      ${rows}
    </tbody></table>
  </div>`
}
