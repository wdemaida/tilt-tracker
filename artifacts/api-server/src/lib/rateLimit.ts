// A small in-memory sliding-window rate limiter, keyed per user.
//
// Deliberately minimal: one Render instance, so process memory is the whole picture, and a restart
// resetting the counters is harmless for the lookups it guards. If the api-server ever scales out,
// this needs a shared store — per-instance counts would multiply the effective limit.

export interface RateLimiter {
  /** Records a hit for `key` and says whether it's within the limit. */
  hit(key: string | number): { allowed: boolean; retryAfterMs: number };
}

export function createRateLimiter(
  { limit, windowMs, now = () => Date.now() }: { limit: number; windowMs: number; now?: () => number },
): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    hit(key) {
      const k = String(key);
      const t = now();
      const recent = (hits.get(k) ?? []).filter(ts => t - ts < windowMs);
      if (recent.length >= limit) {
        hits.set(k, recent);
        return { allowed: false, retryAfterMs: windowMs - (t - recent[0]) };
      }
      recent.push(t);
      hits.set(k, recent);
      // Keep the map from growing without bound: drop keys whose window has fully passed.
      if (hits.size > 5000) {
        for (const [key2, list] of hits) if (list.every(ts => t - ts >= windowMs)) hits.delete(key2);
      }
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
