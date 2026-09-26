// The one and only way TiltTrack talks to Pinball Map.
//
// Pinball Map's maintainers granted us an API token personally; the standing rule (root CLAUDE.md,
// "Pinball Map API — standing rule") is that we never hammer their API. Everything that makes that
// true at the transport level lives here, so no call site can forget it:
//
//  - the api_token (query string, per pinballmap.com/llms.txt) — added here and nowhere else;
//  - a global token bucket (1 req/s sustained, burst 5) and a concurrency cap of 2;
//  - in-flight de-duplication of identical GETs (two callers asking for the same URL share one call);
//  - a 10 s timeout on every request;
//  - a circuit breaker: a 429 opens it for Retry-After (default 15 min), a 5xx / network error /
//    timeout for 2 min, a rejected api_token for 15 min. While open, calls fail fast with a
//    PmApiError — nothing retries per request;
//  - an identifying User-Agent, a daily call counter and one log line per live call (endpoint path
//    only — never the query string, which carries the token and, for auth, the user's credentials).
//
// Outside production there is more (see `PM_MODE` below): by default nothing goes to Pinball Map at
// all — requests are answered from recorded fixtures in `fixtures/pm/`, and anything unrecorded
// fails loudly. `record` makes the live call once and saves the fixture; `live` goes through an
// on-disk cache (7-day TTL) and a hard daily budget.
//
// Production detection is `NODE_ENV === 'production'` OR `RENDER === 'true'` — Render sets RENDER on
// every service automatically, and render.yaml / the start script (`tsx src/index.ts`) do not set
// NODE_ENV, so keying on NODE_ENV alone would have put production into offline mode. Production
// needs no new environment variables: it is always `live`, with no disk cache and no budget.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PM_BASE = 'https://pinballmap.com/api/v1';
export const PM_USER_AGENT = 'TiltTrack/1.0 (+https://tilttrack.vercel.app; wdemaida@gmail.com)';

export type PmErrorKind =
  | 'no_token'      // PINBALL_MAP_API_TOKEN not set
  | 'unauthorized'  // 401/403
  | 'not_found'     // 404, or a 200 whose body says the record doesn't exist
  | 'rate_limited'  // 429 from Pinball Map, our own limiter queue, or the dev budget
  | 'unavailable'   // circuit breaker open — failing fast without calling
  | 'http'          // other non-2xx
  | 'network'       // fetch failed or timed out
  | 'offline';      // PM_MODE=offline and there is no fixture for this request

export class PmApiError extends Error {
  constructor(
    public kind: PmErrorKind,
    message: string,
    public status?: number,
    /** When a retry could make sense (breaker / rate limit), in ms. */
    public retryAfterMs?: number,
    /** First ~200 chars of the response body on 401/403 — lets a caller tell api_token from user_token. */
    public detail?: string,
  ) {
    super(message);
    this.name = 'PmApiError';
  }
}

export type PmMode = 'offline' | 'record' | 'live';

export interface PmRequest {
  path: string;
  params?: Record<string, string | number | undefined>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /**
   * Carries user credentials or a user token (auth_details, score submission). Never de-duplicated,
   * cached, recorded or served from fixtures, and a 401/403 doesn't trip the breaker (that's the
   * user's password, not our api_token).
   */
  sensitive?: boolean;
}

export interface PmResponse<T> {
  status: number;
  body: T;
}

export interface PmClientOptions {
  token?: string;
  production?: boolean;
  mode?: PmMode;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  ratePerSec?: number;
  burst?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Longest a request may wait in the local limiter queue before failing as rate_limited. */
  maxQueueWaitMs?: number;
  fixturesDir?: string;
  cacheDir?: string;
  diskCacheTtlMs?: number;
  budgetPerDay?: number;
  budgetPerProcess?: number;
}

export interface PmClientStats {
  mode: PmMode;
  production: boolean;
  liveCallsToday: number;
  breakerOpenUntil: number | null;
  breakerReason: string | null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/lib → artifacts/api-server
const API_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_FIXTURES_DIR = path.join(API_ROOT, 'fixtures', 'pm');
export const DEFAULT_CACHE_DIR = path.join(API_ROOT, '.pm-cache');

const DAY_MS = 24 * 60 * 60_000;
const BREAKER_429_DEFAULT_MS = 15 * 60_000;
const BREAKER_5XX_MS = 2 * 60_000;
const BREAKER_AUTH_MS = 15 * 60_000;

export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || env.RENDER === 'true';
}

export function resolvePmMode(env: NodeJS.ProcessEnv = process.env): PmMode {
  if (isProductionEnv(env)) return 'live';
  const m = (env.PM_MODE ?? '').trim().toLowerCase();
  if (m === 'live' || m === 'record' || m === 'offline') return m;
  if (m) throw new Error(`PM_MODE must be offline, record or live (got "${env.PM_MODE}")`);
  return 'offline';
}

