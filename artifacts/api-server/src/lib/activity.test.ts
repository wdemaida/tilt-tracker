// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/activity.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizePayload, buildActivityRow, categoryOf, logActivity, insertActivity, clientIp, fromReq, ACTIVITY_TYPES,
} from './activity.js';
import { eventForFinishedRequest, PM_RULES, VENUE_RULES, MACHINE_RULES } from './activityRoutes.js';

// A stand-in for a drizzle executor: records inserted rows, or throws.
function fakeExecutor(opts: { fail?: boolean; duplicate?: boolean } = {}) {
  const inserted: any[] = [];
  let conflictTarget: unknown;
  let savepoints = 0;
  const ex: any = {
    insert: () => ({
      values: (row: any) => ({
        onConflictDoNothing: (o: any) => {
          conflictTarget = o?.target;
          return {
            returning: async () => {
              if (opts.fail) throw new Error('db down');
              if (opts.duplicate) return [];
              inserted.push(row);
              return [{ id: inserted.length }];
            },
          };
        },
      }),
    }),
    transaction: async (fn: (sp: any) => Promise<unknown>) => { savepoints++; return fn(ex); },
  };
  return { ex, inserted, get conflictTarget() { return conflictTarget; }, get savepoints() { return savepoints; } };
}

test('sanitizePayload drops secret-looking keys at any depth', () => {
  const out = sanitizePayload({
    userId: 3, token: 'x', pinballMapToken: 'y', password: 'p', email: 'a@b.c', photoKey: 'scores/1/a.jpg',
    key: 'k', apiKey: 'z', nested: { userToken: 't', ok: 'fine', deeper: { secret: 's', n: 1 } },
    list: [{ authorization: 'Bearer q', name: 'n' }],
  }) as any;
  assert.deepEqual(out, { userId: 3, nested: { ok: 'fine', deeper: { n: 1 } }, list: [{ name: 'n' }] });
});

test('sanitizePayload caps strings, arrays, depth; converts dates and bigints', () => {
  const long = 'x'.repeat(2000);
  const out = sanitizePayload({ s: long, arr: Array.from({ length: 80 }, (_, i) => i), d: new Date('2026-01-02T03:04:05Z'), b: 10n, a: { b: { c: { d: { e: 1 } } } } }) as any;
  assert.equal(out.s.length, 501);
  assert.equal(out.arr.length, 50);
  assert.equal(out.d, '2026-01-02T03:04:05.000Z');
  assert.equal(out.b, '10');
  assert.equal(out.a.b.c.d, '[truncated]');
});

test('buildActivityRow normalizes ids, caps ip/ua and oversized payloads', () => {
  const row = buildActivityRow({ type: 'score.created', actorUserId: 5, targetType: 'score', targetId: 42, userAgent: 'u'.repeat(400), ip: '1.2.3.4' });
  assert.equal(row.targetId, '42');
  assert.equal(row.userAgent!.length, 300);
  assert.equal(row.subjectUserId, null);
  assert.equal(row.svixId, null);
  assert.deepEqual(row.payload, {});
  const big = buildActivityRow({ type: 'score.created', payload: { list: Array.from({ length: 50 }, () => 'y'.repeat(400)) } });
  assert.deepEqual(big.payload, { truncated: true });
});

test('categoryOf maps every catalogued type, and unknown types to other', () => {
  for (const [cat, types] of Object.entries(ACTIVITY_TYPES)) for (const t of types) assert.equal(categoryOf(t), cat);
  assert.equal(categoryOf('something.else'), 'other');
  const all = Object.values(ACTIVITY_TYPES).flat();
  assert.equal(new Set(all).size, all.length, 'no type listed twice');
});

test('logActivity never throws, even when the insert fails', async () => {
  const f = fakeExecutor({ fail: true });
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    await assert.doesNotReject(logActivity({ type: 'score.created' }, { tx: f.ex }));
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
});

