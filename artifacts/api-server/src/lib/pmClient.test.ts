// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/pmClient.test.ts   (from artifacts/api-server)
// No network: every test injects a fake fetch. Fixture / cache / budget files go to a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPmClient, PmApiError, parseRetryAfter, requestKey, logKey, fixtureFileName, resolvePmMode, isProductionEnv,
  PM_USER_AGENT, type PmClientOptions,
} from './pmClient.js';

/** Resolves a rejection to the error so assertions can inspect `.kind` etc. */
const asErr = (e: unknown): PmApiError => e as PmApiError;
const unexpected = (): PmApiError => { throw new Error('expected the request to fail'); };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pmclient-test-'));
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A client on a fake clock whose sleep advances that clock. */
function harness(extra: Partial<PmClientOptions> = {}) {
  let t = 1_700_000_000_000;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  let responder: (url: string) => Response | Promise<Response> = () => json({ ok: true });
  const client = createPmClient({
    token: 'SECRET-TOKEN',
    production: true,
    now: () => t,
    sleep: async ms => { sleeps.push(ms); t += ms; },
    log: line => logs.push(line),
    fetchImpl: (async (url: any, init: any) => { calls.push({ url: String(url), init }); return responder(String(url)); }) as typeof fetch,
    ...extra,
  });
  return {
    client, calls, logs, sleeps,
    advance: (ms: number) => { t += ms; },
    respond: (fn: typeof responder) => { responder = fn; },
  };
}

test('adds the token on the query string, an identifying User-Agent, and never logs the token', async () => {
  const h = harness();
  await h.client.get('/locations/1.json', { metadata_only: 1 });
  assert.equal(h.calls.length, 1);
  const url = new URL(h.calls[0].url);
  assert.equal(url.searchParams.get('api_token'), 'SECRET-TOKEN');
  assert.equal(url.searchParams.get('metadata_only'), '1');
  assert.equal((h.calls[0].init.headers as Record<string, string>)['User-Agent'], PM_USER_AGENT);
  assert.ok(h.calls[0].init.signal, 'every request carries a timeout signal');
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /^\[PM live\] GET \/locations\/1\.json\?metadata_only=1 200 \d+ms \(1 today\)$/);
  assert.ok(!h.logs.join('\n').includes('SECRET'), 'token never logged');
});

test('log line: roster vs metadata requests are distinguishable; credentials dropped, coordinates masked', async () => {
  const h = harness();
  await h.client.get('/locations/10804.json');
  await h.client.get('/locations/10804.json', { metadata_only: 1 });
  await h.client.get('/locations/closest_by_lat_lon.json', { lat: 42.123, lon: -71.456, max_distance: 1, api_token: 'X-PARAM-TOKEN' });
  assert.match(h.logs[0], /^\[PM live\] GET \/locations\/10804\.json 200 /);
  assert.match(h.logs[1], /^\[PM live\] GET \/locations\/10804\.json\?metadata_only=1 200 /);
  assert.match(h.logs[2], /^\[PM live\] GET \/locations\/closest_by_lat_lon\.json\?lat=~&lon=~&max_distance=1 200 /);
  const all = h.logs.join('\n');
  for (const secret of ['SECRET', 'X-PARAM-TOKEN', '42.123', '71.456']) assert.ok(!all.includes(secret), `${secret} never logged`);
});

test('log line: sensitive requests log the path only; credential params are dropped even if not flagged', async () => {
  const h = harness();
  h.respond(() => json({ user: { username: 'u', email: 'e@x', authentication_token: 't' } }));
  await h.client.request({ path: '/users/auth_details.json', params: { login: 'me@example.com', password: 'hunter2' }, sensitive: true });
  await h.client.request({ method: 'POST', path: '/machine_score_xrefs.json', body: { user_email: 'me@example.com', user_token: 'UT', score: '1' }, sensitive: true });
  assert.match(h.logs[0], /^\[PM live\] GET \/users\/auth_details\.json 200 /);
  assert.match(h.logs[1], /^\[PM live\] POST \/machine_score_xrefs\.json 200 /);
  assert.equal(
    logKey({ path: '/x.json', params: { user_email: 'a@b', user_token: 't', password: 'p', login: 'l', email: 'e', q: 'ok' } }),
    'GET /x.json?q=ok',
  );
  const all = h.logs.join('\n');
  for (const secret of ['me@example.com', 'hunter2', 'UT', 'SECRET']) assert.ok(!all.includes(secret), `${secret} never logged`);
});

