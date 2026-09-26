// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/pmAccount.test.ts   (from artifacts/api-server)
// Pinball Map connect + score posting. No network: a pmClient with a fake fetch answers with bodies
// shaped exactly like Pinball Map's source (github.com/pinballmap/pbm @ 1b527c0) — users_controller
// #auth_details, machine_score_xrefs_controller#create, application_controller#return_response /
// #require_api_user, api/v1/base_controller#require_api_token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPmClient, PmApiError } from './pmClient.js';
import { getPmUserToken, submitPmScore } from './pinballmapApi.js';
import { authFailureReply, submitFailureReply, pmErrorReply, storedPmAuth, hasUsablePmConnection, PM_RECONNECT_REQUIRED } from './pmAccount.js';

const AUTH_REQUIRED_MSG = 'Authentication is required for this action. If you are using the app, you may need to confirm your account (see the email from us) or log out and back in.';
const API_TOKEN_REQUIRED_MSG = 'A valid api_token is required for this endpoint. Visit https://pinballmap.com/api_token to request one.';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function harness(respond: () => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let t = 1_700_000_000_000;
  const client = createPmClient({
    token: 'OUR-API-TOKEN',
    production: true, // no fixtures / disk cache / budget — just the fake fetch
    now: () => t,
    sleep: async ms => { t += ms; },
    log: () => {},
    fetchImpl: (async (url: any, init: any) => { calls.push({ url: new URL(String(url)), init }); return respond(); }) as typeof fetch,
  });
  return { client, calls };
}

const asErr = (e: unknown) => e as PmApiError;
const unexpected = () => { throw new Error('expected a throw'); };

// ── auth_details ────────────────────────────────────────────────────────────────────────────────

test('auth: nested success → token, username and PM\'s canonical email; login + password on the query', async () => {
  const h = harness(() => json({ user: { username: 'helmhead', email: 'Will@Example.com', authentication_token: 'tok-123' } }));
  const r = await getPmUserToken('HELMHEAD', 'pw', h.client);
  assert.deepEqual(r, { ok: true, token: 'tok-123', username: 'helmhead', email: 'Will@Example.com' });
  assert.equal(h.calls.length, 1);
  const u = h.calls[0].url;
  assert.equal(u.pathname, '/api/v1/users/auth_details.json');
  assert.equal(u.searchParams.get('login'), 'HELMHEAD');
  assert.equal(u.searchParams.get('password'), 'pw');
  assert.equal(u.searchParams.get('api_token'), 'OUR-API-TOKEN');
});

test('auth: a top-level authentication_token (the old, wrong reading) is not a success', async () => {
  const h = harness(() => json({ authentication_token: 'tok', username: 'x' }));
  const e = await getPmUserToken('x', 'y', h.client).then(unexpected, asErr);
  assert.equal(e.kind, 'http');
});

for (const [msg, reason, status] of [
  ['Unknown user', 'invalid_credentials', 401],
  ['Incorrect password', 'invalid_credentials', 401],
  ['User is not yet confirmed. Please follow emailed confirmation instructions.', 'unconfirmed', 400],
  ['login and password are required fields', 'missing_fields', 400],
] as const) {
  test(`auth: 200 {"errors":"${msg}"} → ${reason} → HTTP ${status}`, async () => {
    const h = harness(() => json({ errors: msg }));
    const r = await getPmUserToken('x', 'y', h.client);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, reason);
    assert.equal(r.message, msg);
    const reply = authFailureReply(r);
    assert.equal(reply.status, status);
    assert.ok(!reply.clearCredential);
    if (reason === 'invalid_credentials') assert.equal(reply.body.error, 'Invalid Pinball Map credentials');
    if (reason === 'unconfirmed') {
      assert.equal(reply.body.code, 'pm_unconfirmed');
      assert.match(reply.body.error, /confirm/i);
      assert.ok(reply.body.error.includes(msg), 'carries PM\'s own message');
    }
  });
}

