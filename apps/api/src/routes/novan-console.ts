/**
 * R146.194 — Novan Console: single-page operator UI for R160–R193.
 * Served at GET /console.html. Stateless. Reads from public-prefixed
 * brain ops + the loopback admin bridge when running same-origin.
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan · Console</title>
<style>
  :root { --bg:#0a0a0f; --panel:#111118; --line:#1f1f2e; --text:#e8e8f0; --muted:#878796; --accent:#7c9cff; --warn:#f5a524; --crit:#f43f5e; --ok:#10b981; }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 16px; letter-spacing: 0.5px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .ticker { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 14px; font-family: ui-monospace, monospace; font-size: 12px; color: var(--accent); margin-bottom: 16px; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  .label { color: var(--muted); font-size: 12px; }
  .val { font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; }
  .pill.ok { background: rgba(16,185,129,0.15); color: var(--ok); }
  .pill.warn { background: rgba(245,165,36,0.15); color: var(--warn); }
  .pill.crit { background: rgba(244,63,94,0.15); color: var(--crit); }
  .empty { color: var(--muted); font-style: italic; padding: 16px 0; text-align: center; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; font-weight: 500; }
  button.secondary { background: var(--line); color: var(--text); }
  button:hover { opacity: 0.85; }
  input { background: var(--panel); border: 1px solid var(--line); color: var(--text); padding: 6px 10px; border-radius: 6px; font: inherit; width: 100%; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .item { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .item:last-child { border-bottom: 0; }
  .item-title { font-weight: 500; margin-bottom: 4px; }
  .item-meta { font-size: 11px; color: var(--muted); }
  .action-queue .item { display: flex; justify-content: space-between; align-items: center; }
  .num { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; margin: 4px 0; }
  .small { font-size: 11px; color: var(--muted); }
  .err { color: var(--crit); font-family: ui-monospace, monospace; font-size: 12px; }
</style>
</head>
<body>
<h1>Novan · Console</h1>
<div class="ticker" id="ticker">Loading radar…</div>
<div class="toolbar">
  <label class="small">Workspace</label>
  <input id="ws" value="system" style="max-width:200px">
  <label class="small">Admin token (optional, loopback)</label>
  <input id="token" type="password" placeholder="X-Admin-Token" style="max-width:300px">
  <button onclick="refresh()">Refresh</button>
  <span id="status" class="small"></span>
</div>
<div class="grid" id="grid"></div>

<script>
const $ = (id) => document.getElementById(id)
const ws = () => $('ws').value || 'system'
const token = () => $('token').value || ''

async function call(op, params) {
  const r = await fetch('/admin/brain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token() ? { 'X-Admin-Token': token() } : {}) },
    body: JSON.stringify({ op, workspaceId: ws(), params: params || {} }),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw new Error(j.error || 'op failed')
  return j.result
}

function pill(severity) {
  const cls = severity === 'critical' || severity === 'urgent' ? 'crit'
    : severity === 'high' || severity === 'warn' ? 'warn' : 'ok'
  return \`<span class="pill \${cls}">\${severity}</span>\`
}

function card(title, html) {
  return \`<div class="card"><h2>\${title}</h2>\${html}</div>\`
}

function render(grid) { $('grid').innerHTML = grid.join('') }

async function refresh() {
  $('status').textContent = 'refreshing…'
  const cards = []
  try {
    const t = await call('radar.ticker')
    $('ticker').textContent = t.line || 'Scanning…'
  } catch (e) { $('ticker').textContent = 'Bridge offline: ' + e.message }

  // Dashboard summary
  try {
    const d = await call('dashboard.summary')
    cards.push(card('Action Queue', d.actionQueue.length === 0
      ? '<div class="empty">All clear.</div>'
      : '<div class="action-queue">' + d.actionQueue.map(a =>
          \`<div class="item"><div><div class="item-title">\${a.label}</div><div class="item-meta">priority \${a.priority} · \${a.kind}</div></div></div>\`
        ).join('') + '</div>'
    ))
    cards.push(card('Audience', \`
      <div class="row"><span class="label">Total list</span><span class="val">\${d.audience.listSize}</span></div>
      <div class="row"><span class="label">Engaged 14d</span><span class="val">\${d.audience.engagedLast14d}</span></div>
      <div class="row"><span class="label">Dormant</span><span class="val">\${d.audience.dormant}</span></div>
      <div class="row"><span class="label">Magnets</span><span class="val">\${d.audience.magnetCount}</span></div>
    \`))
    cards.push(card('Funnel (30d)', \`
      <div class="num">$\${(d.funnel.revenueCents/100).toFixed(2)}</div>
      <div class="small">\${d.funnel.purchases} purchases · \${d.funnel.signups} signups · \${d.funnel.clicks} clicks · \${d.funnel.views} views</div>
      <div class="row" style="margin-top:8px"><span class="label">View → Click</span><span class="val">\${(d.funnel.rates.viewToClick*100).toFixed(2)}%</span></div>
      <div class="row"><span class="label">Click → Signup</span><span class="val">\${(d.funnel.rates.clickToSignup*100).toFixed(2)}%</span></div>
      <div class="row"><span class="label">Signup → Buy</span><span class="val">\${(d.funnel.rates.signupToPurchase*100).toFixed(2)}%</span></div>
    \`))
    cards.push(card('Revenue', \`
      <div class="row"><span class="label">Whales</span><span class="val">\${d.revenue.whaleCount}</span></div>
      <div class="row"><span class="label">Cross-business pairs</span><span class="val">\${d.revenue.crossBusinessTopOverlap.length}</span></div>
      <div class="row"><span class="label">Top whale LTV</span><span class="val">$\${((d.revenue.top5Whales[0]?.predictedLtvCents||0)/100).toFixed(0)}</span></div>
    \`))
    cards.push(card('PAI Video', \`
      <div class="row"><span class="label">Runs 7d</span><span class="val">\${d.pai.runs7d}</span></div>
      <div class="row"><span class="label">Avg ISC pass rate</span><span class="val">\${(d.pai.avgIscPassRate*100).toFixed(0)}%</span></div>
      <div class="row"><span class="label">Active lessons</span><span class="val">\${d.pai.activeLessons}</span></div>
    \`))
    cards.push(card('Publishing', \`
      <div class="row"><span class="label">Pending plans</span><span class="val">\${d.publishing.pendingPlans}</span></div>
      <div class="row"><span class="label">Scheduled posts</span><span class="val">\${d.publishing.scheduledPosts}</span></div>
      <div class="row"><span class="label">Published 7d</span><span class="val">\${d.publishing.publishedLast7d}</span></div>
    \`))
    cards.push(card('Social', \`
      <div class="row"><span class="label">Open comments</span><span class="val">\${d.social.openCommentsTotal}</span></div>
      <div class="row"><span class="label">High-pri unread</span><span class="val">\${d.social.openHighPriority}</span></div>
      <div class="row"><span class="label">Reply drafts</span><span class="val">\${d.social.pendingReplyDrafts}</span></div>
      <div class="row"><span class="label">Sentiment 14d</span><span class="val">\${d.social.sentimentAvgLast14d.toFixed(2)}</span></div>
    \`))
  } catch (e) { cards.push(card('Dashboard', \`<div class="err">\${e.message}</div>\`)) }

  // Self-Dev findings + proposals
  try {
    const findings = await call('selfdev.findings', { status: 'open', limit: 10 })
    cards.push(card('Self-Dev · Open Findings', findings.length === 0
      ? '<div class="empty">No open findings.</div>'
      : findings.map(f => \`<div class="item">
          <div class="item-title">\${pill(f.severity)} \${f.title}</div>
          <div class="item-meta">\${f.dimension} · \${new Date(f.foundAt).toISOString().slice(0,16)}</div>
        </div>\`).join('')
    ))
  } catch (e) { cards.push(card('Self-Dev Findings', \`<div class="err">\${e.message}</div>\`)) }

  try {
    const proposals = await call('selfdev.proposals', { status: 'draft', limit: 10 })
    cards.push(card('Self-Dev · Pending Proposals', proposals.length === 0
      ? '<div class="empty">No pending proposals.</div>'
      : proposals.map(p => \`<div class="item">
          <div class="item-title">\${pill(p.riskLevel)} \${p.title}</div>
          <div class="item-meta">confidence \${(p.confidence*100).toFixed(0)}% · \${new Date(p.createdAt).toISOString().slice(0,16)}</div>
          <div style="margin-top:6px"><button onclick="approve('\${p.id}')">Approve</button> <button class="secondary" onclick="reject('\${p.id}')">Reject</button></div>
        </div>\`).join('')
    ))
  } catch (e) { cards.push(card('Self-Dev Proposals', \`<div class="err">\${e.message}</div>\`)) }

  // Health
  try {
    const cron = await fetch('/healthz/cron').then(r => r.json())
    const html = (cron.jobs || []).slice(0, 12).map(j =>
      \`<div class="row"><span class="label">\${j.type}</span><span class="val">\${j.count} · \${Math.round(j.lastAgoSec/60)}m</span></div>\`
    ).join('')
    cards.push(card('Cron Health (48h)', html || '<div class="empty">No cron events.</div>'))
  } catch (e) { cards.push(card('Cron Health', \`<div class="err">\${e.message}</div>\`)) }

  // Feature flags
  try {
    const flags = await call('flag.list')
    cards.push(card('Feature Flags', flags.map(f =>
      \`<div class="row"><span class="label" title="\${f.description || ''}">\${f.key}</span><span class="val">\${f.enabled ? pill('ok') : pill('warn')}</span></div>\`
    ).join('')))
  } catch (e) { cards.push(card('Feature Flags', \`<div class="err">\${e.message}</div>\`)) }

  render(cards)
  $('status').textContent = 'refreshed ' + new Date().toLocaleTimeString()
}

async function approve(id) {
  try {
    await call('selfdev.approve', { proposalId: id, approvedBy: 'console-operator', confirm: 'I_AUTHORIZE_PROPOSAL_APPROVAL' })
    refresh()
  } catch (e) { alert('Approve failed: ' + e.message) }
}
async function reject(id) {
  try { await call('selfdev.reject', { proposalId: id }); refresh() }
  catch (e) { alert('Reject failed: ' + e.message) }
}

refresh()
setInterval(refresh, 60_000)
</script>
</body>
</html>`

export function novanConsoleHtml(): string { return HTML }
