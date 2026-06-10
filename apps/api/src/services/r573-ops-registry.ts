/**
 * R573 — Public brain-op registry (introspection).
 *
 * Anthropic's MCP servers list themselves with discoverable tools. Novan
 * brain ops are equivalent in spirit but were buried inside brain-task.ts
 * for runtime use only. R573 exposes them in three ways:
 *
 *   1. /ops/registry.json — machine-readable catalog (count, by-category,
 *      every op with name/description/risk). For external docs site, MCP
 *      bridge, or third-party plugins that want to know what's available.
 *   2. /ops/registry.html — human-browsable single-page index with search.
 *   3. brain op `registry.list` — programmatic access from inside the brain.
 *
 * Category is derived from the op name prefix (e.g. `tax.thresholds` →
 * 'tax', `finance.reserve_recommendations` → 'finance').
 */
export interface OpSummary {
  name:        string
  description: string
  risk:        string
  category:    string
}

export async function buildOpsCatalog(): Promise<{ count: number; byCategory: Record<string, number>; ops: OpSummary[] }> {
  const { OPERATIONS } = await import('./brain-task.js')
  const all = Object.entries(OPERATIONS as Record<string, { description?: string; risk?: string }>)
  const ops: OpSummary[] = all.map(([name, spec]) => {
    const category = name.includes('.') ? name.slice(0, name.indexOf('.')) : '_root'
    return {
      name,
      description: (spec.description ?? '').slice(0, 500),
      risk:        spec.risk ?? 'low',
      category,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const byCategory: Record<string, number> = {}
  for (const op of ops) byCategory[op.category] = (byCategory[op.category] ?? 0) + 1
  return { count: ops.length, byCategory, ops }
}

export function renderRegistryHtml(catalog: { count: number; byCategory: Record<string, number>; ops: OpSummary[] }): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const cats = Object.entries(catalog.byCategory).sort((a, b) => b[1] - a[1])
  const riskClass = (r: string): string => r === 'high' ? '#ef4444' : r === 'medium' ? '#facc15' : '#22c55e'
  return `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan brain-ops registry — ${catalog.count} ops</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0b; color: #e5e7eb; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; color: #fafafa; margin-bottom: 0.3rem; }
  .sub { color: #a1a1aa; font-size: 13px; margin-bottom: 1.5rem; }
  input { background: #18181b; border: 1px solid #27272a; color: #fafafa; padding: 8px 12px; border-radius: 6px; width: 100%; box-sizing: border-box; font-size: 14px; }
  .cats { display: flex; flex-wrap: wrap; gap: 6px; margin: 1rem 0; }
  .cat { background: #18181b; border: 1px solid #27272a; padding: 4px 10px; border-radius: 14px; font-size: 11px; color: #d4d4d8; cursor: pointer; user-select: none; }
  .cat:hover { background: #27272a; }
  .cat.active { background: #1e3a8a; border-color: #3b82f6; color: #dbeafe; }
  .op { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
  .op-name { font-family: ui-monospace, 'SF Mono', monospace; font-size: 13px; color: #fafafa; font-weight: 600; }
  .op-risk { display: inline-block; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; margin-right: 8px; }
  .op-desc { color: #a1a1aa; font-size: 13px; margin-top: 6px; line-height: 1.5; }
  .hidden { display: none; }
</style></head><body>
<h1>🧠 Novan brain-ops registry</h1>
<div class="sub">${catalog.count} ops across ${Object.keys(catalog.byCategory).length} categories. JSON: <a href="/ops/registry.json?token=" style="color:#60a5fa">/ops/registry.json</a></div>
<input id="q" placeholder="Filter by name or description…" autofocus>
<div class="cats" id="cats">
  <span class="cat active" data-c="">All (${catalog.count})</span>
  ${cats.map(([c, n]) => `<span class="cat" data-c="${esc(c)}">${esc(c)} (${n})</span>`).join('')}
</div>
<div id="ops">
${catalog.ops.map(op => `<div class="op" data-name="${esc(op.name)}" data-cat="${esc(op.category)}" data-desc="${esc(op.description.toLowerCase())}">
  <div><span class="op-risk" style="background:${riskClass(op.risk)}" title="${esc(op.risk)} risk"></span><span class="op-name">${esc(op.name)}</span></div>
  <div class="op-desc">${esc(op.description) || '<em style="color:#52525b">no description</em>'}</div>
</div>`).join('')}
</div>
<script>
  const q = document.getElementById('q')
  const ops = [...document.querySelectorAll('#ops .op')]
  const cats = [...document.querySelectorAll('#cats .cat')]
  let activeCat = ''
  function filter() {
    const t = q.value.toLowerCase().trim()
    for (const o of ops) {
      const okCat  = !activeCat || o.dataset.cat === activeCat
      const okText = !t || o.dataset.name.toLowerCase().includes(t) || (o.dataset.desc || '').includes(t)
      o.classList.toggle('hidden', !(okCat && okText))
    }
  }
  q.addEventListener('input', filter)
  for (const c of cats) c.addEventListener('click', () => {
    cats.forEach(x => x.classList.remove('active'))
    c.classList.add('active')
    activeCat = c.dataset.c || ''
    filter()
  })
</script>
</body></html>`
}