test('token bucket: a burst of 5 goes straight through, then 1 per second', async () => {
  const h = harness();
  for (let i = 0; i < 7; i++) await h.client.get(`/locations/${i}.json`);
  assert.equal(h.calls.length, 7);
  const waited = h.sleeps.reduce((a, b) => a + b, 0);
  assert.ok(waited >= 1990 && waited <= 2010, `6th and 7th waited ~1s each (got ${waited}ms)`);
});

test('token bucket refuses up front when the queue would exceed the max wait', async () => {
  const h = harness({ maxQueueWaitMs: 3000, sleep: () => new Promise<void>(() => {}) });
  const pending: Promise<unknown>[] = [];
  for (let i = 0; i < 8; i++) pending.push(h.client.get(`/locations/${i}.json`).catch(() => undefined));
  // 5 burst + 3 queued (≤3s) are accepted; the 9th would wait >3s.
  const refused = await h.client.get('/locations/99.json').then(unexpected, asErr);
  assert.ok(refused instanceof PmApiError);
  assert.equal(refused.kind, 'rate_limited');
});

test('concurrency is capped at 2', async () => {
  const h = harness();
  let active = 0;
  let maxActive = 0;
  const releases: Array<() => void> = [];
  h.respond(() => {
    active++; maxActive = Math.max(maxActive, active);
    return new Promise<Response>(resolve => releases.push(() => { active--; resolve(json({})); }));
  });
  const all = Promise.all([1, 2, 3, 4].map(i => h.client.get(`/locations/${i}.json`)));
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 5));
    releases.shift()?.();
  }
  await all;
  assert.equal(maxActive, 2);
  assert.equal(h.calls.length, 4);
});

test('identical in-flight GETs share one request', async () => {
  const h = harness();
  let release!: () => void;
  h.respond(() => new Promise<Response>(r => { release = () => r(json({ machines: [1] })); }));
  const a = h.client.get('/machines.json', { no_details: 1 });
  const b = h.client.get('/machines.json', { no_details: 1 });
  await new Promise(r => setTimeout(r, 5));
  release();
  assert.deepEqual(await a, await b);
  assert.equal(h.calls.length, 1);
  // Finished requests aren't cached by the client itself — that's the callers' DB caches' job.
  h.respond(() => json({ machines: [1] }));
  await h.client.get('/machines.json', { no_details: 1 });
  assert.equal(h.calls.length, 2);
});

test('429 opens the breaker for Retry-After; calls fail fast until it passes', async () => {
  const h = harness();
  h.respond(() => json({ error: 'slow down' }, 429, { 'retry-after': '120' }));
  const first = await h.client.get('/locations/1.json').then(unexpected, asErr);
  assert.equal(first.kind, 'rate_limited');
  assert.equal(first.retryAfterMs, 120_000);

  h.respond(() => json({ ok: true }));
  const blocked = await h.client.get('/locations/2.json').then(unexpected, asErr);
  assert.ok(blocked instanceof PmApiError);
  assert.equal(blocked.kind, 'rate_limited');
  assert.equal(h.calls.length, 1, 'no request while open');

  h.advance(121_000);
  await h.client.get('/locations/2.json');
  assert.equal(h.calls.length, 2);
});

test('429 without Retry-After opens the breaker for 15 minutes', async () => {
  const h = harness();
  h.respond(() => json({}, 429));
  await h.client.get('/a.json').catch(() => {});
  h.respond(() => json({}));
  h.advance(14 * 60_000);
  assert.equal((await h.client.get('/b.json').then(unexpected, asErr)).kind, 'rate_limited');
  h.advance(61_000);
  await h.client.get('/b.json');
  assert.equal(h.calls.length, 2);
});

