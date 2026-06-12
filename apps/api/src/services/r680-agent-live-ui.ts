/**
 * R680 — Live agent viewer at /ops/agents/live.
 *
 * Single-page HTML form: enter a goal + comma-list of tools, hit run, and
 * see the plan → act → reflect → done events arrive over R661 /agent/stream.
 * No build step, no JS deps. Token comes from the URL ?token=…
 */

export function renderAgentLiveHtml(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan live agent</title>
<style>
  :root { --bg:#f7f7f8; --fg:#1f1f1f; --b:#e3e3e8; --acc:#4a7; --plan:#7a5d00; --act:#1565c0; --reflect:#6a1b9a; --done:#2e7d32 }
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
  .wrap{max-width:920px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
  header{padding:12px 16px;border-bottom:1px solid var(--b);background:#fff;display:flex;align-items:center;justify-content:space-between}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .meta{font:12px monospace;color:#888}
  form{display:flex;gap:8px;padding:12px 16px;border-bottom:1px solid var(--b);background:#fff;flex-wrap:wrap;align-items:end}
  label{display:flex;flex-direction:column;gap:4px;font:12px system-ui;color:#444}
  label.grow{flex:1;min-width:260px}
  textarea, input{border:1px solid var(--b);border-radius:6px;padding:8px;font:13px inherit;outline:none}
  textarea{resize:vertical;min-height:42px}
  textarea:focus, input:focus{border-color:var(--acc)}
  button{padding:9px 14px;border:none;border-radius:6px;background:var(--acc);color:#fff;font-weight:600;cursor:pointer;height:38px}
  button:disabled{opacity:.5;cursor:not-allowed}
  #log{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:8px;background:var(--bg)}
  .ev{background:#fff;border:1px solid var(--b);border-radius:8px;padding:8px 12px;font:13px/1.4 system-ui}
  .ev .kind{display:inline-block;padding:1px 6px;border-radius:3px;font:11px monospace;color:#fff;margin-right:6px;vertical-align:middle}
  .ev.plan .kind{background:var(--plan)}
  .ev.act .kind{background:var(--act)}
  .ev.reflect .kind{background:var(--reflect)}
  .ev.done .kind,.ev.result .kind{background:var(--done)}
  .ev.start .kind{background:#555}
  .ev.error .kind{background:#c62828}
  .ev pre{margin:6px 0 0;background:#f6f6f8;border:1px solid var(--b);border-radius:4px;padding:6px 8px;font:12px Menlo,Consolas,monospace;overflow:auto;max-height:240px;white-space:pre-wrap}
  #answerCard{margin-top:12px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px 14px}
  #answerCard h2{margin:0 0 6px;font-size:13px;color:#2e7d32}
  #answerCard .a{font:14px/1.5 system-ui;white-space:pre-wrap}
  .status{font:12px monospace;color:#888;padding:6px 16px;background:#fff;border-bottom:1px solid var(--b)}
</style></head>
<body>
<div class="wrap">
  <header>
    <h1>Novan · live agent</h1>
    <span class="meta">R680 SSE viewer</span>
  </header>
  <form id="f">
    <label class="grow">Goal
      <textarea id="goal" placeholder="What should the agent do?" required>Use brain.list. Tell me the exact count.</textarea>
    </label>
    <label>Tools (comma-separated)
      <input id="tools" type="text" value="brain.list" placeholder="brain.list, web.search, …">
    </label>
    <label>Max loops
      <input id="maxLoops" type="number" min="1" max="8" value="2" style="width:70px">
    </label>
    <button id="run">Run</button>
  </form>
  <div class="status" id="status">ready</div>
  <div id="log"></div>
</div>
<script>
const f = document.getElementById('f');
const log = document.getElementById('log');
const statusEl = document.getElementById('status');
const goalEl = document.getElementById('goal');
const toolsEl = document.getElementById('tools');
const maxLoopsEl = document.getElementById('maxLoops');
const runBtn = document.getElementById('run');
const token = new URLSearchParams(location.search).get('token') || '';

function addEvent(kind, data) {
  const div = document.createElement('div');
  div.className = 'ev ' + kind;
  const head = document.createElement('div');
  head.innerHTML = '<span class="kind">' + kind + '</span>';
  // One-line summary preferred over full JSON when possible
  let summary = '';
  if (kind === 'plan') summary = (data.subgoal || '') + (data.tools_needed ? ' · tools=' + data.tools_needed.join(',') : '') + (data.fastPath ? ' · fast-path' : '');
  else if (kind === 'act') summary = (data.tool_calls || []).map(c => c.tool + (c.ok ? '✓' : '✗') + '(' + c.ms + 'ms)').join(', ');
  else if (kind === 'reflect') summary = 'done=' + data.done + (data.fastFinish ? ' · fast-finish' : '') + (data.reasoning ? ' · ' + String(data.reasoning).slice(0, 80) : '');
  else if (kind === 'done') summary = '';
  else summary = JSON.stringify(data).slice(0, 100);
  if (summary) head.appendChild(document.createTextNode(' ' + summary));
  div.appendChild(head);
  if (kind === 'result' || kind === 'error') {
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(data, null, 2);
    div.appendChild(pre);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

f.addEventListener('submit', (e) => {
  e.preventDefault();
  const goal = goalEl.value.trim();
  if (!goal) return;
  log.innerHTML = '';
  runBtn.disabled = true;
  statusEl.textContent = 'starting…';

  const params = new URLSearchParams({ token, goal, maxLoops: maxLoopsEl.value });
  const tools = toolsEl.value.trim();
  if (tools) params.set('tools', tools);

  const es = new EventSource('/agent/stream?' + params.toString());
  let resultCard = null;

  const handle = (kind) => (ev) => {
    const data = JSON.parse(ev.data);
    addEvent(kind, data);
    statusEl.textContent = kind;
    if (kind === 'result') {
      resultCard = document.createElement('div');
      resultCard.id = 'answerCard';
      resultCard.innerHTML = '<h2>Answer · ' + (data.tokens || '?') + ' tok · $' + (data.costUsd || 0) + ' · ' + (data.latencyMs || '?') + 'ms · ' + (data.loops || '?') + ' loops</h2><div class="a"></div>';
      resultCard.querySelector('.a').textContent = data.answer || '(no answer)';
      log.appendChild(resultCard);
      log.scrollTop = log.scrollHeight;
    }
  };
  ['start','plan','act','reflect','done','result','error'].forEach(k => es.addEventListener(k, handle(k)));
  es.addEventListener('result', () => { es.close(); runBtn.disabled = false; statusEl.textContent = 'done'; });
  es.addEventListener('error', () => { es.close(); runBtn.disabled = false; statusEl.textContent = 'error'; });
});
</script>
</body></html>`
}