test('auth: 403 {"error":"account_disabled"} → account_disabled → 403 with a friendly message', async () => {
  const h = harness(() => json({ error: 'account_disabled' }, 403));
  const r = await getPmUserToken('x', 'y', h.client);
  assert.deepEqual(r, { ok: false, reason: 'account_disabled', message: 'account_disabled' });
  if (r.ok) return;
  const reply = authFailureReply(r);
  assert.equal(reply.status, 403);
  assert.equal(reply.body.code, 'pm_account_disabled');
  assert.match(reply.body.error, /disabled/);
});

test('auth: 429 → throws rate_limited → 503 "busy" honoring Retry-After', async () => {
  const h = harness(() => json({ error: 'rate limited' }, 429, { 'retry-after': '60' }));
  const e = await getPmUserToken('x', 'y', h.client).then(unexpected, asErr);
  assert.equal(e.kind, 'rate_limited');
  const reply = pmErrorReply(e);
  assert.equal(reply.status, 503);
  assert.equal(reply.body.error, 'Pinball Map is busy, try again in a minute');
  assert.equal(reply.retryAfterSec, 60);
  assert.ok(!reply.clearCredential);
});

test('auth: 429 with a long Retry-After says how many minutes', async () => {
  const h = harness(() => json({}, 429, { 'retry-after': '300' }));
  const reply = pmErrorReply(await getPmUserToken('x', 'y', h.client).then(unexpected, asErr));
  assert.equal(reply.body.error, 'Pinball Map is busy, try again in 5 minutes');
  assert.equal(reply.retryAfterSec, 300);
});

test('auth: 401 about OUR api_token → throws → 503 "problem on our side", flagged to log loudly, not "invalid credentials"', async () => {
  const h = harness(() => json({ error: API_TOKEN_REQUIRED_MSG }, 401));
  const e = await getPmUserToken('x', 'y', h.client).then(unexpected, asErr);
  assert.equal(e.kind, 'unauthorized');
  const reply = pmErrorReply(e);
  assert.equal(reply.status, 503);
  assert.match(reply.body.error, /Pinball Map connection problem on our side/);
  assert.equal(reply.ourTokenRejected, true);
});

// ── machine_score_xrefs#create ──────────────────────────────────────────────────────────────────

const AUTH = { email: 'Will@Example.com', token: 'tok-123' };
const SUCCESS = { machine_score_xref: { id: 987, location_machine_xref_id: 55, machine_id: 3, score: 12345670, user_id: 9, username: 'helmhead' } };

test('submit: sends user_email + user_token + xref id and the score as a STRING, in the JSON body', async () => {
  const h = harness(() => json(SUCCESS, 201));
  await submitPmScore(AUTH, 55, 12345670, h.client);
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(url.pathname, '/api/v1/machine_score_xrefs.json');
  assert.equal(url.searchParams.get('api_token'), 'OUR-API-TOKEN');
  assert.equal(url.searchParams.get('user_token'), null, 'user credentials never on the URL');
  assert.equal(url.searchParams.get('user_email'), null);
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body, { user_email: 'Will@Example.com', user_token: 'tok-123', location_machine_xref_id: 55, score: '12345670' });
  assert.equal(typeof body.score, 'string');
});

test('submit: 201 {"machine_score_xref":...} → success with PM username', async () => {
  const h = harness(() => json(SUCCESS, 201));
  assert.deepEqual(await submitPmScore(AUTH, 55, 12345670, h.client), { ok: true, username: 'helmhead', scoreId: 987 });
});

test('submit: a 200 with no machine_score_xref is NOT success', async () => {
  const h = harness(() => json({ ok: true }, 200));
  const e = await submitPmScore(AUTH, 55, 1, h.client).then(unexpected, asErr);
  assert.equal(e.kind, 'http');
});

test('submit: 201 without the machine_score_xref root is NOT success', async () => {
  const h = harness(() => json({}, 201));
  await submitPmScore(AUTH, 55, 1, h.client).then(unexpected, asErr);
});