test('5xx opens the breaker for 2 minutes as "unavailable"', async () => {
  const h = harness();
  h.respond(() => json({}, 503));
  assert.equal((await h.client.get('/a.json').then(unexpected, asErr)).kind, 'http');
  h.respond(() => json({}));
  const blocked = await h.client.get('/b.json').then(unexpected, asErr);
  assert.equal(blocked.kind, 'unavailable');
  assert.ok(blocked.retryAfterMs! > 0 && blocked.retryAfterMs! <= 120_000);
  h.advance(120_001);
  await h.client.get('/b.json');
  assert.equal(h.calls.length, 2);
});

test('404 is not_found and does not trip the breaker', async () => {
  const h = harness();
  h.respond(() => json({}, 404));
  assert.equal((await h.client.get('/locations/9.json').then(unexpected, asErr)).kind, 'not_found');
  h.respond(() => json({ id: 1 }));
  await h.client.get('/locations/1.json');
  assert.equal(h.calls.length, 2);
});

test('a rejected user credential (sensitive) does not trip the breaker; a rejected api_token does', async () => {
  const h = harness();
  h.respond(() => new Response('bad password', { status: 401 }));
  const e1 = await h.client.request({ path: '/users/auth_details.json', params: { login: 'a', password: 'b' }, sensitive: true }).then(unexpected, asErr);
  assert.equal(e1.kind, 'unauthorized');
  assert.equal(e1.detail, 'bad password');
  h.respond(() => json({}));
  await h.client.get('/locations/1.json');
  h.respond(() => new Response('A valid api_token is required', { status: 401 }));
  await h.client.get('/locations/2.json').catch(() => {});
  assert.equal((await h.client.get('/locations/3.json').then(unexpected, asErr)).kind, 'unavailable');
  assert.ok(!h.logs.join('\n').includes('password'), 'credentials never logged');
});

test('times out after timeoutMs and opens the breaker', async () => {
  const h = harness({
    timeoutMs: 30,
    now: () => Date.now(),
    fetchImpl: ((_url: any, init: any) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    })) as typeof fetch,
  });
  const err = await h.client.get('/slow.json').then(unexpected, asErr);
  assert.ok(err instanceof PmApiError);
  assert.equal(err.kind, 'network');
  assert.match(err.message, /did not answer within/);
  assert.equal((await h.client.get('/other.json').then(unexpected, asErr)).kind, 'unavailable');
});

test('no token: fails with no_token and never calls', async () => {
  const h = harness({ token: '' });
  assert.equal((await h.client.get('/a.json').then(unexpected, asErr)).kind, 'no_token');
  assert.equal(h.calls.length, 0);
});

test('offline mode serves recorded fixtures and fails loudly on anything unrecorded', async () => {
  const fixturesDir = tmpDir();
  const cacheDir = tmpDir();
  // Record one with a fake fetch...
  const rec = harness({ production: false, mode: 'record', fixturesDir, cacheDir });
  rec.respond(() => json({ id: 20676, name: 'Red Nun' }));
  await rec.client.get('/locations/20676.json');
  assert.equal(rec.calls.length, 1);
  const file = path.join(fixturesDir, fixtureFileName({ path: '/locations/20676.json' }));
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'), 'token never written to fixtures');

  // ...then replay it offline without any fetch.
  const off = harness({ production: false, mode: 'offline', fixturesDir, cacheDir });
  assert.deepEqual(await off.client.get('/locations/20676.json'), { id: 20676, name: 'Red Nun' });
  const missing = await off.client.get('/locations/1.json').then(unexpected, asErr);
  assert.equal(missing.kind, 'offline');
  assert.match(missing.message, /no recorded fixture for GET \/locations\/1\.json/);
  const sensitive = await off.client.request({ path: '/users/auth_details.json', params: { login: 'a', password: 'b' }, sensitive: true }).then(unexpected, asErr);
  assert.equal(sensitive.kind, 'offline');
  assert.equal(off.calls.length, 0);
  assert.ok(off.client.isConfigured(), 'offline counts as configured even without a token');
});