test('logActivity inside a transaction uses a savepoint', async () => {
  const f = fakeExecutor();
  await logActivity({ type: 'notification.sent', subjectUserId: 2, payload: { kind: 'friend_request', token: 'nope' } }, { tx: f.ex });
  assert.equal(f.savepoints, 1);
  assert.equal(f.inserted.length, 1);
  assert.equal(f.inserted[0].type, 'notification.sent');
  assert.deepEqual(f.inserted[0].payload, { kind: 'friend_request' });
});

test('insertActivity de-dupes on svix_id and reports duplicates as null', async () => {
  const f = fakeExecutor({ duplicate: true });
  assert.equal(await insertActivity({ type: 'user.signed_in', svixId: 'msg_1' }, f.ex), null);
  assert.ok(f.conflictTarget, 'uses ON CONFLICT on svix_id');
  const g = fakeExecutor();
  assert.equal(await insertActivity({ type: 'user.signed_in', svixId: 'msg_2' }, g.ex), 1);
  await assert.rejects(insertActivity({ type: 'user.signed_in' }, fakeExecutor({ fail: true }).ex), /db down/);
});

test('clientIp takes the last X-Forwarded-For hop; fromReq reads appUser', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' } }), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, ip: '::1' }), '::1');
  assert.deepEqual(fromReq({ appUser: { id: 7 }, headers: { 'user-agent': 'UA' }, ip: '5.5.5.5' }), { actorUserId: 7, ip: '5.5.5.5', userAgent: 'UA' });
  assert.deepEqual(fromReq({ headers: {} }), { actorUserId: null, ip: null, userAgent: null });
});

test('route rules: PM connect / post success / post failure; auth refusals are not activity', () => {
  let ev = eventForFinishedRequest(PM_RULES, 'POST', '/auth', 200, { email: 'a@b.c', password: 'pw' });
  assert.equal(ev?.type, 'pm.connected');
  assert.deepEqual(ev?.payload, { status: 200 }, 'credentials never copied');
  ev = eventForFinishedRequest(PM_RULES, 'POST', '/submit-score', 200, { venueId: 3, machineName: 'Godzilla', score: 1000, userToken: 'secret' });
  assert.equal(ev?.type, 'pm.score_posted');
  assert.deepEqual(ev?.payload, { status: 200, venueId: 3, machineName: 'Godzilla', score: 1000 });
  assert.equal(eventForFinishedRequest(PM_RULES, 'POST', '/submit-score', 502, {})?.type, 'pm.score_post_failed');
  assert.equal(eventForFinishedRequest(PM_RULES, 'POST', '/submit-score', 401, {}), null);
  assert.equal(eventForFinishedRequest(PM_RULES, 'POST', '/auth', 401, {}), null, 'failed connect has no failure type');
  assert.equal(eventForFinishedRequest(PM_RULES, 'GET', '/token', 200, {}), null);
});

test('route rules: venue repair targets and admin deletes', () => {
  const merge = eventForFinishedRequest(VENUE_RULES, 'POST', '/12/repair/merge', 200, { intoVenueId: 9, expectedScoreCount: 4 });
  assert.equal(merge?.type, 'venue.merged');
  assert.equal(merge?.targetId, '12');
  assert.deepEqual(merge?.payload, { status: 200, intoVenueId: 9, expectedScoreCount: 4 });
  assert.equal(eventForFinishedRequest(VENUE_RULES, 'POST', '/12/repair/here/attach', 200, {})?.type, 'venue.repair_here_attach');
  assert.equal(eventForFinishedRequest(VENUE_RULES, 'POST', '/12/repair/here', 200, {})?.type, 'venue.repair_here');
  const resync = eventForFinishedRequest(VENUE_RULES, 'POST', '/12/repair/resync-apply', 200, { merges: [{}, {}] });
  assert.deepEqual(resync?.payload, { status: 200, mergesCount: 2 });
  assert.equal(eventForFinishedRequest(VENUE_RULES, 'DELETE', '/12', 204, {})?.type, 'admin.venue_deleted');
  assert.equal(eventForFinishedRequest(VENUE_RULES, 'POST', '/12/repair/merge-preview', 200, {}), null);
  assert.equal(eventForFinishedRequest(MACHINE_RULES, 'DELETE', '/5', 204, {})?.type, 'admin.machine_deleted');
});
