/**
 * R688 — OpenAI Realtime voice UI + ephemeral session endpoint.
 *
 * OpenAI's recommended pattern: server mints a short-lived session token,
 * browser uses it to connect directly via WebRTC. Lower latency than the
 * R642c pass-through proxy and keeps the long-lived OPENAI_API_KEY server-only.
 *
 * Endpoint: POST /voice/realtime/session  → ephemeral key + ICE config
 * Page:     GET  /voice/realtime          → operator UI
 */

const REALTIME_MODEL = 'gpt-4o-realtime-preview'

export async function mintRealtimeSession(input: { voice?: string; instructions?: string }): Promise<{ ok: boolean; client_secret?: string; expires_at?: number; model?: string; error?: string }> {
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' }
  try {
    // OpenAI Realtime: new endpoint shape (as of 2025-Q4). Returns a
    // top-level { value, expires_at } client_secret, with the session
    // config embedded in the request body's `session` field.
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          audio: { output: { voice: input.voice ?? 'alloy' } },
          instructions: input.instructions ?? 'You are Novan, a concise voice assistant.',
        },
      }),
    })
    if (!res.ok) return { ok: false, error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
    const j = await res.json() as { value?: string; expires_at?: number; session?: { model?: string } }
    if (!j.value) return { ok: false, error: 'no client_secret value in response' }
    const result: { ok: boolean; client_secret?: string; expires_at?: number; model?: string } = { ok: true, client_secret: j.value, model: j.session?.model ?? REALTIME_MODEL }
    if (j.expires_at) result.expires_at = j.expires_at
    return result
}

// R695 — drop-in script the PWA chat injects to route its voice button
// through R688 Realtime instead of R131 Web Speech. Returned as a tiny
// JS module so the PWA can <script src> it without rebuilding.
export function renderPwaVoiceShim(): string {
  return `// R695 PWA voice shim — replaces Web Speech with Realtime
window.NovanVoiceShim = {
  async start(opts) {
    const token = opts?.token || new URLSearchParams(location.search).get('token') || '';
    const sess = await fetch('/voice/realtime/session?token=' + encodeURIComponent(token), { method: 'POST' }).then(r => r.json());
    if (!sess.ok) throw new Error(sess.error || 'session mint failed');
    const pc = new RTCPeerConnection();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = (ev) => {
      const audio = new Audio(); audio.srcObject = ev.streams[0]; audio.autoplay = true;
      document.body.appendChild(audio);
    };
    const dc = pc.createDataChannel('oai-events');
    dc.addEventListener('message', (ev) => {
      try {
        const e = JSON.parse(ev.data);
        if (e.type === 'response.audio_transcript.delta') opts?.onAssistantText?.(e.delta);
        if (e.type === 'conversation.item.input_audio_transcription.completed') opts?.onUserText?.(e.transcript);
      } catch {}
    });
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    const sdpResp = await fetch('https://api.openai.com/v1/realtime?model=' + encodeURIComponent(sess.model), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sess.client_secret, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpResp.text() });
    return { stop: () => { dc.close(); pc.close(); stream.getTracks().forEach(t => t.stop()); } };
  }
};
`
}
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export function renderRealtimeHtml(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan · live voice</title>
<style>
  body{margin:0;background:#0f1118;color:#e6e8ee;font:14px/1.5 system-ui,sans-serif;min-height:100vh}
  .wrap{max-width:520px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:14px}
  h1{margin:0;font-size:18px}
  .meta{font:12px monospace;color:#8a8fa3}
  button{padding:14px 20px;border:none;border-radius:10px;background:#4a7;color:#fff;font-size:16px;font-weight:600;cursor:pointer;width:100%}
  button:disabled{opacity:.5;cursor:not-allowed}
  button.stop{background:#c93838}
  #log{display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;background:#171a23;border:1px solid #262a36;border-radius:8px;padding:10px}
  .line{padding:6px 8px;border-radius:6px;background:#1d212c}
  .line.me{background:#2a3344}
  .role{font:11px monospace;color:#8a8fa3;margin-right:6px}
  .status{font:12px monospace;color:#8a8fa3;text-align:center;padding:6px 0}
</style></head>
<body>
<div class="wrap">
  <h1>Novan live voice</h1>
  <span class="meta">R688 · OpenAI Realtime (gpt-4o-realtime)</span>
  <button id="btn">Start conversation</button>
  <div class="status" id="status">ready</div>
  <div id="log"></div>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const btn = document.getElementById('btn');
const log = document.getElementById('log');
const statusEl = document.getElementById('status');
let pc = null;
let dc = null;
let mediaStream = null;
let active = false;

function addLine(role, text) {
  const div = document.createElement('div');
  div.className = 'line' + (role === 'You' ? ' me' : '');
  div.innerHTML = '<span class="role">' + role + '</span>' + text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function start() {
  btn.disabled = true; statusEl.textContent = 'minting session...';
  try {
    const r = await fetch('/voice/realtime/session?token=' + encodeURIComponent(token), { method: 'POST' });
    const sess = await r.json();
    if (!sess.ok) throw new Error(sess.error || 'session mint failed');

    statusEl.textContent = 'connecting...';
    pc = new RTCPeerConnection();
    pc.addEventListener('connectionstatechange', () => {
      statusEl.textContent = pc.connectionState;
    });

    // Inbound audio from model → speaker
    pc.ontrack = (ev) => {
      const audio = document.createElement('audio');
      audio.srcObject = ev.streams[0];
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
    };

    // Mic
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStream.getTracks().forEach(t => pc.addTrack(t, mediaStream));

    // Data channel for events
    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('open', () => statusEl.textContent = 'live');
    dc.addEventListener('message', (ev) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'response.audio_transcript.delta') {
          // Stream assistant text as it speaks
          let last = log.lastElementChild;
          if (!last || !last.classList.contains('asst-stream')) {
            last = addLine('Novan', '');
            last.classList.add('asst-stream');
          }
          last.innerHTML += evt.delta.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
        } else if (evt.type === 'response.done') {
          const last = log.querySelector('.asst-stream:last-of-type');
          if (last) last.classList.remove('asst-stream');
        } else if (evt.type === 'conversation.item.input_audio_transcription.completed') {
          addLine('You', evt.transcript || '(speech)');
        }
      } catch { /* not JSON */ }
    });

    // Offer/answer with OpenAI directly
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpResponse = await fetch('https://api.openai.com/v1/realtime?model=' + encodeURIComponent(sess.model), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sess.client_secret, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    const answer = { type: 'answer', sdp: await sdpResponse.text() };
    await pc.setRemoteDescription(answer);

    active = true;
    btn.textContent = 'Stop'; btn.classList.add('stop'); btn.disabled = false;
  } catch (e) {
    statusEl.textContent = 'error: ' + (e.message || e);
    btn.disabled = false;
  }
}

function stop() {
  active = false;
  if (dc) try { dc.close() } catch {}
  if (pc) try { pc.close() } catch {}
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  pc = null; dc = null; mediaStream = null;
  btn.textContent = 'Start conversation'; btn.classList.remove('stop');
  statusEl.textContent = 'ended';
}

btn.addEventListener('click', () => active ? stop() : start());
</script>
</body></html>`
}
