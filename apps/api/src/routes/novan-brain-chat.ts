/**
 * R146.215 — Novan Brain chat UI. Single-page operator chat that talks
 * to the R215 brain agentic loop via /admin/brain → brain.loop.run.
 *
 * Shows tool calls inline (skill activations, sub-agent dispatches,
 * memory write-backs, chapter markers). Mobile-friendly.
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
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 16px; }
  h1 { font-size: 16px; margin: 0; letter-spacing: 0.5px; }
  .toolbar { display: flex; gap: 8px; margin-left: auto; align-items: center; }
  input { background: var(--panel); border: 1px solid var(--line); color: var(--text); padding: 6px 10px; border-radius: 6px; font: inherit; }
  button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: 500; }
  button.secondary { background: var(--line); color: var(--text); }
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #convo { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .turn { margin-bottom: 18px; }
  .role { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); margin-bottom: 6px; }
  .turn.user .role { color: var(--accent); }
  .turn.assistant .role { color: var(--ok); }
  .body { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  .body code { background: var(--panel); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .body pre { background: var(--panel); padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  .event { background: var(--panel); border-left: 3px solid var(--tool); padding: 8px 12px; margin: 6px 0; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; }
  .event.skill { border-left-color: var(--skill); }
  .event.memory { border-left-color: var(--mem); }
  .event.chapter { border-left-color: var(--warn); }
  .event.error { border-left-color: var(--crit); }
  .event .label { color: var(--muted); margin-right: 8px; }
  footer { border-top: 1px solid var(--line); padding: 14px 20px; display: flex; gap: 10px; }
  textarea { flex: 1; background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 10px 12px; font: inherit; resize: none; min-height: 50px; max-height: 200px; }
  .status { font-size: 11px; color: var(--muted); margin-top: 4px; padding: 0 20px 8px; }
  .empty { color: var(--muted); font-style: italic; padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>Novan · Brain</h1>
  <div class="toolbar">
    <input id="ws" value="default" style="max-width:120px" placeholder="workspace">
    <input id="token" type="password" placeholder="X-Admin-Token" style="max-width:180px">
    <button class="secondary" onclick="clearConvo()">Clear</button>
  </div>
</header>
<div id="convo">
  <div class="empty">Talk to Novan. The brain auto-picks skills, runs low-risk ops inline, writes memories, marks chapters.</div>
</div>
<div class="status" id="status"></div>
<footer>
  <textarea id="input" placeholder="Ask anything… (Shift+Enter for newline)" autofocus></textarea>
  <button id="send" onclick="send()">Send</button>
</footer>

<script>
const $ = (id) => document.getElementById(id)
const ws = () => $('ws').value || 'default'
const token = () => $('token').value || ''
const history = []  // { role, content }

function render() {
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

function escape(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

async function send() {
  const text = $('input').value.trim()
  if (!text) return
  $('send').disabled = true
  $('status').textContent = 'thinking…'
  history.push({ role: 'user', content: text })
  $('input').value = ''
  render()

  try {
    const r = await fetch('/admin/brain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token() ? { 'X-Admin-Token': token() } : {}) },
      body: JSON.stringify({
        op: 'brain.loop.run',
        workspaceId: ws(),
        params: {
          messages: history.filter(h => h.role !== 'event'),
          maxSteps: 5,
        },
      }),
    })
    const j = await r.json()
    if (!j.ok) throw new Error(j.error || 'brain.loop.run failed')
    const res = j.result
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
  render()
  $('input').focus()
}

function clearConvo() { history.length = 0; render() }

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
render()
</script>
</body>
</html>`

export function novanBrainChatHtml(): string { return HTML }
