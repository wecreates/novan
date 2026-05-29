// scripts/platform-smoke.mjs — live integration smoke.
//
// Catalog derived from actual web pages (grep for `api.get<…>(\`/api/v1/…\`)`)
// + extra system paths (/health, /metrics, /api/v1/workspaces). For each
// URL we attach a realistic workspace_id (or skip if the endpoint
// doesn't accept one) and record status + an error excerpt.
//
// Classification:
//   ok          200/201
//   bad_input   400 (often "workspace_id required" — not a bug)
//   not_found   404 (route missing — real bug)
//   server_err  ≥500
//   unreachable timeout / network
//
// Run:
//   node scripts/platform-smoke.mjs
//   API_BASE=http://localhost:3001 node scripts/platform-smoke.mjs

const BASE = process.env.API_BASE ?? 'http://localhost:3001'
let WS = process.env.WORKSPACE_ID ?? 'default'

async function probe(path, opts = {}) {
  const url = `${BASE}${path}`
  const start = Date.now()
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(t)
    const text = await res.text().catch(() => '')
    const ms = Date.now() - start
    return { path, status: res.status, ok: res.ok, ms, body: text.slice(0, 280) }
  } catch (e) {
    return { path, status: 0, ok: false, ms: Date.now() - start, body: e.message }
  }
}

async function bootstrap() {
  try {
    const r = await probe('/api/v1/workspaces')
    if (r.ok) {
      const ws = JSON.parse(r.body)
      const first = ws?.data?.[0]?.id
      if (first) WS = first
    }
  } catch { /* keep default */ }
  console.log(`smoke targeting workspace_id=${WS}\n`)
}

// Real GET endpoints actually called by the web app. Sub-resources
// (e.g. `/conversations/:id/messages`) are exercised only when we have
// a real id; otherwise their root list endpoint is enough.
function catalog() {
  const ws = encodeURIComponent(WS)
  return [
    // System
    '/api/v1/health',
    '/health',
    '/health/ready',
    '/api/v1/workspaces',
    '/metrics',

    // Brain
    `/api/v1/brain/graph?workspace_id=${ws}&lod=systems`,
    `/api/v1/brain/search?workspace_id=${ws}&q=test&limit=3`,
    `/api/v1/brain/timeline?workspace_id=${ws}&from=${Date.now() - 3600_000}&to=${Date.now()}&bucket_ms=60000`,
    // decision-path needs a node id; we just probe that the prefix is alive
    `/api/v1/brain/decision-path/_smoke?workspace_id=${ws}`,

    // Chat
    `/api/v1/chat/providers?workspace_id=${ws}`,
    `/api/v1/chat/conversations?workspace_id=${ws}`,

    // Agency (new)
    `/api/v1/agency/catalog/status?workspace_id=${ws}`,
    `/api/v1/agency/departments?workspace_id=${ws}`,
    `/api/v1/agency/definitions?workspace_id=${ws}&limit=5`,
    `/api/v1/agency/delegations?workspace_id=${ws}`,

    // TTS (new)
    '/api/v1/tts/sidecar/health',
    `/api/v1/tts/profiles?workspace_id=${ws}`,

    // Intel-ops (recent)
    `/api/v1/intel-ops/models/trust?workspace_id=${ws}`,
    `/api/v1/intel-ops/models/degradation?workspace_id=${ws}`,
    `/api/v1/intel-ops/narrative/recent?workspace_id=${ws}`,
    `/api/v1/intel-ops/self/observe?workspace_id=${ws}`,
    `/api/v1/intel-ops/rhythm?workspace_id=${ws}`,
    `/api/v1/intel-ops/failover/health?workspace_id=${ws}`,
    `/api/v1/intel-ops/failover/state?workspace_id=${ws}`,
    '/api/v1/intel-ops/plugins/permissions',

    // Cognition / Truth / Economy / Commerce
    `/api/v1/cognition/snapshot?workspace_id=${ws}`,
    `/api/v1/cognition/chains?workspace_id=${ws}&limit=5`,
    `/api/v1/cognition/accuracy?workspace_id=${ws}`,
    `/api/v1/truth/drift/warnings?workspace_id=${ws}`,
    `/api/v1/truth/assumptions?workspace_id=${ws}`,
    `/api/v1/truth/assumptions/summary?workspace_id=${ws}`,
    `/api/v1/economy/chains?workspace_id=${ws}&limit=5`,
    `/api/v1/economy/war-room?workspace_id=${ws}`,
    `/api/v1/commerce/war-room?workspace_id=${ws}`,
    `/api/v1/commerce/trust?workspace_id=${ws}`,
    `/api/v1/commerce/governance/sovereignty?workspace_id=${ws}`,
    `/api/v1/commerce/governance/paused?workspace_id=${ws}`,
    `/api/v1/commerce/governance/alignment?workspace_id=${ws}`,
    `/api/v1/commerce/governance/ethical-blocks?workspace_id=${ws}&hours=24`,
    `/api/v1/commerce/governance/overrides?workspace_id=${ws}`,

    // Fabric / Sim / Mission / Identity
    `/api/v1/fabric/snapshot?workspace_id=${ws}`,
    `/api/v1/sim/war-room?workspace_id=${ws}`,
    `/api/v1/mission/charter`,
    `/api/v1/mission/adherence?workspace_id=${ws}`,
    `/api/v1/identity/drift?workspace_id=${ws}`,

    // Self-observation cluster
    `/api/v1/self/cron?workspace_id=${ws}`,
    `/api/v1/self/discovered-capabilities?workspace_id=${ws}`,
    `/api/v1/self/git/snapshots?workspace_id=${ws}`,
    `/api/v1/self/home?workspace_id=${ws}`,
    `/api/v1/self/introspect?workspace_id=${ws}`,
    `/api/v1/self/notification-drivers`,
    `/api/v1/self/patches?workspace_id=${ws}`,
    `/api/v1/self/preferences/providers?workspace_id=${ws}`,
    `/api/v1/self/preferences/workers?workspace_id=${ws}`,
    `/api/v1/self/proposals?workspace_id=${ws}`,
    `/api/v1/self/search/chains?workspace_id=${ws}&q=test`,

    // Runtime
    `/api/v1/runtime/status?workspace_id=${ws}`,
    `/api/v1/runtime/budgets?workspace_id=${ws}`,
    `/api/v1/runtime/calibration?workspace_id=${ws}`,
    `/api/v1/runtime/mind/recent?workspace_id=${ws}`,

    // Skills / Events / Workflows / Executive
    `/api/v1/skills?workspace_id=${ws}`,
    `/api/v1/skills/gaps?workspace_id=${ws}`,
    `/api/v1/events?workspace_id=${ws}&limit=5`,
    `/api/v1/workflows?workspace_id=${ws}`,
    `/api/v1/workflow-runs?workspace_id=${ws}`,
    `/api/v1/executive/state?workspace_id=${ws}`,
  ]
}

