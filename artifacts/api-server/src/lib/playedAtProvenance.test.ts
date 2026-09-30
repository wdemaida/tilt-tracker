// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/playedAtProvenance.test.ts   (from artifacts/api-server)
//
// The played-time token (sign / verify / expiry / user binding / tampering), the instant-vs-camera
// clock match, the POST source decision and the PATCH lock rule. Pure — no DB, no network.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  signPlayedAtToken, verifyPlayedAtToken, setPlayedAtTokenKeyForTests, PLAYED_AT_TOKEN_TTL_MS,
  instantMatchesNaive, wallClockIn, checkPlayedAtToken, decidePlayedAtSource, playedAtEditDecision, playedAtChanged,
  isLockedSource,
} from './playedAtProvenance.js';

beforeEach(() => setPlayedAtTokenKeyForTests('test-key'));
after(() => setPlayedAtTokenKeyForTests(undefined));

const NOW = Date.UTC(2026, 8, 30, 12, 0);
const NAIVE = '2026-05-02T23:30:17';

test('a token round-trips for its own user', () => {
  const t = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
  assert.ok(t);
  assert.deepEqual(verifyPlayedAtToken(t, 'user_a', NOW + 1000), { ok: true, naive: NAIVE, kind: 'photo' });
  const v = signPlayedAtToken('user_a', NAIVE, 'video', NOW)!;
  assert.deepEqual(verifyPlayedAtToken(v, 'user_a', NOW), { ok: true, naive: NAIVE, kind: 'video' });
});

test('a token is bound to the user it was issued to', () => {
  const t = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
  assert.deepEqual(verifyPlayedAtToken(t, 'user_b', NOW), { ok: false, reason: 'wrong_user' });
});

test('a token expires after 24 h', () => {
  const t = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
  assert.equal(verifyPlayedAtToken(t, 'user_a', NOW + PLAYED_AT_TOKEN_TTL_MS).ok, true);
  assert.deepEqual(verifyPlayedAtToken(t, 'user_a', NOW + PLAYED_AT_TOKEN_TTL_MS + 1), { ok: false, reason: 'expired' });
});

test('an edited payload, a different key or junk fails', () => {
  const t = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
  const [body, mac] = t.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...p, t: '2026-09-30T20:00:00' })).toString('base64url');
  assert.deepEqual(verifyPlayedAtToken(`${forged}.${mac}`, 'user_a', NOW), { ok: false, reason: 'bad_signature' });
  const longer = Buffer.from(JSON.stringify({ ...p, e: p.e + 10 * PLAYED_AT_TOKEN_TTL_MS })).toString('base64url');
  assert.deepEqual(verifyPlayedAtToken(`${longer}.${mac}`, 'user_a', NOW), { ok: false, reason: 'bad_signature' });
  setPlayedAtTokenKeyForTests('other-key');
  assert.deepEqual(verifyPlayedAtToken(t, 'user_a', NOW), { ok: false, reason: 'bad_signature' });
  for (const junk of ['', 'abc', 'a.b.c', `${body}.`, 42, null]) {
    assert.equal(verifyPlayedAtToken(junk, 'user_a', NOW).ok, false, String(junk));
  }
});

test('no key: nothing is signed and nothing verifies', () => {
  setPlayedAtTokenKeyForTests(null);
  assert.equal(signPlayedAtToken('user_a', NAIVE), null);
  assert.deepEqual(verifyPlayedAtToken('x.y', 'user_a'), { ok: false, reason: 'no_key' });
});

test('only a naive wall clock is signed', () => {
  assert.equal(signPlayedAtToken('user_a', '2026-05-02T23:30:00Z'), null);
  assert.equal(signPlayedAtToken('user_a', 'yesterday'), null);
  assert.equal(signPlayedAtToken('', NAIVE), null);
});

