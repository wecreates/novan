/**
 * R146.284 — Helper for parsing string→int with a guaranteed-finite fallback.
 *
 * parseInt('abc') === NaN, and NaN passed to drizzle .limit()/.offset()
 * crashes the query. Math.min(NaN, anything) === NaN, so the common
 * Math.min(parseInt(...), MAX) pattern doesn't actually protect.
 *
 * This helper is the single fix point for all 17 parseInt sites under
 * apps/api/src.
 */
export function safeInt(value: unknown, fallback: number, { min, max }: { min?: number; max?: number } = {}): number {
  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    n = parseInt(value, 10)
  } else {
    n = NaN
  }
  if (!Number.isFinite(n)) n = fallback
  if (min !== undefined && n < min) n = min
  if (max !== undefined && n > max) n = max
  return n
}
