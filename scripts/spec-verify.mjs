#!/usr/bin/env node
/**
 * R146.325 (#13) — SPEC.md drift detector.
 *
 * Reads SPEC.md, extracts "LOCKED:" blocks (table names, route paths,
 * required env vars), and asserts each invariant against the actual repo:
 *
 *   LOCKED tables → must exist in packages/db/src/schema.ts
 *   LOCKED routes → must exist as `app.<verb>('/path'...)` in routes/
 *   LOCKED env    → must be referenced in code
 *
 * Exit 0 on clean, 1 on any drift. Run from CI; block PRs on failure.
 *
 * Intentionally simple: regex-based, no AST. Catches the common cases
 * (table renamed without SPEC update, route removed). Doesn't catch
 * subtle signature changes — that's what tests are for.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

async function readSpec() {
  try { return await readFile(join(ROOT, 'SPEC.md'), 'utf8') }
  catch { console.error('[spec-verify] SPEC.md not found'); process.exit(2) }
}

function extractLocked(spec, kind) {
  // Look for lines like:  LOCKED: <kind> <value>   or  LOCKED-<kind>: <value>
  const re = new RegExp(`LOCKED:?\\s*${kind}\\s+([\\w./-]+)`, 'gi')
  const out = new Set()
  let m
  while ((m = re.exec(spec)) !== null) out.add(m[1])
  return [...out]
}

async function walk(dir, ext = '.ts') {
  const acc = []
  async function rec(d) {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (['node_modules', 'dist', '.git', '.turbo'].includes(e.name)) continue
        await rec(p)
      } else if (e.name.endsWith(ext)) {
        acc.push(p)
      }
    }
  }
  await rec(dir)
  return acc
}

async function main() {
  const spec = await readSpec()
  const tables = extractLocked(spec, 'table')
  const routes = extractLocked(spec, 'route')
  const envs   = extractLocked(spec, 'env')

  let drift = 0

  // Tables: scan packages/db/src/schema.ts for export const <name> = pgTable
  if (tables.length > 0) {
    const schemaPath = join(ROOT, 'packages/db/src/schema.ts')
    const schemaSrc = await readFile(schemaPath, 'utf8').catch(() => '')
    for (const t of tables) {
      const camel = t.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      const re = new RegExp(`export const ${camel}\\s*=\\s*pgTable`)
      if (!re.test(schemaSrc)) {
        console.error(`[spec-verify] DRIFT: LOCKED table "${t}" not found in schema.ts`)
        drift++
      }
    }
  }

  // Routes: scan apps/api/src/routes for the path string literal
  if (routes.length > 0) {
    const files = await walk(join(ROOT, 'apps/api/src/routes'))
    const allSrc = (await Promise.all(files.map(f => readFile(f, 'utf8').catch(() => '')))).join('\n')
    for (const r of routes) {
      if (!allSrc.includes(`'${r}'`) && !allSrc.includes(`"${r}"`)) {
        console.error(`[spec-verify] DRIFT: LOCKED route "${r}" not found in any route file`)
        drift++
      }
    }
  }

  // Envs: scan apps/api/src and packages/ for process.env['<name>']
  if (envs.length > 0) {
    const files = [...await walk(join(ROOT, 'apps/api/src')), ...await walk(join(ROOT, 'packages'))]
    const allSrc = (await Promise.all(files.map(f => readFile(f, 'utf8').catch(() => '')))).join('\n')
    for (const e of envs) {
      if (!allSrc.includes(`'${e}'`) && !allSrc.includes(`"${e}"`)) {
        console.error(`[spec-verify] DRIFT: LOCKED env "${e}" not referenced in code`)
        drift++
      }
    }
  }

  if (drift > 0) {
    console.error(`[spec-verify] ${drift} drift(s) detected`)
    process.exit(1)
  }
  console.log(`[spec-verify] OK — verified ${tables.length} tables, ${routes.length} routes, ${envs.length} envs`)
}

void main().catch(e => { console.error(e); process.exit(2) })
