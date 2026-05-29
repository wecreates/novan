/**
 * raw-rows.ts — type-safe helper for db.execute() results.
 *
 * Drizzle's `db.execute(sql\`...\`)` returns either:
 *   - postgres-js: an Array directly
 *   - postgres-js wrapped: { rows: Array<...> }
 *
 * 30+ sites across the codebase re-implement the same cast pattern:
 *   const r = await db.execute(sql\`...\`)
 *   const rows = (r as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
 *
 * Single helper. If drizzle changes the raw-result shape (it has, between
 * versions), only one place breaks.
 */

export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object') {
    const r = (result as { rows?: unknown }).rows
    if (Array.isArray(r)) return r as T[]
  }
  return []
}

export function firstRow<T = Record<string, unknown>>(result: unknown): T | null {
  const rows = rowsOf<T>(result)
  return rows[0] ?? null
}