test('submit: 200 "Authentication is required…" → auth_required → 401 pm_reconnect_required, credential cleared', async () => {
  const h = harness(() => json({ errors: AUTH_REQUIRED_MSG }));
  const r = await submitPmScore(AUTH, 55, 1, h.client);
  assert.deepEqual(r, { ok: false, reason: 'auth_required', message: AUTH_REQUIRED_MSG });
  if (r.ok) return;
  const reply = submitFailureReply(r);
  assert.equal(reply.status, 401);
  assert.equal(reply.body.code, PM_RECONNECT_REQUIRED);
  assert.equal(reply.clearCredential, true);
});

test('submit: 200 other errors → 422 with PM\'s message, credential kept', async () => {
  const h = harness(() => json({ errors: 'Failed to find machine' }));
  const r = await submitPmScore(AUTH, 55, 1, h.client);
  assert.deepEqual(r, { ok: false, reason: 'rejected', message: 'Failed to find machine' });
  if (r.ok) return;
  const reply = submitFailureReply(r);
  assert.equal(reply.status, 422);
  assert.match(reply.body.error, /Failed to find machine/);
  assert.ok(!reply.clearCredential);
});

test('submit: 200 errors as an array (model validation) → joined into one message', async () => {
  const h = harness(() => json({ errors: ['Score is invalid', 'User is invalid'] }));
  const r = await submitPmScore(AUTH, 55, 1, h.client);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.message, 'Score is invalid; User is invalid');
});

test('submit: 403 account_disabled → 403, credential kept', async () => {
  const h = harness(() => json({ error: 'account_disabled' }, 403));
  const r = await submitPmScore(AUTH, 55, 1, h.client);
  assert.equal(r.ok, false);
  if (r.ok) return;
  const reply = submitFailureReply(r);
  assert.equal(reply.status, 403);
  assert.ok(!reply.clearCredential);
});

test('submit: 429 / 5xx / our api_token → throw → 503/502/503, credential never cleared', async () => {
  const r429 = pmErrorReply(await submitPmScore(AUTH, 55, 1, harness(() => json({}, 429, { 'retry-after': '30' })).client).then(unexpected, asErr));
  assert.equal(r429.status, 503);
  assert.equal(r429.retryAfterSec, 30);
  assert.ok(!r429.clearCredential);

  const r500 = pmErrorReply(await submitPmScore(AUTH, 55, 1, harness(() => json({}, 500)).client).then(unexpected, asErr));
  assert.equal(r500.status, 502);
  assert.ok(!r500.clearCredential);

  const rTok = pmErrorReply(await submitPmScore(AUTH, 55, 1, harness(() => json({ error: API_TOKEN_REQUIRED_MSG }, 401)).client).then(unexpected, asErr));
  assert.equal(rTok.status, 503);
  assert.equal(rTok.ourTokenRejected, true);
  assert.ok(!rTok.clearCredential);
});

test('pmErrorReply: breaker open (unavailable) → 503 with its message and Retry-After', () => {
  const reply = pmErrorReply(new PmApiError('unavailable', 'Pinball Map is unavailable — try again in 2 minutes', undefined, 120_000));
  assert.equal(reply.status, 503);
  assert.equal(reply.retryAfterSec, 120);
});

// ── stored credential ───────────────────────────────────────────────────────────────────────────

test('storedPmAuth: token + email → usable; token without email (pre-migrate18) → pm_reconnect_required; none → connect', () => {
  assert.deepEqual(storedPmAuth({ pinballMapToken: 't', pinballMapEmail: 'e@x' }), { ok: true, auth: { email: 'e@x', token: 't' } });
  const legacy = storedPmAuth({ pinballMapToken: 't', pinballMapEmail: null });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) {
    assert.equal(legacy.reply.status, 401);
    assert.equal(legacy.reply.body.code, PM_RECONNECT_REQUIRED);
  }
  const none = storedPmAuth({ pinballMapToken: null, pinballMapEmail: null });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.reply.body.code, PM_RECONNECT_REQUIRED);

  assert.equal(hasUsablePmConnection({ pinballMapToken: 't', pinballMapEmail: 'e' }), true);
  assert.equal(hasUsablePmConnection({ pinballMapToken: 't', pinballMapEmail: null }), false);
});