test('fixture keys ignore param order and the token; recorded 404s replay as not_found', async () => {
  assert.equal(requestKey({ path: '/x.json', params: { b: 2, a: 1, api_token: 'T' } }), 'GET /x.json?a=1&b=2');
  assert.equal(fixtureFileName({ path: '/x.json', params: { a: 1, b: 2 } }), fixtureFileName({ path: '/x.json', params: { b: 2, a: 1 } }));
  const fixturesDir = tmpDir();
  const rec = harness({ production: false, mode: 'record', fixturesDir, cacheDir: tmpDir() });
  rec.respond(() => json({}, 404));
  await rec.client.get('/locations/404.json').catch(() => {});
  const off = harness({ production: false, mode: 'offline', fixturesDir, cacheDir: tmpDir() });
  assert.equal((await off.client.get('/locations/404.json').then(unexpected, asErr)).kind, 'not_found');
});

test('non-prod live: served from the on-disk cache (7-day TTL), then a hard budget', async () => {
  const cacheDir = tmpDir();
  const h = harness({ production: false, mode: 'live', cacheDir, fixturesDir: tmpDir(), budgetPerProcess: 2, budgetPerDay: 50 });
  await h.client.get('/a.json');
  await h.client.get('/a.json'); // disk cache hit
  assert.equal(h.calls.length, 1);
  await h.client.get('/b.json');
  assert.equal(h.calls.length, 2);
  const err = await h.client.get('/c.json').then(unexpected, asErr);
  assert.equal(err.kind, 'rate_limited');
  assert.match(err.message, /PM DEV BUDGET EXHAUSTED/);
  assert.ok(h.logs.some(l => l.startsWith('PM DEV BUDGET EXHAUSTED')));
  assert.equal(h.calls.length, 2, 'no call once the budget is spent');
  const budget = JSON.parse(fs.readFileSync(path.join(cacheDir, '_budget.json'), 'utf8'));
  assert.equal(budget.count, 2);

  // The daily cap is machine-wide: a second "process" sharing the cache dir sees the same count.
  const h2 = harness({ production: false, mode: 'live', cacheDir, fixturesDir: tmpDir(), budgetPerProcess: 20, budgetPerDay: 2 });
  assert.equal((await h2.client.get('/d.json').then(unexpected, asErr)).kind, 'rate_limited');
  assert.equal((await h2.client.get('/a.json')) != null, true, 'cached entries still served');
  assert.equal(h2.calls.length, 0);

  // Past the TTL the disk copy is ignored.
  const h3 = harness({ production: false, mode: 'live', cacheDir, fixturesDir: tmpDir(), budgetPerDay: 100, diskCacheTtlMs: -1 });
  await h3.client.get('/a.json');
  assert.equal(h3.calls.length, 1);
});

test('production is always live: no fixtures, no disk cache, no budget', async () => {
  const cacheDir = tmpDir();
  const h = harness({ production: true, mode: 'offline', cacheDir, budgetPerProcess: 0, budgetPerDay: 0 });
  assert.equal(h.client.mode, 'live');
  await h.client.get('/a.json');
  await h.client.get('/a.json');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('environment helpers', () => {
  assert.equal(isProductionEnv({ NODE_ENV: 'production' } as any), true);
  assert.equal(isProductionEnv({ RENDER: 'true' } as any), true, 'Render sets RENDER=true; NODE_ENV is not set there');
  assert.equal(isProductionEnv({} as any), false);
  assert.equal(resolvePmMode({} as any), 'offline');
  assert.equal(resolvePmMode({ PM_MODE: 'record' } as any), 'record');
  assert.equal(resolvePmMode({ PM_MODE: 'offline', RENDER: 'true' } as any), 'live');
  assert.throws(() => resolvePmMode({ PM_MODE: 'yolo' } as any));
  assert.equal(parseRetryAfter('30', 0), 30_000);
  assert.equal(parseRetryAfter(new Date(90_000).toUTCString(), 30_000), 60_000);
  assert.equal(parseRetryAfter(null, 0), null);
});
