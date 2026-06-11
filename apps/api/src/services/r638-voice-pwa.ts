/**
 * R638 — Voice PWA page.
 *
 * Standalone single-page voice client that pairs with R622 /ws/voice +
 * R637 /ws/presence. Mic capture via MediaRecorder (Opus/WebM), hold-to-talk
 * on mobile + click-toggle on desktop, plays back returned mp3 frames via
 * Web Audio API, shows live presence roster.
 *
 * Render at GET /voice?token=…&workspace=…&voice=nova
 *
 * Inline HTML+CSS+JS (no build chain, no framework) — runs on any modern
 * browser including iOS Safari + Android Chrome PWA shells.
 */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
}

export function renderVoicePwaHtml(_opts: { workspace?: string; voice?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0b0d12">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Novan · Voice</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b0d12;color:#e5e7eb;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overscroll-behavior:none}
  header{padding:12px 16px env(safe-area-inset-top,12px);border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between;background:#0b0d12;position:sticky;top:0;z-index:10}
  header .brand{font-weight:600;font-size:15px;letter-spacing:.02em}
  header .brand .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px;vertical-align:middle;transition:background .3s}
  header .brand .dot.off{background:#6b7280}
  .peers{display:flex;gap:4px;flex-wrap:wrap;max-width:60%;justify-content:flex-end}
  .peer{width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;border:2px solid #0b0d12;box-shadow:0 0 0 1px #ffffff15}
  main{flex:1;overflow-y:auto;padding:16px;max-width:760px;margin:0 auto;width:100%;-webkit-overflow-scrolling:touch}
  .msg{margin:10px 0;padding:11px 14px;border-radius:16px;max-width:82%;line-height:1.45;word-wrap:break-word;font-size:15px}
  .msg.user{background:#1f2937;margin-left:auto;border-bottom-right-radius:5px;color:#f9fafb}
  .msg.assistant{background:linear-gradient(135deg,#0f1729,#1e1b4b);border:1px solid #312e8133;margin-right:auto;border-bottom-left-radius:5px;color:#e0e7ff}
  .msg.assistant .cursor{display:inline-block;width:2px;height:1em;background:#a5b4fc;animation:blink 1s infinite;vertical-align:middle;margin-left:2px}
  @keyframes blink{50%{opacity:0}}
  .empty{color:#6b7280;text-align:center;margin-top:60px;font-size:14px;line-height:1.7}
  .empty .hint{display:block;margin-top:8px;font-size:12px;color:#4b5563}
  footer{padding:16px 16px calc(env(safe-area-inset-bottom,0) + 16px);display:flex;align-items:center;gap:16px;justify-content:center;border-top:1px solid #1f2937;background:#0b0d12;position:sticky;bottom:0}
  .mic{width:72px;height:72px;border-radius:50%;border:none;background:#3b82f6;color:#fff;font-size:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .12s,background .25s,box-shadow .25s;position:relative;touch-action:manipulation;-webkit-user-select:none;user-select:none}
  .mic:active{transform:scale(.94)}
  .mic.recording{background:#ef4444;animation:pulse 1.4s infinite ease-out}
  .mic:disabled{background:#374151;cursor:not-allowed;animation:none}
  .mic svg{width:30px;height:30px;fill:#fff}
  @keyframes pulse{0%{box-shadow:0 0 0 0 #ef444499}70%{box-shadow:0 0 0 22px #ef444400}100%{box-shadow:0 0 0 0 #ef444400}}
  .status{color:#9ca3af;font-size:13px;min-width:80px;font-variant-numeric:tabular-nums}
  .err{color:#f87171}
  .cancel{width:42px;height:42px;border-radius:50%;border:1px solid #374151;background:transparent;color:#9ca3af;font-size:18px;cursor:pointer;display:none;align-items:center;justify-content:center;transition:background .15s}
  .cancel:active{background:#1f2937}
  .cancel.show{display:flex}
  @media (prefers-color-scheme: light){
    body{background:#fff;color:#0f172a}
    header,footer{background:#fff;border-color:#e5e7eb}
    .msg.user{background:#f3f4f6;color:#0f172a}
    .msg.assistant{background:linear-gradient(135deg,#eef2ff,#f5f3ff);color:#1e1b4b;border-color:#c7d2fe}
    .peer{border-color:#fff}
    .status{color:#6b7280}
    .empty{color:#9ca3af}
    .empty .hint{color:#9ca3af}
  }
</style>
</head>
<body>
<header>
  <span class="brand"><span class="dot off" id="dot"></span>Novan Voice</span>
  <span class="peers" id="peers" title="other operators in this workspace"></span>
</header>
<main id="msgs">
  <div class="empty" id="empty">
    Hold the mic and speak.
    <span class="hint">First tap will request microphone permission.</span>
  </div>
</main>
<footer>
  <button class="cancel" id="cancel" aria-label="cancel">✕</button>
  <button class="mic" id="mic" disabled aria-label="hold to talk">
    <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
  </button>
  <span class="status" id="status">connecting…</span>
</footer>
<script>
(async () => {
  const params    = new URLSearchParams(location.search);
  const token     = params.get('token');
  const workspace = params.get('workspace') || 'default';
  const voiceId   = params.get('voice') || 'nova';
  const peerName  = params.get('name') || ('op-' + Math.random().toString(36).slice(2, 6));

  const $ = (id) => document.getElementById(id);
  const msgs = $('msgs'), mic = $('mic'), status = $('status'), peersEl = $('peers');
  const cancelBtn = $('cancel'), dot = $('dot'), empty = $('empty');

  if (!token) { status.innerHTML = '<span class="err">no ?token= in URL</span>'; return; }

  function addMsg(role, text) {
    if (empty.parentNode) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  function streamToAssistant(text, done) {
    let last = msgs.lastElementChild;
    if (!last || !last.classList || !last.classList.contains('assistant') || last.dataset.done === '1') {
      if (empty.parentNode) empty.remove();
      last = document.createElement('div');
      last.className = 'msg assistant';
      msgs.appendChild(last);
    }
    last.textContent = (last.textContent || '').replace(/▍$/, '') + text;
    if (done) last.dataset.done = '1';
    else last.innerHTML = last.textContent + '<span class="cursor"></span>';
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ── Audio playback (Web Audio decoded sequentially) ──
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioQueue = [];
  let playing = false;
  async function playNext() {
    if (playing || audioQueue.length === 0) return;
    playing = true;
    const buf = audioQueue.shift();
    try {
      const ab = await buf.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(ab);
      const src = audioCtx.createBufferSource();
      src.buffer = decoded;
      src.connect(audioCtx.destination);
      src.onended = () => { playing = false; playNext(); };
      src.start();
    } catch { playing = false; setTimeout(playNext, 50); }
  }
  function queueAudio(blob) { audioQueue.push(blob); playNext(); }
  function flushAudio()     { audioQueue.length = 0; }

  // ── Voice WS ──
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
    '/ws/voice?token=' + encodeURIComponent(token) +
    '&workspace=' + encodeURIComponent(workspace);
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    status.textContent = 'ready';
    dot.classList.remove('off');
    ws.send(JSON.stringify({ type: 'config', mime: 'audio/webm', voice: voiceId }));
    mic.disabled = false;
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      queueAudio(new Blob([ev.data], { type: 'audio/mpeg' }));
      return;
    }
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'hello':            break;
      case 'config_ack':       break;
      case 'final_transcript': if (m.text) addMsg('user', m.text); break;
      case 'assistant_delta':  streamToAssistant(m.text, false); break;
      case 'done':             streamToAssistant('', true); status.textContent = 'ready'; cancelBtn.classList.remove('show'); break;
      case 'cancelled':        status.textContent = 'cancelled'; cancelBtn.classList.remove('show'); break;
      case 'error':            status.innerHTML = '<span class="err">' + (m.message || 'error') + '</span>'; break;
    }
  };
  ws.onclose = () => { status.textContent = 'disconnected'; dot.classList.add('off'); mic.disabled = true; };
  ws.onerror = () => { status.innerHTML = '<span class="err">ws error</span>'; };

  // ── Mic capture (hold-to-talk on mobile, click-toggle on desktop) ──
  let recorder = null, recording = false, stream = null;
  async function ensureStream() {
    if (stream) return true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      return true;
    } catch (e) { status.innerHTML = '<span class="err">mic denied: ' + (e.message || 'permission') + '</span>'; return false; }
  }
  async function startRecording() {
    if (recording || ws.readyState !== 1) return;
    if (!(await ensureStream())) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    flushAudio();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === 1) e.data.arrayBuffer().then(ab => ws.send(ab)).catch(() => {});
    };
    recorder.onstop = () => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'end_turn' }));
      mic.classList.remove('recording');
      status.textContent = 'thinking…';
      cancelBtn.classList.add('show');
      recording = false;
    };
    recorder.start(250);
    recording = true;
    mic.classList.add('recording');
    status.textContent = 'listening…';
  }
  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }
  function cancelTurn() {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cancel' }));
    flushAudio();
    stopRecording();
    cancelBtn.classList.remove('show');
  }
  cancelBtn.addEventListener('click', cancelTurn);

  let touchUsed = false;
  mic.addEventListener('touchstart', (e) => { e.preventDefault(); touchUsed = true; startRecording(); }, { passive: false });
  mic.addEventListener('touchend',   (e) => { e.preventDefault(); stopRecording(); },   { passive: false });
  mic.addEventListener('touchcancel',(e) => { e.preventDefault(); stopRecording(); },   { passive: false });
  mic.addEventListener('mousedown',  () => { if (!touchUsed) startRecording(); });
  document.addEventListener('mouseup', () => { if (!touchUsed && recording) stopRecording(); });

  // Spacebar push-to-talk on desktop
  let spaceDown = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !spaceDown && document.activeElement !== mic) {
      e.preventDefault(); spaceDown = true; startRecording();
    }
    if (e.code === 'Escape') cancelTurn();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; stopRecording(); } });

  // ── Presence WS ──
  const presUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
    '/ws/presence?token=' + encodeURIComponent(token) +
    '&workspace=' + encodeURIComponent(workspace);
  let presWs;
  function connectPresence() {
    presWs = new WebSocket(presUrl);
    presWs.onopen = () => presWs.send(JSON.stringify({ type: 'hello', name: peerName, route: '/voice' }));
    presWs.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'roster') renderPeers(m.peers || []);
    };
    presWs.onclose = () => setTimeout(connectPresence, 3000);
    presWs.onerror = () => {};
  }
  function renderPeers(peers) {
    peersEl.innerHTML = '';
    for (const p of peers) {
      const el = document.createElement('span');
      el.className = 'peer';
      el.style.background = p.color || '#6b7280';
      el.textContent = (p.name || '?').slice(0, 2).toUpperCase();
      el.title = (p.name || 'peer') + (p.route ? ' · ' + p.route : '');
      peersEl.appendChild(el);
    }
  }
  connectPresence();
  setInterval(() => {
    if (presWs && presWs.readyState === 1) presWs.send(JSON.stringify({ type: 'heartbeat', route: '/voice' }));
  }, 5000);

  // PWA install: link to existing /manifest.webmanifest if served
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
</script>
</body>
</html>`
}

/** R643e — Alternative voice page that drives /ws/voice/realtime (OpenAI Realtime API).
 *  Activated by ?mode=realtime on the /voice URL. Same Look/feel as the R638 turn-based
 *  page, but plumbing uses OpenAI's Realtime protocol (input_audio_buffer.append,
 *  response.audio.delta, etc.) for true full-duplex with server-side barge-in. */
export function renderVoiceRealtimePwaHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#0b0d12">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>Novan · Realtime Voice</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b0d12;color:#e5e7eb;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent;overscroll-behavior:none}
  header{padding:12px 16px env(safe-area-inset-top,12px);border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between;background:#0b0d12;position:sticky;top:0;z-index:10}
  header .brand{font-weight:600;font-size:15px}
  header .brand .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#a855f7;margin-right:6px;vertical-align:middle;transition:background .3s}
  header .brand .dot.off{background:#6b7280}
  header .mode{font-size:11px;color:#a855f7;background:#581c8722;padding:2px 8px;border-radius:10px;letter-spacing:.04em;text-transform:uppercase}
  main{flex:1;overflow-y:auto;padding:16px;max-width:760px;margin:0 auto;width:100%}
  .msg{margin:10px 0;padding:11px 14px;border-radius:16px;max-width:82%;line-height:1.45;word-wrap:break-word;font-size:15px}
  .msg.user{background:#1f2937;margin-left:auto;border-bottom-right-radius:5px;color:#f9fafb}
  .msg.assistant{background:linear-gradient(135deg,#1e1b4b,#581c87);border:1px solid #a855f733;margin-right:auto;border-bottom-left-radius:5px;color:#ede9fe}
  .empty{color:#6b7280;text-align:center;margin-top:60px;font-size:14px;line-height:1.7}
  footer{padding:16px 16px calc(env(safe-area-inset-bottom,0) + 16px);display:flex;align-items:center;gap:16px;justify-content:center;border-top:1px solid #1f2937;background:#0b0d12;position:sticky;bottom:0}
  .mic{width:72px;height:72px;border-radius:50%;border:none;background:#a855f7;color:#fff;font-size:0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .12s,background .25s,box-shadow .25s;touch-action:manipulation;-webkit-user-select:none;user-select:none}
  .mic:active{transform:scale(.94)}
  .mic.streaming{background:#ef4444;animation:pulse 1.4s infinite ease-out}
  .mic:disabled{background:#374151;cursor:not-allowed;animation:none}
  .mic svg{width:30px;height:30px;fill:#fff}
  @keyframes pulse{0%{box-shadow:0 0 0 0 #ef444499}70%{box-shadow:0 0 0 22px #ef444400}100%{box-shadow:0 0 0 0 #ef444400}}
  .status{color:#9ca3af;font-size:13px;min-width:96px;font-variant-numeric:tabular-nums}
  .err{color:#f87171}
  .link{color:#a855f7;text-decoration:none;font-size:11px;margin-left:auto}
</style>
</head>
<body>
<header>
  <span class="brand"><span class="dot off" id="dot"></span>Novan Voice</span>
  <span class="mode">REALTIME</span>
</header>
<main id="msgs">
  <div class="empty" id="empty">
    Tap the mic once to start a continuous session.<br><br>
    Speak naturally — Novan listens, thinks, and interrupts itself when you speak again.
    <a class="link" href="/voice${'?'}token=__APPEND_TOKEN__">switch to turn-based →</a>
  </div>
</main>
<footer>
  <button class="mic" id="mic" disabled aria-label="start session">
    <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
  </button>
  <span class="status" id="status">connecting…</span>
</footer>
<script>
(async () => {
  const params    = new URLSearchParams(location.search);
  const token     = params.get('token');
  const voiceId   = params.get('voice') || 'alloy';
  const model     = params.get('model') || 'gpt-realtime';

  const $ = (id) => document.getElementById(id);
  const msgs = $('msgs'), mic = $('mic'), status = $('status'), dot = $('dot'), empty = $('empty');

  if (!token) { status.innerHTML = '<span class="err">no ?token= in URL</span>'; return; }

  // Splice token into the "switch to turn-based" link
  empty.innerHTML = empty.innerHTML.replace('__APPEND_TOKEN__', encodeURIComponent(token));

  let currentAssistantEl = null;
  let currentUserEl = null;

  function newMsg(role, initial) {
    if (empty.parentNode) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = initial || '';
    msgs.appendChild(el); msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  function appendTo(el, text) {
    el.textContent = (el.textContent || '') + text;
    msgs.scrollTop = msgs.scrollHeight;
  }

  // Audio playback via AudioWorklet-less ScriptProcessor for compat. Realtime
  // API emits PCM16 mono @ 24 kHz; we resample on the fly to AudioContext rate.
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  let playHead = 0;
  function schedulePcm16(b64) {
    try {
      const raw = atob(b64);
      const i16 = new Int16Array(raw.length / 2);
      for (let i = 0; i < i16.length; i++) {
        i16[i] = (raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
      }
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      const buf = audioCtx.createBuffer(1, f32.length, 24000);
      buf.copyToChannel(f32, 0);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      const startAt = playHead > now ? playHead : now;
      src.start(startAt);
      playHead = startAt + buf.duration;
    } catch {}
  }
  function flushAudio() { playHead = audioCtx.currentTime; }

  // Mic capture as PCM16 24 kHz mono via ScriptProcessor
  let captureCtx = null, captureSrc = null, captureProc = null, captureStream = null;
  async function startCapture() {
    if (captureCtx) return true;
    try {
      captureStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { status.innerHTML = '<span class="err">mic denied</span>'; return false; }
    captureCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    captureSrc = captureCtx.createMediaStreamSource(captureStream);
    captureProc = captureCtx.createScriptProcessor(2048, 1, 1);
    captureSrc.connect(captureProc);
    captureProc.connect(captureCtx.destination);
    captureProc.onaudioprocess = (e) => {
      if (ws.readyState !== 1) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      // base64 encode
      let bin = '';
      const bytes = new Uint8Array(i16.buffer);
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
    };
    return true;
  }
  function stopCapture() {
    if (captureProc) { try { captureProc.disconnect() } catch {} captureProc = null; }
    if (captureSrc)  { try { captureSrc.disconnect() } catch {} captureSrc = null; }
    if (captureStream) { for (const t of captureStream.getTracks()) t.stop(); captureStream = null; }
    if (captureCtx) { try { captureCtx.close() } catch {} captureCtx = null; }
  }

  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
    '/ws/voice/realtime?token=' + encodeURIComponent(token) +
    '&model=' + encodeURIComponent(model) + '&voice=' + encodeURIComponent(voiceId);
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => { status.textContent = 'connected'; dot.classList.remove('off'); mic.disabled = false; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'novan.upstream_ready':
        status.textContent = 'ready';
        // Tell OpenAI we want a transcribed input + voice output session
        ws.send(JSON.stringify({ type: 'session.update', session: { modalities: ['audio', 'text'], voice: voiceId, instructions: 'You are Novan, the operator\\'s autonomous AI partner. Be concise — this is voice. 1-3 sentences per turn unless asked for more.', input_audio_transcription: { model: 'whisper-1' }, turn_detection: { type: 'server_vad' } } }));
        break;
      case 'response.audio.delta':
        if (m.delta) schedulePcm16(m.delta);
        break;
      case 'response.audio_transcript.delta':
        if (m.delta) {
          if (!currentAssistantEl) currentAssistantEl = newMsg('assistant', '');
          appendTo(currentAssistantEl, m.delta);
        }
        break;
      case 'response.audio_transcript.done':
        currentAssistantEl = null;
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (m.transcript) {
          if (!currentUserEl) currentUserEl = newMsg('user', '');
          currentUserEl.textContent = m.transcript;
          currentUserEl = null;
        }
        break;
      case 'input_audio_buffer.speech_started':
        // user is talking → barge in
        flushAudio();
        currentUserEl = newMsg('user', '…');
        break;
      case 'error':
        status.innerHTML = '<span class="err">' + (m.error?.message || m.message || 'error') + '</span>';
        break;
    }
  };
  ws.onclose = () => { status.textContent = 'disconnected'; dot.classList.add('off'); mic.disabled = true; stopCapture(); };
  ws.onerror = () => { status.innerHTML = '<span class="err">ws error</span>'; };

  let active = false;
  mic.addEventListener('click', async () => {
    if (!active) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (!(await startCapture())) return;
      active = true;
      mic.classList.add('streaming');
      status.textContent = 'listening · speak naturally';
    } else {
      active = false;
      stopCapture();
      mic.classList.remove('streaming');
      status.textContent = 'paused';
      flushAudio();
    }
  });
})();
</script>
</body></html>`
}

export function renderVoiceManifest(): string {
  return JSON.stringify({
    name:             'Novan Voice',
    short_name:       'Novan Voice',
    description:      'Hold-to-talk realtime voice with Novan',
    start_url:        '/voice',
    display:          'standalone',
    background_color: '#0b0d12',
    theme_color:      '#0b0d12',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    orientation: 'portrait',
  }, null, 2)
}

void esc        // reserved for future inline-substitution
