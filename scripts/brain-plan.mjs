#!/usr/bin/env node
/**
 * brain-plan.mjs — Gemini-coordinated patch planner.
 *
 * Pulls platform state from Neon (audit findings, failure memory, open
 * incidents, recent external knowledge), composes a structured prompt,
 * sends it to the AI router (Gemini), and persists the response in
 * `events` for audit trail.
 *
 * Degrades cleanly when:
 *   - GEMINI_API_KEY missing  → prints state-only summary
 *   - Gemini returns 429       → friendly "credits depleted" message
 *   - API unreachable          → state summary, no plan
 *
 * Usage:  pnpm brain:plan   (or: node scripts/brain-plan.mjs)
 */
import postgres from '../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js'
import crypto   from 'node:crypto'
import fs       from 'node:fs'
import path     from 'node:path'

// ─── Config ──────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://neondb_owner:npg_n2wGjmuWzrU9@ep-bitter-snow-ak0w2voz-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require'

const API_URL   = process.env.API_URL   || 'http://localhost:3001'
const WORKSPACE = process.env.WORKSPACE || 'default'

// Load .env for GEMINI_API_KEY if present
const envPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

const sql = postgres(DATABASE_URL, { ssl: 'require' })

// ─── Gather state ────────────────────────────────────────────────────────────
console.log('🧠  Brain plan — gathering platform state…\n')

const [audit, failures, fixes, incidents, knowledge, feeds] = await Promise.all([
  sql`SELECT category, severity, description, file_path FROM audit_findings
      WHERE workspace_id = ${WORKSPACE}
      ORDER BY severity DESC, created_at DESC LIMIT 30`,
  sql`SELECT failure_type, signature, occurrence_count, last_seen_at FROM failure_memory
      WHERE workspace_id = ${WORKSPACE}
      ORDER BY last_seen_at DESC LIMIT 15`,
  sql`SELECT failure_signature, fix_description, success_count FROM successful_fixes
      WHERE workspace_id = ${WORKSPACE}
      ORDER BY last_applied_at DESC LIMIT 10`,
  sql`SELECT severity, title, status FROM incidents
      WHERE workspace_id = ${WORKSPACE} AND status != 'resolved'
      ORDER BY detected_at DESC LIMIT 10`,
  sql`SELECT url, title, fetched_at FROM external_knowledge
      WHERE workspace_id = ${WORKSPACE}
      ORDER BY fetched_at DESC LIMIT 15`,
  sql`SELECT name, feed_url, enabled, items_ingested, last_polled_at FROM external_feeds
      WHERE workspace_id = ${WORKSPACE}`,
])

console.log(`  • ${audit.length} unresolved audit findings`)
console.log(`  • ${failures.length} failure-memory entries`)
console.log(`  • ${fixes.length} successful fixes`)
console.log(`  • ${incidents.length} open incidents`)
console.log(`  • ${knowledge.length} recently fetched articles`)
console.log(`  • ${feeds.length} configured feeds\n`)

const state = {
  audit_findings: audit,
  failure_memory: failures,
  successful_fixes: fixes,
  open_incidents: incidents,
  recent_knowledge: knowledge.map(k => ({ url: k.url, title: k.title })),
  feeds: feeds.map(f => ({ name: f.name, enabled: f.enabled, ingested: f.items_ingested })),
}

// ─── Compose prompt ──────────────────────────────────────────────────────────
const prompt = `You are the lead engineer for Novan — an autonomous operational intelligence platform.

Current platform state (JSON):
${JSON.stringify(state, null, 2)}

Based on this state, propose the next 3 concrete patches to ship. For each:
1. WHAT — one-sentence description
2. WHY — which audit finding / failure / incident it addresses
3. RISK — low / medium / high
4. FILES — list of files likely touched
5. VALIDATION — how to verify the patch worked

Return strict JSON: { "patches": [{ "what": "...", "why": "...", "risk": "...", "files": [...], "validation": "..." }, ...] }`

// ─── Call AI router ──────────────────────────────────────────────────────────
let plan = null
let planError = null

try {
  const res = await fetch(`${API_URL}/api/v1/ai-router/chat`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({
      workspace_id: WORKSPACE,
      task_type: 'reasoning',
      messages: [{ role: 'user', content: prompt }],
      model: 'gemini-2.5-pro',
    }),
    signal: AbortSignal.timeout(60_000),
  })

  const body = await res.json().catch(() => ({}))

  const bodyStr = JSON.stringify(body)
  if (res.status === 429 || /\b429\b|credit|quota|rate.limit/i.test(bodyStr)) {
    planError = 'Gemini account has no credits/quota. Add billing at https://ai.studio/projects to enable planning.'
  } else if (!res.ok) {
    planError = `AI router returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`
  } else {
    const content = body?.data?.content || body?.content || ''
    const m = content.match(/\{[\s\S]*"patches"[\s\S]*\}/)
    plan = m ? JSON.parse(m[0]) : { raw: content }
  }
} catch (e) {
  planError = `Could not reach AI router at ${API_URL}: ${e.message}`
}

// ─── Persist + display ───────────────────────────────────────────────────────
const eventId = crypto.randomUUID()
await sql`
  INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
  VALUES (
    ${eventId}, 'brain.plan_generated', ${WORKSPACE},
    ${sql.json({ state_summary: {
      audit: audit.length, failures: failures.length, incidents: incidents.length,
      knowledge: knowledge.length, feeds: feeds.length,
    }, plan, error: planError })},
    ${crypto.randomUUID()}, ${crypto.randomUUID()}, 'brain-plan', 1, ${Date.now()}
  )
`

if (planError) {
  console.log(`⚠  ${planError}\n`)
  console.log('State snapshot saved to events table for later replay.')
} else {
  console.log('📋  Proposed patches:\n')
  console.log(JSON.stringify(plan, null, 2))
  console.log(`\n✓  Plan stored in events (id=${eventId})`)
}

await sql.end()
process.exit(planError ? 2 : 0)
