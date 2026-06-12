/**
 * R702 — Knowledge base browser UI at /ops/knowledge.
 *
 * Lists R687 ingested docs with chunk count + a search box that calls
 * knowledge.query and shows the top hits inline. Lets the operator
 * see what's in the KB without dropping to brain ops.
 */
import { listKbDocs } from './r687-knowledge.js'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export async function renderKnowledgeHtml(workspaceId: string): Promise<string> {
  const docs = await listKbDocs(workspaceId, 100)
  const totalChunks = docs.reduce((s, d) => s + Number(d['chunks'] ?? 0), 0)
  const totalTokens = docs.reduce((s, d) => s + Number(d['tokens'] ?? 0), 0)
  const rows = docs.map(d => `
    <tr>
      <td><code>${String(d['id']).slice(0, 16)}</code></td>
      <td>${escapeHtml(String(d['title'] ?? '').slice(0, 80) || '(untitled)')}</td>
      <td>${d['source_url'] ? `<a href="${String(d['source_url'])}" target="_blank">${escapeHtml(String(d['source_url']).slice(0, 60))}</a>` : ''}</td>
      <td>${d['chunks']}</td>
      <td>${d['tokens']}</td>
      <td>${String(d['created_at']).slice(0, 16)}</td>
    </tr>`).join('')
  const wsParam = workspaceId === 'default' ? '' : `&workspace=${workspaceId}`
  return `<!doctype html><html><head><title>R702 knowledge base</title>
  <style>body{font:14px system-ui;max-width:1100px;margin:2rem auto;padding:1rem}
  table{width:100%;border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
  th{background:#f7f7f7}.s{font:13px monospace;color:#555}
  form{margin:1rem 0;display:flex;gap:8px}
  input{flex:1;padding:8px;border:1px solid #ddd;border-radius:4px;font:14px inherit}
  button{padding:8px 16px;border:none;border-radius:4px;background:#4a7;color:#fff;font-weight:600;cursor:pointer}
  #results{margin:1rem 0}
  .hit{background:#fff;border:1px solid #e0e0e6;border-radius:6px;padding:8px 10px;margin:6px 0}
  .hit .meta{font:11px monospace;color:#888;margin-bottom:4px}</style>
  </head><body>
  <h1>R702 knowledge base</h1>
  <p class="s">${docs.length} docs · ${totalChunks} chunks · ${totalTokens} tokens embedded</p>
  <form id="f"><input id="q" placeholder="Semantic search the knowledge base…" required><button>Query</button></form>
  <div id="results"></div>
  <h2>Documents</h2>
  <table><thead><tr><th>id</th><th>title</th><th>source</th><th>chunks</th><th>tokens</th><th>added</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <script>
  const token = new URLSearchParams(location.search).get('token') || '';
  const f = document.getElementById('f');
  const q = document.getElementById('q');
  const res = document.getElementById('results');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    res.innerHTML = 'searching…';
    const r = await fetch('/admin/brain', {
      method: 'POST',
      headers: { 'X-Admin-Token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'knowledge.query', workspaceId: '${workspaceId}', params: { queryText: q.value, limit: 5 } }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
    const hits = r?.result?.hits || [];
    res.innerHTML = '<h3>' + hits.length + ' hits</h3>' + hits.map(h => '<div class="hit"><div class="meta">sim ' + h.similarity.toFixed(3) + ' · ' + (h.title || h.docId) + '</div>' + h.text.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</div>').join('');
  });
  </script>
  ${wsParam ? '' : ''}
  </body></html>`
}