test('the key falls back to one derived from CLERK_SECRET_KEY', () => {
  setPlayedAtTokenKeyForTests(undefined);
  const saved = { own: process.env.PLAYED_AT_TOKEN_SECRET, clerk: process.env.CLERK_SECRET_KEY };
  try {
    delete process.env.PLAYED_AT_TOKEN_SECRET;
    process.env.CLERK_SECRET_KEY = 'sk_test_one';
    const t = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
    assert.equal(verifyPlayedAtToken(t, 'user_a', NOW).ok, true);
    process.env.CLERK_SECRET_KEY = 'sk_test_two';
    assert.equal(verifyPlayedAtToken(t, 'user_a', NOW).ok, false);
    process.env.PLAYED_AT_TOKEN_SECRET = 'own';
    const own = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
    process.env.CLERK_SECRET_KEY = 'sk_test_three';
    assert.equal(verifyPlayedAtToken(own, 'user_a', NOW).ok, true);
  } finally {
    if (saved.own === undefined) delete process.env.PLAYED_AT_TOKEN_SECRET; else process.env.PLAYED_AT_TOKEN_SECRET = saved.own;
    if (saved.clerk === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = saved.clerk;
  }
});

test('instant ↔ camera clock, with the venue zone', () => {
  // 11:30pm Eastern (EDT, −4) on May 2 is 03:30Z on May 3 — what localInputToIso sends.
  assert.equal(wallClockIn(new Date('2026-05-03T03:30:00Z'), 'America/New_York'), '2026-05-02T23:30');
  assert.equal(instantMatchesNaive(new Date('2026-05-03T03:30:00Z'), NAIVE, 'America/New_York'), true);
  // Seconds dropped by the input are fine; a minute off, the wrong zone or "today" are not.
  assert.equal(instantMatchesNaive(new Date('2026-05-03T03:31:00Z'), NAIVE, 'America/New_York'), false);
  assert.equal(instantMatchesNaive(new Date('2026-05-03T04:30:00Z'), NAIVE, 'America/New_York'), false);
  assert.equal(instantMatchesNaive(new Date('2026-09-30T23:30:00Z'), NAIVE, 'America/New_York'), false);
  assert.equal(instantMatchesNaive(new Date('2026-05-03T03:30:00Z'), NAIVE, 'Not/AZone'), false);
  assert.equal(instantMatchesNaive(new Date('nope'), NAIVE, 'America/New_York'), false);
});

test('DST: both instants of a fall-back hour, and a spring-forward gap time', () => {
  // Nov 1 2026, 1:30am happens twice in New York (EDT 05:30Z, then EST 06:30Z).
  assert.equal(instantMatchesNaive(new Date('2026-11-01T05:30:00Z'), '2026-11-01T01:30:00', 'America/New_York'), true);
  assert.equal(instantMatchesNaive(new Date('2026-11-01T06:30:00Z'), '2026-11-01T01:30:00', 'America/New_York'), true);
  // Mar 8 2026, 2:30am doesn't exist; the browser lands on 1:30 EST (06:30Z) or 3:30 EDT (07:30Z).
  assert.equal(instantMatchesNaive(new Date('2026-03-08T07:30:00Z'), '2026-03-08T02:30:00', 'America/New_York'), true);
  assert.equal(instantMatchesNaive(new Date('2026-03-08T06:30:00Z'), '2026-03-08T02:30:00', 'America/New_York'), true);
  // An hour off with no transition nearby is still a mismatch.
  assert.equal(instantMatchesNaive(new Date('2026-05-03T02:30:00Z'), NAIVE, 'America/New_York'), false);
});

test('no zone: any real UTC offset, nothing further', () => {
  assert.equal(instantMatchesNaive(new Date('2026-05-03T03:30:00Z'), NAIVE, null), true); // −4
  assert.equal(instantMatchesNaive(new Date('2026-05-02T17:45:00Z'), NAIVE, null), true); // +5:45
  assert.equal(instantMatchesNaive(new Date('2026-05-02T09:30:00Z'), NAIVE, null), true); // +14
  assert.equal(instantMatchesNaive(new Date('2026-05-03T11:30:00Z'), NAIVE, null), true); // −12
  assert.equal(instantMatchesNaive(new Date('2026-05-03T12:30:00Z'), NAIVE, null), false); // −13
  assert.equal(instantMatchesNaive(new Date('2026-05-03T03:37:00Z'), NAIVE, null), false); // not a quarter hour
  assert.equal(instantMatchesNaive(new Date('2026-09-30T23:30:00Z'), NAIVE, null), false); // months later
});

test('POST source decision', () => {
  const tok = signPlayedAtToken('user_a', NAIVE, 'photo', NOW)!;
  const good = checkPlayedAtToken(tok, 'user_a', NOW);
  assert.equal(good.refusal, null);
  assert.deepEqual(decidePlayedAtSource({ verified: good.verified, playedAt: new Date('2026-05-03T03:30:00Z'), tz: 'America/New_York', claimed: undefined }), { ok: true, source: 'photo' });
  // Tampered time with a valid token → 400 played_at_mismatch.
  const moved = decidePlayedAtSource({ verified: good.verified, playedAt: new Date('2026-09-30T23:30:00Z'), tz: 'America/New_York', claimed: 'photo' });
  assert.equal(moved.ok, false);
  assert.equal(!moved.ok && moved.body.code, 'played_at_mismatch');
  // A video token gives 'video'.
  const vid = checkPlayedAtToken(signPlayedAtToken('user_a', NAIVE, 'video', NOW), 'user_a', NOW);
  assert.deepEqual(decidePlayedAtSource({ verified: vid.verified, playedAt: new Date('2026-05-03T03:30:00Z'), tz: 'America/New_York', claimed: undefined }), { ok: true, source: 'video' });
  // Someone else's or a forged token → 400; expired → silently manual.
  assert.equal(checkPlayedAtToken(tok, 'user_b', NOW).refusal?.ok, false);
  assert.equal((checkPlayedAtToken('junk.token', 'user_a', NOW).refusal as any)?.body.code, 'played_at_token_invalid');
  const late = checkPlayedAtToken(tok, 'user_a', NOW + PLAYED_AT_TOKEN_TTL_MS + 1);
  assert.deepEqual(late, { verified: null, refusal: null });
  // No token: 'photo' can't be claimed; 'video' (mvhd, client-read) can; anything else is manual.
  const at = new Date();
  assert.deepEqual(decidePlayedAtSource({ verified: null, playedAt: at, tz: null, claimed: 'photo' }), { ok: true, source: 'manual' });
  assert.deepEqual(decidePlayedAtSource({ verified: null, playedAt: at, tz: null, claimed: 'video' }), { ok: true, source: 'video' });
  assert.deepEqual(decidePlayedAtSource({ verified: null, playedAt: at, tz: null, claimed: undefined }), { ok: true, source: 'manual' });
});

test('PATCH lock rule', () => {
  assert.equal(isLockedSource('photo') && isLockedSource('video') && !isLockedSource('manual') && !isLockedSource(null), true);
  // Unlocked: manual and legacy null, owner or admin, no reason needed.
  for (const s of ['manual', null, undefined]) {
    assert.deepEqual(playedAtEditDecision(s, false, undefined), { allow: true, correction: false, reason: null });
  }
  // Locked, not an admin: 403 whatever the reason says.
  for (const s of ['photo', 'video']) {
    const d = playedAtEditDecision(s, false, 'camera clock was wrong');
    assert.equal(d.allow, false);
    assert.equal(!d.allow && d.status, 403);
    assert.equal(!d.allow && d.body.code, 'played_at_locked');
  }
  // Locked, admin: needs a non-blank reason; it's a correction.
  const blank = playedAtEditDecision('photo', true, '   ');
  assert.equal(!blank.allow && blank.body.code, 'reason_required');
  assert.deepEqual(playedAtEditDecision('photo', true, '  camera was on UTC  '), { allow: true, correction: true, reason: 'camera was on UTC' });
  assert.equal((playedAtEditDecision('video', true, 'x'.repeat(900)) as any).reason.length, 500);
});

test('re-saving the same minute is not a change', () => {
  assert.equal(playedAtChanged(new Date('2026-05-02T23:30:17Z'), new Date('2026-05-02T23:30:00Z')), false);
  assert.equal(playedAtChanged(new Date('2026-05-02T23:30:17Z'), new Date('2026-05-02T23:31:00Z')), true);
});
