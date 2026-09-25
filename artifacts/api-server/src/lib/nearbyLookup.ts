// Guards for `POST /api/upload/nearby-venues` ("Use my current location" on the Add Score wizard).
//
// That route costs a HERE browse call and a Pinball Map call per tap, and Pinball Map explicitly
// asks for request volume that scales with how often their data changes, not with our traffic (see
// api-server CLAUDE.md). So: a per-user rate limit, and a short cache per ~110m cell so repeat taps
// from the same spot — the same user retrying, or a group at one venue — reuse one lookup.
//
// Both are in-memory, per process. That's enough for a single Render instance; a restart simply
// forgets them, which errs toward allowing requests, never toward blocking a legitimate user.
// Everything takes `now` so it's testable without timers.

export interface RateWindow {
  /** Window length in ms. */
  ms: number;
  /** Requests allowed per window. */
  max: number;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

/** Sliding-window limiter over several windows at once (e.g. per minute *and* per day). */
export class SlidingRateLimiter {
  private hits = new Map<string, number[]>();
  private readonly longest: number;

  constructor(private readonly windows: RateWindow[]) {
    this.longest = Math.max(...windows.map(w => w.ms));
  }

  /** Records a hit for `key` if every window has room; otherwise refuses without recording. */
  take(key: string, now = Date.now()): RateDecision {
    const kept = (this.hits.get(key) ?? []).filter(t => now - t < this.longest);
    let retryAfterMs = 0;
    for (const w of this.windows) {
      const inWindow = kept.filter(t => now - t < w.ms);
      if (inWindow.length >= w.max) {
        // The oldest hit still inside this window is the one that has to age out first.
        const oldest = inWindow[inWindow.length - w.max];
        retryAfterMs = Math.max(retryAfterMs, oldest + w.ms - now);
      }
    }
    if (retryAfterMs > 0) {
      this.hits.set(key, kept);
      return { ok: false, retryAfterMs };
    }
    kept.push(now);
    this.hits.set(key, kept);
    return { ok: true };
  }

  /** Drops keys with no hits left in any window — call occasionally so the map can't grow forever. */
  sweep(now = Date.now()) {
    for (const [key, times] of this.hits) {
      if (!times.some(t => now - t < this.longest)) this.hits.delete(key);
    }
  }
}

/** Minimal TTL cache. Expired entries are removed on read and by `sweep`. */
export class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 5000) {}

  get(key: string, now = Date.now()): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, now = Date.now()) {
    if (this.entries.size >= this.maxEntries) this.sweep(now);
    // Still full of live entries: evict the oldest insertion (Map preserves insertion order).
    if (this.entries.size >= this.maxEntries) {
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  sweep(now = Date.now()) {
    for (const [key, e] of this.entries) if (e.expires <= now) this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}

/** Cache key for a point: coordinates rounded to 3 decimals (~110m of latitude). */
export function coordCellKey(lat: number, lng: number): string {
  // `+ 0` folds -0 into 0 so the cell either side of the equator/meridian has one spelling.
  return `${(Math.round(lat * 1000) / 1000 + 0).toFixed(3)},${(Math.round(lng * 1000) / 1000 + 0).toFixed(3)}`;
}

/**
 * Wraps a point lookup so that every point in one cell shares one call for the cache's TTL — in
 * flight or finished, so two concurrent taps make one request. A rejected call, or a result
 * `keep` refuses (a partial failure), is dropped so the next tap tries again.
 */
export function cachedByCell<T>(
  fetch: (lat: number, lng: number) => Promise<T>,
  cache: TtlCache<Promise<T>>,
  keep: (result: T) => boolean = () => true,
): (lat: number, lng: number) => Promise<T> {
  return (lat, lng) => {
    const key = coordCellKey(lat, lng);
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = fetch(lat, lng);
    cache.set(key, pending);
    pending.then(r => { if (!keep(r) && cache.get(key) === pending) cache.delete(key); },
      () => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };
}

export const NEARBY_RATE_WINDOWS: RateWindow[] = [
  { ms: 60_000, max: 10 },
  { ms: 24 * 60 * 60_000, max: 100 },
];
export const NEARBY_CACHE_TTL_MS = 10 * 60_000;

export function rateLimitMessage(retryAfterMs: number): string {
  const minutes = Math.ceil(retryAfterMs / 60_000);
  return minutes <= 1
    ? 'Too many location lookups — wait a minute and try again, or pick the venue below.'
    : `You've used today's location lookups — pick the venue below, or try again in ${minutes >= 90 ? `${Math.ceil(minutes / 60)} hours` : `${minutes} minutes`}.`;
}