async function run() {
  await bootstrap()
  const paths = catalog()
  const results = []
  const POOL = 1   // serial — concurrency on the dev API surfaces phantom 500s
  const queue = paths.slice()
  let i = 0

  async function worker() {
    while (queue.length) {
      const p = queue.shift()
      if (!p) break
      const r = await probe(p)
      results.push(r)
      const idx = ++i
      const label = r.ok ? '✓'
        : r.status === 400 ? '⚠'
        : r.status === 404 ? '✗ 404'
        : r.status >= 500 ? '✗ 5xx'
        : r.status === 0 ? '✗ ⏱'
        : '·'
      process.stdout.write(`[${String(idx).padStart(2)}/${paths.length}] ${label.padEnd(5)} ${String(r.status).padStart(3)} ${r.path}\n`)
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker))

  const buckets = { ok: [], badInput: [], notFound: [], serverErr: [], unreachable: [], other: [] }
  for (const r of results) {
    if (r.status === 0)        buckets.unreachable.push(r)
    else if (r.status === 404) buckets.notFound.push(r)
    else if (r.status === 400) buckets.badInput.push(r)
    else if (r.status >= 500)  buckets.serverErr.push(r)
    else if (r.ok)             buckets.ok.push(r)
    else                       buckets.other.push(r)
  }

  console.log('\n══ Summary ═══════════════════════════════════════════════════')
  console.log(`  ✓ OK:           ${buckets.ok.length}`)
  console.log(`  ⚠ 400 (input):  ${buckets.badInput.length}`)
  console.log(`  ✗ 404 missing:  ${buckets.notFound.length}`)
  console.log(`  ✗ 5xx broken:   ${buckets.serverErr.length}`)
  console.log(`  ✗ unreachable:  ${buckets.unreachable.length}`)
  console.log(`  · other:        ${buckets.other.length}`)

  const fail = [...buckets.notFound, ...buckets.serverErr, ...buckets.unreachable]
  if (fail.length > 0) {
    console.log('\n══ Failures ═════════════════════════════════════════════════')
    for (const f of fail) {
      console.log(`  ${String(f.status).padStart(3)}  ${f.path}`)
      if (f.body) console.log(`        ${f.body.replace(/\s+/g, ' ').slice(0, 240)}`)
    }
  }

  process.exit(fail.length > 0 ? 1 : 0)
}

run()