/** Parses Retry-After (delta-seconds or an HTTP date) into ms from now; null when absent/garbled. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/** Stable key for a request: method, path and params sorted — never the token. */
export function requestKey(req: PmRequest): string {
  const params = Object.entries(req.params ?? {})
    .filter(([k, v]) => v !== undefined && k !== 'api_token')
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${req.method ?? 'GET'} ${req.path}${qs ? `?${qs}` : ''}`;
}

/**
 * File name for a request's fixture / disk-cache entry: readable slug of path + params, with a short
 * hash so two keys can never collide after slugging. e.g.
 *   GET /locations/20676.json → locations_20676.json__3f2a9c1d.json
 */
export function fixtureFileName(req: PmRequest): string {
  const key = requestKey(req);
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  const rest = key.replace(/^(GET|POST) \//, '');
  const slug = rest.replace(/[^A-Za-z0-9.=-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 120);
  return `${slug}__${hash}.json`;
}

interface StoredResponse {
  key: string;
  status: number;
  recordedAt: string;
  body: unknown;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function localDateKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface PmClient {
  request<T>(req: PmRequest): Promise<PmResponse<T>>;
  get<T>(pathName: string, params?: PmRequest['params']): Promise<T>;
  isConfigured(): boolean;
  stats(): PmClientStats;
  readonly mode: PmMode;
}

export function createPmClient(opts: PmClientOptions = {}): PmClient {
  const production = opts.production ?? isProductionEnv();
  const mode: PmMode = production ? 'live' : (opts.mode ?? resolvePmMode());
  const token = opts.token ?? process.env.PINBALL_MAP_API_TOKEN;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.log(line));
  const ratePerSec = opts.ratePerSec ?? 1;
  const burst = opts.burst ?? 5;
  const concurrency = opts.concurrency ?? 2;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxQueueWaitMs = opts.maxQueueWaitMs ?? 20_000;
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const diskCacheTtlMs = opts.diskCacheTtlMs ?? 7 * DAY_MS;
  const envBudget = process.env.PM_DEV_BUDGET != null && process.env.PM_DEV_BUDGET !== ''
    ? Number(process.env.PM_DEV_BUDGET) : undefined;
  const budgetPerDay = opts.budgetPerDay ?? (Number.isFinite(envBudget) ? envBudget! : 50);
  const budgetPerProcess = opts.budgetPerProcess ?? (Number.isFinite(envBudget) ? envBudget! : 20);

  // ── Token bucket + concurrency ────────────────────────────────────────────────────────────────
  let tokens = burst;
  let lastRefill = now();
  // Serialises bucket reservations so waiters are served in arrival order.
  let bucketChain: Promise<void> = Promise.resolve();
  let active = 0;
  const slotWaiters: Array<() => void> = [];

  function refill() {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - lastRefill) / 1000) * ratePerSec);
    lastRefill = t;
  }

  let waiting = 0;

  function takeToken(): Promise<void> {
    // Refuse up front when the queue ahead is already longer than we'd make anyone wait — a burst
    // of 100 requests must not turn into 100 seconds of queued calls.
    refill();
    const estimateMs = ((waiting + 1 - tokens) / ratePerSec) * 1000;
    if (estimateMs > maxQueueWaitMs) {
      return Promise.reject(new PmApiError('rate_limited', 'TiltTrack is pacing its Pinball Map requests — try again shortly', undefined, Math.ceil(estimateMs)));
    }
    waiting++;
    const turn = bucketChain.then(async () => {
      refill();
      if (tokens < 1) {
        const waitMs = Math.ceil(((1 - tokens) / ratePerSec) * 1000);
        if (waitMs > maxQueueWaitMs) {
          throw new PmApiError('rate_limited', 'TiltTrack is pacing its Pinball Map requests — try again shortly', undefined, waitMs);
        }
        await sleep(waitMs);
        refill();
      }
      tokens -= 1;
    }).finally(() => { waiting--; });
    // A refused turn must not poison the chain for the next caller.
    bucketChain = turn.catch(() => undefined);
    return turn;
  }

  async function acquireSlot() {
    if (active < concurrency) { active++; return; }
    await new Promise<void>(resolve => slotWaiters.push(resolve));
    active++;
  }
  function releaseSlot() {
    active--;
    const next = slotWaiters.shift();
    if (next) next();
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────────────────────────
  let breakerOpenUntil = 0;
  let breakerReason: string | null = null;
  let breakerKind: PmErrorKind = 'unavailable';

  function openBreaker(ms: number, reason: string, kind: PmErrorKind) {
    const until = now() + ms;
    if (until > breakerOpenUntil) {
      breakerOpenUntil = until;
      breakerReason = reason;
      breakerKind = kind;
      log(`[PM breaker] open for ${Math.round(ms / 1000)}s — ${reason}`);
    }
  }

  function checkBreaker() {
    const left = breakerOpenUntil - now();
    if (left > 0) {
      const mins = Math.max(1, Math.ceil(left / 60_000));
      const kind = breakerKind === 'rate_limited' ? 'rate_limited' : 'unavailable';
      throw new PmApiError(kind,
        `Pinball Map is ${kind === 'rate_limited' ? 'rate limiting us' : 'unavailable'} — try again in ${mins} minute${mins === 1 ? '' : 's'}`,
        undefined, left);
    }
  }

  // ── Counters / budget ─────────────────────────────────────────────────────────────────────────
  let dayKey = localDateKey(now());
  let liveToday = 0;
  let liveThisProcess = 0;
  const budgetFile = path.join(cacheDir, '_budget.json');

  function countLiveCall(): number {
    const k = localDateKey(now());
    if (k !== dayKey) { dayKey = k; liveToday = 0; }
    liveToday++;
    liveThisProcess++;
    if (production) return liveToday;
    // Machine-wide counter shared by every dev process (servers, scripts, tests with real fetch).
    const stored = readJsonFile<{ date: string; count: number }>(budgetFile);
    const count = (stored?.date === k ? stored.count : 0) + 1;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(budgetFile, JSON.stringify({ date: k, count }));
    } catch { /* best effort */ }
    return count;
  }

  function checkBudget() {
    if (production) return;
    const k = localDateKey(now());
    const stored = readJsonFile<{ date: string; count: number }>(budgetFile);
    const machineToday = stored?.date === k ? stored.count : 0;
    if (machineToday >= budgetPerDay || liveThisProcess >= budgetPerProcess) {
      log(`PM DEV BUDGET EXHAUSTED — ${machineToday}/${budgetPerDay} today on this machine, ${liveThisProcess}/${budgetPerProcess} this process. Not calling Pinball Map. Set PM_DEV_BUDGET=<n> to override, or use PM_MODE=offline.`);
      throw new PmApiError('rate_limited', 'PM DEV BUDGET EXHAUSTED — no more live Pinball Map calls today from this machine/process (PM_DEV_BUDGET to override)');
    }
  }

  // ── Fixtures / disk cache (non-production only) ──────────────────────────────────────────────
  function readStored(dir: string, req: PmRequest, maxAgeMs?: number): StoredResponse | null {
    const stored = readJsonFile<StoredResponse>(path.join(dir, fixtureFileName(req)));
    if (!stored) return null;
    if (maxAgeMs != null && now() - Date.parse(stored.recordedAt) > maxAgeMs) return null;
    return stored;
  }
  function writeStored(dir: string, req: PmRequest, res: PmResponse<unknown>) {
    const stored: StoredResponse = { key: requestKey(req), status: res.status, recordedAt: new Date(now()).toISOString(), body: res.body };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fixtureFileName(req)), JSON.stringify(stored, null, 1));
    } catch (err) {
      log(`[PM] could not write ${dir}/${fixtureFileName(req)}: ${(err as Error).message}`);
    }
  }

  // ── The live call ─────────────────────────────────────────────────────────────────────────────
  async function live<T>(req: PmRequest): Promise<PmResponse<T>> {
    if (!token) {
      throw new PmApiError('no_token', 'PINBALL_MAP_API_TOKEN is not set — request a key at https://pinballmap.com/api_token');
    }
    checkBreaker();
    checkBudget();
    await takeToken();
    await acquireSlot();
    try {
      checkBreaker(); // it may have opened while we queued
    } catch (err) {
      releaseSlot();
      throw err;
    }
    const started = now();
    let status = 0;
    try {
      const url = new URL(`${PM_BASE}${req.path}`);
      for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      url.searchParams.set('api_token', token);

      let res: Response;
      try {
        res = await fetchImpl(url.toString(), {
          method: req.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': PM_USER_AGENT,
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const e = err as Error;
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        openBreaker(BREAKER_5XX_MS, timedOut ? 'timeout' : 'network error', 'unavailable');
        throw new PmApiError('network', timedOut
          ? `Pinball Map did not answer within ${Math.round(timeoutMs / 1000)}s`
          : `Could not reach Pinball Map: ${e?.message ?? e}`);
      }
      status = res.status;

      if (status === 429) {
        const ms = parseRetryAfter(res.headers.get('retry-after'), now()) ?? BREAKER_429_DEFAULT_MS;
        openBreaker(ms, '429 Too Many Requests', 'rate_limited');
        throw new PmApiError('rate_limited', 'Pinball Map rate limit hit — try again in a few minutes', 429, ms);
      }
      if (status === 401 || status === 403) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        if (!req.sensitive) openBreaker(BREAKER_AUTH_MS, `api_token rejected (${status})`, 'unavailable');
        throw new PmApiError('unauthorized', req.sensitive
          ? 'Pinball Map rejected those credentials'
          : 'Pinball Map rejected the API token — check PINBALL_MAP_API_TOKEN', status, undefined, detail);
      }
      if (status === 404) {
        throw new PmApiError('not_found', 'Pinball Map has no such record', 404);
      }
      if (status >= 500) {
        openBreaker(BREAKER_5XX_MS, `HTTP ${status}`, 'unavailable');
        throw new PmApiError('http', `Pinball Map returned ${status}`, status);
      }
      if (!res.ok) {
        throw new PmApiError('http', `Pinball Map returned ${status}`, status);
      }
      let body: T;
      try {
        body = (await res.json()) as T;
      } catch {
        throw new PmApiError('http', 'Pinball Map returned a response that was not JSON', status);
      }
      return { status, body };
    } finally {
      releaseSlot();
      const n = countLiveCall();
      // Path only: the query string holds the api_token (and, for auth, the user's credentials).
      log(`[PM live] ${req.method ?? 'GET'} ${req.path} ${status || 'ERR'} ${now() - started}ms (${n} today)`);
    }
  }

  function replay<T>(stored: StoredResponse): PmResponse<T> {
    if (stored.status === 404) throw new PmApiError('not_found', 'Pinball Map has no such record', 404);
    if (stored.status < 200 || stored.status >= 300) {
      throw new PmApiError('http', `Pinball Map returned ${stored.status} (recorded)`, stored.status);
    }
    return { status: stored.status, body: stored.body as T };
  }

  async function dispatch<T>(req: PmRequest): Promise<PmResponse<T>> {
    if (production) return live<T>(req);

    if (mode === 'offline') {
      if (req.sensitive) {
        throw new PmApiError('offline', `PM_MODE=offline: ${req.method ?? 'GET'} ${req.path} carries user credentials and is never recorded — run with PM_MODE=live to exercise it deliberately`);
      }
      const stored = readStored(fixturesDir, req);
      if (!stored) {
        const msg = `PM_MODE=offline: no recorded fixture for ${requestKey(req)} (expected fixtures/pm/${fixtureFileName(req)}). Record it once with PM_MODE=record.`;
        log(`[PM offline] ${msg}`);
        throw new PmApiError('offline', msg);
      }
      return replay<T>(stored);
    }

    if (mode === 'record') {
      if (req.sensitive) return live<T>(req);
      try {
        const res = await live<T>(req);
        writeStored(fixturesDir, req, res);
        return res;
      } catch (err) {
        if (err instanceof PmApiError && err.kind === 'not_found') writeStored(fixturesDir, req, { status: 404, body: null });
        throw err;
      }
    }

    // live, non-production: on-disk cache first (shared by every process), then the budgeted call.
    if (!req.sensitive) {
      const cached = readStored(cacheDir, req, diskCacheTtlMs);
      if (cached) return replay<T>(cached);
    }
    try {
      const res = await live<T>(req);
      if (!req.sensitive) writeStored(cacheDir, req, res);
      return res;
    } catch (err) {
      if (!req.sensitive && err instanceof PmApiError && err.kind === 'not_found') writeStored(cacheDir, req, { status: 404, body: null });
      throw err;
    }
  }

  const inflight = new Map<string, Promise<PmResponse<unknown>>>();

  function request<T>(req: PmRequest): Promise<PmResponse<T>> {
    const method = req.method ?? 'GET';
    if (method !== 'GET' || req.sensitive) return dispatch<T>(req);
    const key = requestKey(req);
    const pending = inflight.get(key);
    if (pending) return pending as Promise<PmResponse<T>>;
    const p = dispatch<T>(req).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    mode,
    request,
    async get<T>(pathName: string, params?: PmRequest['params']) {
      return (await request<T>({ path: pathName, params })).body;
    },
    // Offline mode needs no token — fixtures answer everything that's recorded.
    isConfigured: () => !!token || (!production && mode === 'offline'),
    stats: () => ({
      mode,
      production,
      liveCallsToday: liveToday,
      breakerOpenUntil: breakerOpenUntil > now() ? breakerOpenUntil : null,
      breakerReason: breakerOpenUntil > now() ? breakerReason : null,
    }),
  };
}

// Built on first use, not at import, so dotenv has loaded by then and tests can import this module
// (for createPmClient) without constructing — or configuring — the real one.
let singleton: PmClient | null = null;
export function pmClient(): PmClient {
  if (!singleton) {
    singleton = createPmClient();
    if (!singleton.stats().production) {
      console.log(`[PM] mode=${singleton.mode} (non-production; set PM_MODE=offline|record|live)`);
    }
  }
  return singleton;
}
