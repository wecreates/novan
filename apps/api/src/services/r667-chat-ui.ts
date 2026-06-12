/**
 * R667 — Minimalist HTML chat UI for novan.chat.
 *
 * Single self-contained page (no build step, no JS dependencies). Talks to
 * R664 /chat/stream via EventSource. Persists sessionId in localStorage so
 * the operator can hit refresh without losing the thread. Token gate via
 * ?token=… query param, propagated to the EventSource URL.
 */

export function renderChatHtml(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan chat</title>
<style>
  :root { --bg:#f7f7f8; --fg:#1f1f1f; --me:#e7f0ff; --bot:#fff; --b:#e3e3e8; --acc:#4a7; }
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
  .wrap{max-width:780px;margin:0 auto;height:100vh;display:flex;flex-direction:column}
  header{padding:12px 16px;border-bottom:1px solid var(--b);display:flex;align-items:center;justify-content:space-between;background:#fff}
  header h1{margin:0;font-size:15px;font-weight:600}
  header .meta{font:12px monospace;color:#888}
  #log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .msg{padding:10px 12px;border:1px solid var(--b);border-radius:10px;max-width:88%;white-space:pre-wrap;word-wrap:break-word;background:var(--bot)}
  .msg.me{background:var(--me);border-color:#cfdcef;align-self:flex-end}
  .msg.sys{background:#fff7e0;border-color:#ffe9a0;font:12px monospace;color:#7a5d00;align-self:center;max-width:96%}
  .meta-row{font:11px monospace;color:#888;margin-top:6px}
  form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--b);background:#fff}
  textarea{flex:1;border:1px solid var(--b);border-radius:8px;padding:10px;font:14px inherit;resize:none;max-height:160px;outline:none}
  textarea:focus{border-color:var(--acc)}
  button{padding:10px 16px;border:none;border-radius:8px;background:var(--acc);color:#fff;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
  .actions{display:flex;gap:8px;align-items:center;padding:6px 16px;font:12px monospace;color:#888;border-top:1px solid var(--b);background:#fafafa}
  .actions a{color:#4a7;text-decoration:none}
  .actions a:hover{text-decoration:underline}
  .typing{display:inline-block;animation:blink 1s steps(2) infinite}
  @keyframes blink{50%{opacity:.3}}
</style></head>
<body>
<div class="wrap">
  <header>
    <h1>Novan</h1>
    <span class="meta" id="sessHud">—</span>
  </header>
  <div id="log"></div>
  <div class="actions">
    <a href="#" id="newSession">+ new session</a>
    <span id="status"></span>
    <span style="flex:1"></span>
    <span id="cost"></span>
  </div>
  <form id="f">
    <textarea id="m" rows="1" placeholder="Ask anything... (Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
  </form>
</div>
<script>
const log = document.getElementById('log');
const f   = document.getElementById('f');
const m   = document.getElementById('m');
const sendBtn = document.getElementById('send');
const sessHud = document.getElementById('sessHud');
const statusEl = document.getElementById('status');
const costEl   = document.getElementById('cost');
const newSession = document.getElementById('newSession');

const token = new URLSearchParams(location.search).get('token') || '';
const SESS_KEY = 'novan_chat_session_v1';
let sessionId = localStorage.getItem(SESS_KEY) || '';
let cumCost = 0;

function setSessHud() { sessHud.textContent = sessionId ? sessionId.slice(0, 18) : 'new'; }
setSessHud();

newSession.onclick = (e) => {
  e.preventDefault();
  sessionId = '';
  localStorage.removeItem(SESS_KEY);
  cumCost = 0; costEl.textContent = '';
  log.innerHTML = '';
  setSessHud();
};

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function autoresize() { m.style.height = 'auto'; m.style.height = Math.min(160, m.scrollHeight) + 'px'; }
m.addEventListener('input', autoresize);
m.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); }
});

f.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = m.value.trim();
  if (!msg) return;
  addMsg('me', msg);
  m.value = ''; autoresize();
  sendBtn.disabled = true; statusEl.textContent = 'thinking...';

  const botDiv = addMsg('bot', '');
  const typing = document.createElement('span');
  typing.className = 'typing'; typing.textContent = '▋';
  botDiv.appendChild(typing);

  const params = new URLSearchParams({ token, message: msg });
  if (sessionId) params.set('sessionId', sessionId);
  const es = new EventSource('/chat/stream?' + params.toString());

  let accumulated = '';
  es.addEventListener('start', () => { statusEl.textContent = 'streaming...'; });
  es.addEventListener('meta', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.sessionId && !sessionId) {
      sessionId = d.sessionId;
      localStorage.setItem(SESS_KEY, sessionId);
      setSessHud();
    }
    if (typeof d.costUsd === 'number') {
      cumCost += d.costUsd;
      costEl.textContent = '$' + cumCost.toFixed(4) + (d.toolCalls ? ' • ' + d.toolCalls + ' tools' : '');
    }
  });
  es.addEventListener('delta', (ev) => {
    accumulated += JSON.parse(ev.data).text;
    botDiv.textContent = accumulated;
    botDiv.appendChild(typing);
    log.scrollTop = log.scrollHeight;
  });
  es.addEventListener('done', () => {
    typing.remove();
    statusEl.textContent = '';
    sendBtn.disabled = false;
    es.close();
    m.focus();
  });
  es.addEventListener('error', (ev) => {
    let err = 'connection error';
    try { err = JSON.parse(ev.data).message || err; } catch {}
    typing.remove();
    if (!accumulated) botDiv.textContent = '[' + err + ']';
    statusEl.textContent = '';
    sendBtn.disabled = false;
    es.close();
  });
});

m.focus();
</script>
</body></html>`
}
