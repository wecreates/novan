/**
 * R146.219 — Novan Brain v2: tabbed UI.
 *   Chat tab — same as R215 with skill events
 *   Metrics tab — skill leaderboard + recent outcomes + routing + cost
 */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan · Brain</title>
<style>
  :root { --bg:#0a0a0f; --panel:#111118; --line:#1f1f2e; --text:#e8e8f0; --muted:#878796; --accent:#7c9cff; --warn:#f5a524; --crit:#f43f5e; --ok:#10b981; --skill:#a855f7; --tool:#06b6d4; --mem:#f59e0b; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; display: flex; flex-direction: column; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; letter-spacing: 0.5px; }
  nav { display: flex; gap: 4px; margin-left: 12px; }
  nav button { background: transparent; color: var(--muted); border: 0; padding: 6px 14px; cursor: pointer; font-size: 13px; border-radius: 6px; }
  nav button.active { background: var(--panel); color: var(--text); }
  nav button:hover { color: var(--text); }
  .toolbar { display: flex; gap: 8px; margin-left: auto; align-items: center; }
  input { background: var(--panel); border: 1px solid var(--line); color: var(--text); padding: 6px 10px; border-radius: 6px; font: inherit; }
  button.primary { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 500; }
  button.primary:hover { opacity: 0.85; }
  button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .pane { display: none; flex: 1; overflow-y: auto; }
  .pane.active { display: block; }
  /* Chat tab */
  #convo { padding: 20px 24px; }
  .turn { margin-bottom: 18px; }
  .role { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); margin-bottom: 6px; }
  .turn.user .role { color: var(--accent); }
  .turn.assistant .role { color: var(--ok); }
  .body { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .event { background: var(--panel); border-left: 3px solid var(--tool); padding: 8px 12px; margin: 6px 0; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .event.skill { border-left-color: var(--skill); }
  .event.memory { border-left-color: var(--mem); }
  .event.chapter { border-left-color: var(--warn); }
  .event.error { border-left-color: var(--crit); }
  .event .label { color: var(--muted); margin-right: 8px; }
  .empty { color: var(--muted); font-style: italic; padding: 40px 0; text-align: center; }
  footer { border-top: 1px solid var(--line); padding: 14px 20px; display: flex; gap: 10px; }
  textarea { flex: 1; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 10px 12px; font: inherit; resize: none; min-height: 50px; max-height: 200px; }
  .status { font-size: 11px; color: var(--muted); margin-top: 4px; padding: 0 20px 8px; }
  /* Metrics tab */
  .metrics { padding: 20px 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
  .card .row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .card .row:last-child { border-bottom: 0; }
  .card .label { color: var(--muted); }
  .card .val { font-variant-numeric: tabular-nums; }
  .bar { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin-top: 4px; }
  .bar > span { display: block; height: 100%; background: var(--ok); }
  .bar.warn > span { background: var(--warn); }
  .leaderboard .row { gap: 12px; align-items: center; }
  .leaderboard .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .leaderboard .winrate { width: 60px; text-align: right; }
  .num { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .small { font-size: 11px; color: var(--muted); }
  pre { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<header>
  <h1>Novan · Brain</h1>
  <nav>
    <button id="tab-chat" class="active" onclick="setTab('chat')">Chat</button>
    <button id="tab-metrics" onclick="setTab('metrics')">Metrics</button>
  </nav>
  <div class="toolbar">
    <input id="ws" value="default" style="max-width:120px" placeholder="workspace">
    <input id="token" type="password" placeholder="X-Admin-Token" style="max-width:180px">
    <button class="primary" onclick="refresh()">Refresh</button>
  </div>
</header>

<!-- Chat tab -->
<div id="pane-chat" class="pane active">
  <div id="convo">
    <div class="empty">Talk to Novan. The brain auto-picks skills, runs low-risk ops inline, writes memories, marks chapters.</div>
  </div>
</div>

<!-- Metrics tab -->
<div id="pane-metrics" class="pane">
  <div class="metrics" id="metrics-body">
    <div class="empty">Click Refresh to load metrics.</div>
  </div>
</div>

<div class="status" id="status"></div>

<footer id="footer-chat">
  <textarea id="input" placeholder="Ask anything… (Shift+Enter for newline)" autofocus></textarea>
  <button class="primary" id="send" onclick="send()">Send</button>
</footer>

<script>
const $ = (id) => document.getElementById(id)
const ws = () => $('ws').value || 'default'
const token = () => $('token').value || ''
const history = []
let currentTab = 'chat'

function setTab(name) {
  currentTab = name
  for (const t of ['chat', 'metrics']) {
    $('tab-' + t).classList.toggle('active', t === name)
    $('pane-' + t).classList.toggle('active', t === name)
  }
  $('footer-chat').style.display = name === 'chat' ? 'flex' : 'none'
  if (name === 'metrics') loadMetrics()
}

async function call(op, params) {
  const r = await fetch('/admin/brain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token() ? { 'X-Admin-Token': token() } : {}) },
    body: JSON.stringify({ op, workspaceId: ws(), params: params || {} }),
  })
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || op + ' failed')
  return j.result
}

function escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

function renderEvent(e) {
  const cls = e.kind || 'tool'
  let body = ''
  if (e.kind === 'skill') body = '<span class="label">SKILL</span> ' + escape(e.name) + ' activated'
  else if (e.kind === 'tool_call') body = '<span class="label">' + (e.queued ? 'QUEUED' : 'CALL') + '</span> ' + escape(e.op) + ' ' + escape(JSON.stringify(e.params).slice(0, 200))
  else if (e.kind === 'tool_done') body = '<span class="label">' + (e.error ? 'ERR' : 'DONE') + '</span> ' + escape(e.op) + (e.error ? ' — ' + escape(e.error) : ' — ' + escape(JSON.stringify(e.result || {}).slice(0, 200)))
  else if (e.kind === 'memory') body = '<span class="label">MEM</span> ' + escape(e.key) + ' = ' + escape(e.value.slice(0, 150))
  else if (e.kind === 'chapter') body = '<span class="label">CHAPTER</span> ' + escape(e.title)
  else body = escape(JSON.stringify(e))
  return '<div class="event ' + cls + '">' + body + '</div>'
}

function renderChat() {
  if (history.length === 0) {
    $('convo').innerHTML = '<div class="empty">Talk to Novan. The brain auto-picks skills, runs low-risk ops inline, writes memories, marks chapters.</div>'
    return
  }
  $('convo').innerHTML = history.map(h => {
    if (h.role === 'event') return renderEvent(h)
    const body = escape(h.content).replace(/\\n/g, '<br>')
    return \`<div class="turn \${h.role}"><div class="role">\${h.role}</div><div class="body">\${body}</div></div>\`
  }).join('')
  $('convo').scrollTop = $('convo').scrollHeight
}

async function send() {
  const text = $('input').value.trim()
  if (!text) return
  $('send').disabled = true
  $('status').textContent = 'thinking…'
  history.push({ role: 'user', content: text })
  $('input').value = ''
  renderChat()
  try {
    const res = await call('brain.loop.run', {
      messages: history.filter(h => h.role !== 'event'),
      maxSteps: 5,
    })
    if (res.skill) history.push({ role: 'event', kind: 'skill', name: res.skill })
    for (const t of res.toolCalls || []) {
      history.push({ role: 'event', kind: 'tool_call', op: t.op, params: t.params, queued: !!t.queued })
      if (t.result !== undefined || t.error) history.push({ role: 'event', kind: 'tool_done', op: t.op, result: t.result, error: t.error })
    }
    for (const m of res.memories || []) history.push({ role: 'event', kind: 'memory', key: m.key, value: m.value })
    if (res.chapter) history.push({ role: 'event', kind: 'chapter', title: res.chapter })
    history.push({ role: 'assistant', content: res.content || '(no content)' })
    $('status').textContent = \`\${res.toolCalls?.length || 0} tool calls · cost $\${(res.costUsd || 0).toFixed(4)}\`
  } catch (e) {
    history.push({ role: 'event', kind: 'error', op: 'brain.loop.run', error: e.message })
    $('status').textContent = 'error'
  }
  $('send').disabled = false
  renderChat()
  $('input').focus()
}

async function loadMetrics() {
  $('status').textContent = 'loading metrics…'
  try {
    const [m, h] = await Promise.all([
      call('brain.metrics'),
      call('brain.health').catch(() => null),
    ])
    $('metrics-body').innerHTML = renderHealth(h) + renderMetrics(m)
    $('status').textContent = 'metrics refreshed ' + new Date().toLocaleTimeString()
  } catch (e) {
    $('metrics-body').innerHTML = \`<div class="empty">Error: \${escape(e.message)}</div>\`
    $('status').textContent = 'metrics error'
  }
}

// R146.261 — brain.health card at the top of the metrics tab.
function renderHealth(h) {
  if (!h) return ''
  const color = h.overall === 'healthy' ? '#0c8' : h.overall === 'degraded' ? '#fa0' : '#f44'
  const sym = h.overall === 'healthy' ? '✓' : h.overall === 'degraded' ? '⚠' : '✗'
  const cells = [
    { label: 'Cost', value: \`$\${h.cost.spent.toFixed(2)} / $\${h.cost.cap.toFixed(2)}\`, warn: h.cost.over },
    { label: 'Backup', value: h.backup.status + (h.backup.ageHours !== null ? \` (\${h.backup.ageHours.toFixed(1)}h)\` : ''), warn: h.backup.status !== 'fresh' },
    { label: 'Applier', value: h.applier.status, warn: h.applier.status !== 'alive' },
    { label: 'Cron', value: h.cron.missing === 0 ? 'all firing' : \`\${h.cron.missing} missing\`, warn: h.cron.missing > 0 },
    { label: 'Errors 1h', value: h.errors.last1h + '', warn: h.errors.last1h > 5 },
    { label: 'Skills', value: \`\${h.skills.total}\${h.skills.recentWinRate !== null ? ' · ' + (h.skills.recentWinRate * 100).toFixed(0) + '% win' : ''}\`, warn: false },
  ]
  return \`<div class="card" style="border-left:3px solid \${color};margin-bottom:1em">
    <h2 style="color:\${color}">\${sym} Platform Health: \${h.overall.toUpperCase()}</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.5em">
      \${cells.map(c => \`<div class="row" style="\${c.warn ? 'color:#f44' : ''}">
        <span class="label">\${c.label}</span>
        <span class="val">\${escape(c.value)}</span>
      </div>\`).join('')}
    </div>
  </div>\`
}

function renderMetrics(m) {
  const parts = []
  // Skill leaderboard
  parts.push(\`<div class="grid">
    <div class="card leaderboard">
      <h2>Skill Leaderboard (\${m.skills.length})</h2>
      \${m.skills.length === 0 ? '<div class="empty">No skills registered yet.</div>' : m.skills.map(s => {
        const pct = (s.winRate * 100).toFixed(0)
        return \`<div class="row">
          <span class="name" title="\${escape(s.description)}">\${escape(s.name)}</span>
          <span class="small">\${s.wins}/\${s.uses}</span>
          <span class="winrate">\${pct}%</span>
        </div>\`
      }).join('')}
    </div>
    <div class="card">
      <h2>Cost 24h</h2>
      \${m.cost24h.length === 0 ? '<div class="empty">No AI calls yet.</div>' : m.cost24h.map(c =>
        \`<div class="row"><span class="label">\${escape(c.provider)}</span><span class="val">$\${c.costUsd.toFixed(4)} · \${c.calls} calls</span></div>\`
      ).join('')}
    </div>
    <div class="card">
      <h2>HTTP Latency</h2>
      <div class="row"><span class="label">Requests</span><span class="val">\${m.http.snapshotsTotal || 0}</span></div>
      \${m.http.p50 !== undefined ? \`
        <div class="row"><span class="label">p50</span><span class="val">\${m.http.p50}ms</span></div>
        <div class="row"><span class="label">p95</span><span class="val">\${m.http.p95}ms</span></div>
        <div class="row"><span class="label">p99</span><span class="val">\${m.http.p99}ms</span></div>
      \` : '<div class="small">Histogram empty — fire some traffic.</div>'}
    </div>
    <div class="card">
      <h2>Workplace</h2>
      <div class="row"><span class="label">Memories</span><span class="val">\${m.workplace.memories}</span></div>
      <div class="row"><span class="label">Chapters 7d</span><span class="val">\${m.workplace.chapters}</span></div>
      <div class="row"><span class="label">Hooks</span><span class="val">\${m.workplace.hooks}</span></div>
      <div class="row"><span class="label">Schedules</span><span class="val">\${m.workplace.schedules}</span></div>
      <div class="row"><span class="label">Pending Q</span><span class="val">\${m.workplace.pendingQuestions}</span></div>
      <div class="row"><span class="label">Spawn tasks</span><span class="val">\${m.workplace.spawnTasks}</span></div>
      <div class="row"><span class="label">MCP connectors</span><span class="val">\${m.workplace.connectors}</span></div>
    </div>
  </div>\`)
  // Recent outcomes
  parts.push(\`<div style="margin-top:16px">
    <div class="card">
      <h2>Recent Skill Outcomes (\${m.recentOutcomes.length})</h2>
      \${m.recentOutcomes.length === 0 ? '<div class="empty">No outcomes recorded yet.</div>' : m.recentOutcomes.map(o =>
        \`<div class="row">
          <span class="name">\${escape(o.skillName)}</span>
          <span class="small">via \${o.picker}</span>
          <span class="small">\${o.won === true ? 'WIN' : o.won === false ? 'LOSS' : '—'}</span>
          <span class="winrate">$\${o.costUsd.toFixed(4)}</span>
        </div>\`
      ).join('')}
    </div>
  </div>\`)
  // Routing health
  parts.push(\`<div style="margin-top:16px">
    <div class="card">
      <h2>Provider Routing (current health)</h2>
      \${m.routing.length === 0 ? '<div class="empty">Routing snapshot unavailable.</div>' : m.routing.map(r =>
        \`<div class="row"><span class="label">\${escape(r.task)}</span><span class="val small">\${r.chain.slice(0, 3).join(' → ') || '(no healthy provider)'}</span></div>\`
      ).join('')}
    </div>
  </div>\`)
  return parts.join('')
}

async function refresh() {
  if (currentTab === 'metrics') loadMetrics()
}

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
renderChat()
</script>
</body>
</html>`

export function novanBrainChatHtml(): string { return HTML }
