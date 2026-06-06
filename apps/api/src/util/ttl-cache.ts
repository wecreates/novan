/**
 * R146.325 (#6) — minimal TTL cache for hot-read routes.
 *
 * Operator UI polls /scores, /governor, /coordinator etc. on a tight loop.
 * Each call recomputes DB-heavy aggregates. This 30s cache cuts that to one
 * compute per workspace per window.
 *
 * Per-key keyed Map with absolute-expiry. No eviction sweeper — entries
 * are validated on read. Soft-cap to 1000 entries to bound memory.
 */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expiresAt: number }>()
  constructor(private ttlMs: number = 30_000, private maxEntries: number = 1000) {}
  get(key: string): V | undefined {
    const e = this.store.get(key)
    if (!e) return undefined
    if (e.expiresAt < Date.now()) { this.store.delete(key); return undefined }
    return e.value
  }
  set(key: string, value: V): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }
  delete(key: string): void { this.store.delete(key) }
  clear(): void { this.store.clear() }
  /** Compute-and-cache; safe for concurrent callers (last writer wins). */
  async memoize(key: string, compute: () => Promise<V>): Promise<V> {
    const cached = this.get(key)
    if (cached !== undefined) return cached
    const value = await compute()
    this.set(key, value)
    return value
  }
}
