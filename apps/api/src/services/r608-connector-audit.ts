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
  /** R609 — connectors marked 'agent_managed' are driven via R357 novan-local-agent
   *  + R602 autobrowser pool. They are NEVER wired by API token. Audit shows them
   *  as 'manual' status, NOT as orange/needing-setup. */
  mode?:        'api' | 'agent_managed' | 'deprecated'
  replacedBy?:  string     // for deprecated connectors, what to use instead
}

const SETUP_HINTS: Record<string, SetupHint> = {
  // POD platforms — R609 operator decision: ALL POD stores are agent_managed via
  // R357 novan-local-agent + R602 autobrowser pool. No API tokens. The single
  // exception is gumroad which uses a webhook (not an API), and TikTok Shop
  // which uses a webhook once the operator is approved.
  gumroad: {
    connectorId: 'gumroad',
    description: 'Gumroad — digital + POD revenue webhook receiver',
    envVars: ['GUMROAD_WEBHOOK_TOKEN'],
    signupUrl: 'https://app.gumroad.com/dashboard',
    docsUrl: 'https://help.gumroad.com/article/144-pings',
    notes: 'Webhook-only (not API). Generate webhook ping URL token on Gumroad, paste into env.',
    mode: 'api',
  },
  tiktok_shop: {
    connectorId: 'tiktok_shop',
    description: 'TikTok Shop — webhook + R357 agent for catalog mgmt',
    envVars: ['TIKTOK_WEBHOOK_TOKEN'],
    signupUrl: 'https://partner.tiktokshop.com/',
    notes: 'Webhook only for order events. Listing/catalog mgmt is agent-managed.',
    mode: 'api',
  },
  inprnt:           { connectorId: 'inprnt',           description: 'INPRNT — fine-art prints (agent-managed via R357)',            envVars: [], signupUrl: 'https://www.inprnt.com/',                   mode: 'agent_managed', notes: 'No public API; R357 novan-local-agent drives the storefront.' },
  fine_art_america: { connectorId: 'fine_art_america', description: 'Fine Art America — POD + Pixels.com (agent-managed)',          envVars: [], signupUrl: 'https://fineartamerica.com/joinpremium.html', mode: 'agent_managed', notes: 'Premium seller. R357 drives storefront + listings.' },
  redbubble:        { connectorId: 'redbubble',        description: 'Redbubble — apparel POD (agent-managed via R357)',              envVars: [], signupUrl: 'https://www.redbubble.com/portfolio/signup', mode: 'agent_managed', notes: 'Account-only; agent drives storefront.' },
  etsy: {
    connectorId: 'etsy', description: 'Etsy — handmade marketplace (agent-managed; API denied for POD sellers)',
    envVars: [], signupUrl: 'https://www.etsy.com/sell',
    mode: 'agent_managed',
    notes: 'Etsy denies API access for POD sellers. R357 novan-local-agent drives listings + orders via the browser.',
  },
  zazzle:      { connectorId: 'zazzle',      description: 'Zazzle — POD apparel + home (agent-managed)',  envVars: [], signupUrl: 'https://www.zazzle.com/sell',                            mode: 'agent_managed' },
  spreadshirt: { connectorId: 'spreadshirt', description: 'Spreadshirt — POD apparel (agent-managed)',     envVars: [], signupUrl: 'https://www.spreadshirt.com/shop/open',                  mode: 'agent_managed' },
  teepublic:   { connectorId: 'teepublic',   description: 'TeePublic — apparel POD (agent-managed)',       envVars: [], signupUrl: 'https://www.teepublic.com/get_started',                  mode: 'agent_managed' },
  displate:    { connectorId: 'displate',    description: 'Displate — metal-print POD (agent-managed)',    envVars: [], signupUrl: 'https://displate.com/sell-on-displate',                  mode: 'agent_managed' },
  threadless:  { connectorId: 'threadless',  description: 'Threadless — community POD (agent-managed)',    envVars: [], signupUrl: 'https://www.threadless.com/make/sell-art-online/',      mode: 'agent_managed' },
  printful: {
    connectorId: 'printful', description: 'Printful — POD fulfillment (agent-managed; manual catalog sync)',
    envVars: [], signupUrl: 'https://www.printful.com/dashboard/store',
    mode: 'agent_managed',
    notes: 'Operator decision: skip API. R357 drives Printful dashboard for catalog + TikTok Shop sync.',
  },

  // Image gen — R609: free + open-source ONLY. Paid providers (Stability, fal,
  // Cloudflare, OpenAI DALL-E) are deprecated for image-gen but OpenAI remains
  // for embeddings + chat.
  replicate:    { connectorId: 'replicate',   description: 'Replicate — hosted models (LTX-2 video, NOT image-gen)', envVars: ['REPLICATE_API_TOKEN'], signupUrl: 'https://replicate.com/account/api-tokens', probeOp: 'video.ltx.health', mode: 'api', notes: 'Video only — image-gen routed to free providers (huggingface + pollinations).' },
  fal:          { connectorId: 'fal',          description: 'fal.ai (DEPRECATED for image-gen — use R609 free providers)',  envVars: ['FAL_KEY', 'FAL_API_KEY'], signupUrl: 'https://fal.ai/dashboard/keys',                  mode: 'deprecated', replacedBy: 'huggingface + pollinations (R609)' },
  openai:       { connectorId: 'openai',       description: 'OpenAI — embeddings (R582) + chat fallback (NOT image-gen)',     envVars: ['OPENAI_API_KEY'], signupUrl: 'https://platform.openai.com/api-keys', mode: 'api', notes: 'Image-gen disabled per operator. Used for text-embedding-3-small + GPT chat fallback only.' },
  stability:    { connectorId: 'stability',    description: 'Stability AI (DEPRECATED — use R609 free providers)',           envVars: ['STABILITY_API_KEY'], signupUrl: 'https://platform.stability.ai/account/keys', mode: 'deprecated', replacedBy: 'huggingface + pollinations (R609)' },
  huggingface:  { connectorId: 'huggingface',  description: 'HuggingFace — primary FREE image-gen (FLUX.1-schnell, SDXL, SD3)', envVars: ['HF_TOKEN'], signupUrl: 'https://huggingface.co/settings/tokens', probeOp: 'image.free.health', mode: 'api', notes: 'R609 tier-1 free provider. Apache-2.0 FLUX-schnell outputs are commercially unencumbered.' },
  cloudflare_ai:{ connectorId: 'cloudflare_ai',description: 'Cloudflare Workers AI (DEPRECATED — use R609 free providers)',  envVars: ['CF_API_TOKEN'], signupUrl: 'https://dash.cloudflare.com/profile/api-tokens', mode: 'deprecated', replacedBy: 'huggingface + pollinations (R609)' },
  pollinations: { connectorId: 'pollinations', description: 'Pollinations.ai — zero-auth free FLUX-backed image-gen (R609 tier-2 fallback)', envVars: [], probeOp: 'image.free.health', mode: 'api', notes: 'No env vars, no signup. Always-on free public good — credit when used commercially.' },

  // Email
  postmark: {
    connectorId: 'postmark', description: 'Postmark — transactional email (R578 backend, R611 SMTP fallback also supported)',
    envVars: ['POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'],
    signupUrl: 'https://account.postmarkapp.com/sign_up',
    docsUrl:   'https://postmarkapp.com/developer/api/email-api',
    notes:     'Either path works: Postmark API or R611 SMTP (any provider: AWS SES, Gmail, Fastmail).',
  },
  smtp: {
    connectorId: 'smtp', description: 'R611 — direct SMTP fallback (zero-dep, implicit TLS port 465)',
    envVars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
    notes:    'Works with AWS SES, Gmail App Passwords, Postmark SMTP, any provider. Set SMTP_PORT if not 465. EMAIL_FROM still required (or SMTP_FROM override).',
    probeOp:  'email.smtp.health',
    mode:     'api',
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

export type Status = 'green' | 'yellow' | 'orange' | 'red' | 'manual' | 'deprecated'

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
  mode?:             'api' | 'agent_managed' | 'deprecated'
  replacedBy?:       string
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
    // R609 — mode trumps env checks for status. agent_managed connectors are
    // INTENTIONALLY without an API key; deprecated connectors should NOT show
    // as orange-needs-setup, they should show as superseded.
    if (hint?.mode === 'agent_managed') status = 'manual'
    else if (hint?.mode === 'deprecated') status = 'deprecated'
    else if (!configured && envVarsExpected.length === 0 && !hint?.signupUrl) status = 'red'
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
    if (hint?.mode)        audited.mode        = hint.mode
    if (hint?.replacedBy)  audited.replacedBy  = hint.replacedBy
    out.push(audited)
  }
  // Stable sort: red → orange → yellow → green → manual → deprecated
  const rank: Record<Status, number> = { red: 0, orange: 1, yellow: 2, green: 3, manual: 4, deprecated: 5 }
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
  const counts: Record<Status, number> = { green: 0, yellow: 0, orange: 0, red: 0, manual: 0, deprecated: 0 }
  for (const c of audited) counts[c.status]++
  const dotColor: Record<Status, string> = { green: '#22c55e', yellow: '#facc15', orange: '#fb923c', red: '#ef4444', manual: '#60a5fa', deprecated: '#71717a' }
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
    <h2>Connectors (R608) — ${counts.green} live · ${counts.yellow} config-only · ${counts.orange} needs setup · ${counts.manual} 🤖 agent-managed · ${counts.deprecated} ↪ replaced</h2>
    <table style="font-size:12px"><thead><tr><th>Connector</th><th>Kind</th><th>Status</th><th>Env vars</th><th></th></tr></thead><tbody>
      ${rows}
    </tbody></table>
  </div>`
}
