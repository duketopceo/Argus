export interface ReplayGuard {
  /** Returns true if this delivery id was already seen inside the window; records it otherwise. */
  seen(id: string): boolean
  /** Un-records a delivery id so a failed event can be redelivered inside the window. */
  forget(id: string): void
  size(): number
}

/**
 * Best-effort replay window, held in isolate memory. Isolates are ephemeral
 * and not shared, so this only blunts naive replays; real idempotency comes
 * from handlers checking GitHub state (branch / PR existence). A KV-backed
 * guard can implement the same interface if rate limiting is ever needed.
 */
export function createReplayGuard(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): ReplayGuard {
  const ttlMs = opts.ttlMs ?? 10 * 60_000
  const maxEntries = opts.maxEntries ?? 1000
  const now = opts.now ?? Date.now
  const map = new Map<string, number>() // id -> expiry; insertion order == age order

  function sweep(t: number): void {
    for (const [id, exp] of map) {
      if (exp > t) break
      map.delete(id)
    }
  }

  return {
    seen(id) {
      const t = now()
      sweep(t)
      if (map.has(id)) return true
      map.set(id, t + ttlMs)
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
      return false
    },
    forget(id) {
      map.delete(id)
    },
    size: () => map.size,
  }
}
