// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/announcements.db.test.ts   (from artifacts/api-server)
//
// Admin announcements end to end against a real Postgres: an in-process PGlite (Postgres compiled
// to WASM — nothing is dialled; the dummy DATABASE_URL only satisfies @workspace/db's import-time
// check). @workspace/db's `db` is a postgres-js drizzle instance that never connects here, so its
// query entry points are pointed at a drizzle-on-PGlite instance with the same schema; the lib
// functions and the real router (mounted on a throwaway express app on an ephemeral port, as in
// adminAuth.test.ts) then run unchanged: the advisory lock, recipient resolution, confirmCount,
// duplicate detection, raiseNotificationsBulk + notification.sent events, admin.announcement_sent,
// history with live counts, and retract.
//
// PGlite caveat: it is one connection, so transactions are serialised by PGlite itself —
// pg_advisory_xact_lock and hashtext run (and must parse/execute, which is what's checked), but the
// lock is never contended here. Neon Postgres has both functions and does serialise on the lock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { PGlite } = await import('@electric-sql/pglite');
const { drizzle } = await import('drizzle-orm/pglite');
const dbModule = await import('@workspace/db');
const { default: express } = await import('express');
const { setActivityGateForTests } = await import('./activity.js');
const {
  sendAnnouncement, listAnnouncements, retractAnnouncement, resolveRecipients, DUPLICATE_WINDOW_MS,
} = await import('./announcements.js');
const { default: announcementsRouter } = await import('../routes/adminAnnouncements.js');

const pg = new PGlite();
await pg.exec(`
  CREATE TYPE user_role AS ENUM ('admin', 'user');
  CREATE TABLE users (
    id serial PRIMARY KEY, clerk_id text UNIQUE NOT NULL, username text UNIQUE NOT NULL, display_name text NOT NULL,
    role user_role NOT NULL DEFAULT 'user', pinball_map_token text, pinball_map_username text, pinball_map_email text,
    disabled_at timestamptz, disabled_reason text, disabled_by_id integer,
    challenge_venues_seeded_at timestamptz, challenge_venues_edited_at timestamptz,
    image_url text, image_synced_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE notifications (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
  );
  CREATE TABLE activity_events (
    id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),
    actor_user_id integer REFERENCES users(id) ON DELETE SET NULL, type text NOT NULL,
    subject_user_id integer REFERENCES users(id) ON DELETE SET NULL, target_type text, target_id text,
    payload jsonb NOT NULL DEFAULT '{}', ip text, user_agent text, svix_id text UNIQUE
  );
  INSERT INTO users (clerk_id, username, display_name, role, disabled_at) VALUES
    ('c1', 'boss',   'Boss',   'admin', NULL),
    ('c2', 'second', 'Second', 'admin', NULL),
    ('c3', 'alice',  'Alice',  'user',  NULL),
    ('c4', 'bob',    'Bob',    'user',  NULL),
    ('c5', 'cara x', 'Cara',   'user',  NULL),
    ('c6', 'dave',   'Dave',   'user',  now());
`);
const ACTIVE = 5; // dave (6) is disabled

// Point @workspace/db's `db` at PGlite. The lib modules hold the same object, so this reaches them.
const pgdb = drizzle(pg, { schema: dbModule });
const realDb = dbModule.db as any;
for (const m of ['select', 'insert', 'update', 'delete', 'execute', 'transaction'] as const) {
  realDb[m] = (pgdb as any)[m].bind(pgdb);
}
setActivityGateForTests(() => true);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).appUser = { id: Number(req.headers['x-admin-id'] ?? 1), role: 'admin' }; next(); });
app.use('/api/admin', announcementsRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
after(() => { server.close(); setActivityGateForTests(null); });

async function call(method: string, path: string, body?: unknown, adminId = 1) {
  const res = await fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-id': String(adminId) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}
async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(text, params)).rows;
}
const notifsOf = (aid: string) =>
  q<{ user_id: number; payload: any; read_at: Date | null }>(
    `SELECT user_id, payload, read_at FROM notifications WHERE kind = 'announcement' AND payload->>'announcementId' = $1 ORDER BY user_id`, [aid]);
const eventsOf = (type: string, aid: string) =>
  q<{ actor_user_id: number | null; subject_user_id: number | null; target_id: string; payload: any; created_at: Date }>(
    `SELECT actor_user_id, subject_user_id, target_id, payload, created_at FROM activity_events
     WHERE type = $1 AND (target_id = $2 OR payload->>'announcementId' = $2) ORDER BY id`, [type, aid]);
const countAll = async () => ({
  notifications: Number((await q<{ n: string }>(`SELECT count(*) n FROM notifications`))[0].n),
  events: Number((await q<{ n: string }>(`SELECT count(*) n FROM activity_events`))[0].n),
});

let allId = '';
let pickedId = '';

test('hashtext + pg_advisory_xact_lock run in PGlite', async () => {
  await pg.transaction(async tx => {
    const r = await tx.query<{ h: number }>(`SELECT hashtext('admin_announcement') AS h`);
    assert.equal(typeof r.rows[0].h, 'number');
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('admin_announcement'), 1::int)`);
  });
});

test('preview: everyone active, the disabled user excluded, no writes', async () => {
  const before = await countAll();
  const r = await call('POST', '/announcements/preview', { title: 'Hello', body: 'World', audience: 'all' });
  assert.equal(r.status, 200);
  assert.equal(r.body.recipientCount, ACTIVE);
  assert.ok(!r.body.sample.some((u: any) => u.username === 'dave'));
  assert.deepEqual(r.body.skipped, []);
  assert.equal(r.body.duplicateOf, null);
  assert.deepEqual(await countAll(), before);
});

test('send to all: confirmCount mismatch → 409 recipient_count_changed, nothing written', async () => {
  const before = await countAll();
  const r = await call('POST', '/announcements', {
    title: 'New machines', body: 'Come play.', link: '/users/{username}', audience: 'all', confirmCount: ACTIVE + 1, requestId: 'req-all-0001',
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'recipient_count_changed');
  assert.equal(r.body.recipientCount, ACTIVE);
  assert.deepEqual(await countAll(), before);
});

test('send to all: disabled user skipped, one notification + notification.sent each, admin.announcement_sent logged', async () => {
  const r = await call('POST', '/announcements', {
    title: 'New machines', body: 'Come play.', link: '/users/{username}', audience: 'all', confirmCount: ACTIVE, requestId: 'req-all-0001',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sent, ACTIVE);
  assert.deepEqual(r.body.skipped, []);
  allId = r.body.announcementId;

  const rows = await notifsOf(allId);
  assert.deepEqual(rows.map(n => n.user_id), [1, 2, 3, 4, 5], 'dave (6, disabled) gets nothing');
  for (const n of rows) {
    assert.equal(n.payload.title, 'New machines');
    assert.equal(n.payload.body, 'Come play.');
    assert.equal(n.payload.from, 'TiltTrack');
    assert.equal(n.read_at, null);
  }
  // {username} substituted per recipient (and URL-encoded).
  assert.deepEqual(rows.map(n => n.payload.link), ['/users/boss', '/users/second', '/users/alice', '/users/bob', '/users/cara%20x']);

  const sentEvents = await eventsOf('notification.sent', allId);
  assert.deepEqual(sentEvents.map(e => e.subject_user_id).sort(), [1, 2, 3, 4, 5]);
  assert.ok(sentEvents.every(e => e.payload.kind === 'announcement'));

  const [ev, ...more] = await eventsOf('admin.announcement_sent', allId);
  assert.equal(more.length, 0);
  assert.equal(ev.actor_user_id, 1);
  assert.equal(ev.target_id, allId);
  assert.equal(ev.payload.audience, 'all');
  assert.equal(ev.payload.audienceKey, 'all');
  assert.equal(ev.payload.recipientCount, ACTIVE);
  assert.equal(ev.payload.requestId, 'req-all-0001');
  assert.equal(ev.payload.link, '/users/{username}', 'the event keeps the template');
  assert.deepEqual(ev.payload.userIds, [1, 2, 3, 4, 5]);
});

test('duplicate requestId → 409 duplicate_send (reason request), even with allowDuplicate and different text', async () => {
  const before = await countAll();
  const r = await call('POST', '/announcements', {
    title: 'Something else', body: 'Entirely.', audience: 'all', confirmCount: ACTIVE, requestId: 'req-all-0001', allowDuplicate: true,
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'duplicate_send');
  assert.equal(r.body.duplicateOf.reason, 'request');
  assert.equal(r.body.duplicateOf.announcementId, allId);
  assert.deepEqual(await countAll(), before);
});

test('same title + body + audience within 10 min → 409 (reason recent); preview flags it; allowDuplicate sends', async () => {
  const preview = await call('POST', '/announcements/preview', { title: 'New machines', body: 'Come play.', audience: 'all' });
  assert.equal(preview.body.duplicateOf?.announcementId, allId);
  assert.equal(preview.body.duplicateOf?.reason, 'recent');

  const before = await countAll();
  const dup = await call('POST', '/announcements', {
    title: 'New machines', body: 'Come play.', audience: 'all', confirmCount: ACTIVE, requestId: 'req-all-0002',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.duplicateOf.reason, 'recent');
  assert.equal(dup.body.duplicateOf.announcementId, allId);
  assert.deepEqual(await countAll(), before);

  // Another admin's send is a duplicate too (the check is on content + audience, not the sender).
  const other = await call('POST', '/announcements', {
    title: 'New machines', body: 'Come play.', audience: 'all', confirmCount: ACTIVE, requestId: 'req-all-0003',
  }, 2);
  assert.equal(other.status, 409);

  const forced = await call('POST', '/announcements', {
    title: 'New machines', body: 'Come play.', audience: 'all', confirmCount: ACTIVE, requestId: 'req-all-0004', allowDuplicate: true,
  });
  assert.equal(forced.status, 201, JSON.stringify(forced.body));
  assert.notEqual(forced.body.announcementId, allId);
  assert.equal((await notifsOf(forced.body.announcementId)).length, ACTIVE);
  // The earlier announcement's rows are untouched (dedupe is per announcementId).
  assert.equal((await notifsOf(allId)).length, ACTIVE);
  // Clean up the forced one so later counts stay simple.
  await retractAnnouncement(forced.body.announcementId, { actorUserId: 1 });
});

test('a send older than the window is not a content duplicate', async () => {
  // Age every matching sent event past the window.
  await q(`UPDATE activity_events SET created_at = now() - make_interval(secs => $1)
           WHERE type = 'admin.announcement_sent' AND payload->>'title' = 'New machines'`, [DUPLICATE_WINDOW_MS / 1000 + 60]);
  const preview = await call('POST', '/announcements/preview', { title: 'New machines', body: 'Come play.', audience: 'all' });
  assert.equal(preview.body.duplicateOf, null);
});

test('send to picked users: unknown and disabled ids reported as skipped, only the active ones receive', async () => {
  const preview = await call('POST', '/announcements/preview', { title: 'Picked', body: 'Just you.', audience: 'users', userIds: [4, 999, 6, 3, 4] });
  assert.equal(preview.body.recipientCount, 2);
  assert.deepEqual(preview.body.skipped, [
    { id: 999, username: null, reason: 'unknown' },
    { id: 6, username: 'dave', reason: 'disabled' },
  ]);

  const r = await call('POST', '/announcements', {
    title: 'Picked', body: 'Just you.', link: '/users/{username}?tab=scores', audience: 'users', userIds: [4, 999, 6, 3],
    confirmCount: 2, requestId: 'req-picked-0001',
  }, 2);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sent, 2);
  assert.deepEqual(r.body.skipped.map((s: any) => [s.id, s.reason]), [[999, 'unknown'], [6, 'disabled']]);
  pickedId = r.body.announcementId;

  const rows = await notifsOf(pickedId);
  assert.deepEqual(rows.map(n => [n.user_id, n.payload.link]), [[3, '/users/alice?tab=scores'], [4, '/users/bob?tab=scores']]);
  const [ev] = await eventsOf('admin.announcement_sent', pickedId);
  assert.equal(ev.actor_user_id, 2);
  assert.equal(ev.payload.audience, 'users');
  assert.match(ev.payload.audienceKey, /^users:[0-9a-f]{16}$/);
  assert.equal(ev.payload.skippedCount, 2);
  assert.deepEqual(ev.payload.userIds, [4, 3], 'recipients in picked order');

  // The audience key is the picked ids (skipped ones included), order-insensitive: the same set
  // reordered is a content duplicate; just the recipients is a different audience.
  const dup = await call('POST', '/announcements/preview', { title: 'Picked', body: 'Just you.', audience: 'users', userIds: [3, 6, 999, 4] });
  assert.equal(dup.body.duplicateOf?.announcementId, pickedId);
  const other = await call('POST', '/announcements/preview', { title: 'Picked', body: 'Just you.', audience: 'users', userIds: [3, 4] });
  assert.equal(other.body.duplicateOf, null);
});

test('every picked user disabled/unknown → 400 no_recipients', async () => {
  const r = await call('POST', '/announcements', {
    title: 'Nobody', body: 'Here.', audience: 'users', userIds: [6, 998], confirmCount: 1, requestId: 'req-none-0001',
  }, 2);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'no_recipients');
});

test('lib: resolveRecipients against the DB matches the route (all → active only)', async () => {
  const all = await resolveRecipients({ audience: 'all' });
  assert.deepEqual(all.recipients.map(u => u.id), [1, 2, 3, 4, 5]);
});

test('lib: a direct sendAnnouncement with the same requestId as a concurrent one sends once', async () => {
  const input = {
    text: { title: 'Race', body: 'Double click.', link: null }, audience: { audience: 'users' as const, userIds: [5] },
    confirmCount: 1, requestId: 'req-race-0001', allowDuplicate: false,
  };
  const [a, b] = await Promise.all([sendAnnouncement(1, input, { actorUserId: 1 }), sendAnnouncement(1, input, { actorUserId: 1 })]);
  const oks = [a, b].filter(r => r.ok);
  assert.equal(oks.length, 1);
  const refused = [a, b].find(r => !r.ok) as any;
  assert.equal(refused.status, 409);
  assert.equal(refused.body.duplicateOf.reason, 'request');
  const raceId = (oks[0] as any).announcementId;
  assert.equal((await notifsOf(raceId)).length, 1);
  await retractAnnouncement(raceId, { actorUserId: 1 });
});

test('history: newest first, live delivered/unread after a recipient reads one', async () => {
  await q(`UPDATE notifications SET read_at = now() WHERE user_id = 3 AND payload->>'announcementId' = $1`, [pickedId]);
  const r = await call('GET', '/announcements');
  assert.equal(r.status, 200);
  const ids = r.body.items.map((i: any) => i.id);
  assert.deepEqual(ids, [...ids].sort((x: number, y: number) => y - x), 'newest first');
  assert.equal(r.body.items.length, 4, 'all, forced, picked, race');

  const picked = r.body.items.find((i: any) => i.announcementId === pickedId);
  assert.equal(picked.delivered, 2);
  assert.equal(picked.unread, 1);
  assert.equal(picked.recipientCount, 2);
  assert.equal(picked.audience, 'users');
  assert.deepEqual(picked.sentBy, { id: 2, username: 'second', displayName: 'Second' });
  assert.equal(picked.link, '/users/{username}?tab=scores');
  assert.equal(picked.retractedAt, null);

  const all = r.body.items.find((i: any) => i.announcementId === allId);
  assert.equal(all.delivered, ACTIVE);
  assert.equal(all.unread, ACTIVE);
  assert.ok(r.body.items.findIndex((i: any) => i.announcementId === pickedId) < r.body.items.findIndex((i: any) => i.announcementId === allId));

  // Retracted ones show what was removed.
  const raced = r.body.items.find((i: any) => i.title === 'Race');
  assert.equal(raced.delivered, 0);
  assert.equal(raced.retracted, 1);
  assert.ok(raced.retractedAt);

  // Keyset paging.
  const p1 = await listAnnouncements(null, 2);
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextBefore);
  const p2 = await listAnnouncements(p1.nextBefore, 2);
  assert.deepEqual([...p1.items, ...p2.items].map(i => i.id), ids);
  assert.equal(p2.nextBefore, null);
});

test('retract: removes the remaining rows (read and unread) and logs admin.announcement_retracted', async () => {
  const r = await call('DELETE', `/announcements/${pickedId.toUpperCase()}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { announcementId: pickedId, removed: 2 });
  assert.equal((await notifsOf(pickedId)).length, 0);
  assert.equal((await notifsOf(allId)).length, ACTIVE, 'other announcements untouched');

  const [ev] = await eventsOf('admin.announcement_retracted', pickedId);
  assert.equal(ev.actor_user_id, 1);
  assert.equal(ev.payload.removed, 2);
  assert.equal(ev.payload.title, 'Picked');

  const again = await call('DELETE', `/announcements/${pickedId}`);
  assert.deepEqual(again.body, { announcementId: pickedId, removed: 0 });

  const h = await listAnnouncements(null, 20);
  const item = h.items.find(i => i.announcementId === pickedId)!;
  assert.equal(item.delivered, 0);
  assert.equal(item.unread, 0);
  assert.ok(item.retractedAt);
  assert.equal(typeof item.retracted, 'number');

  assert.equal((await call('DELETE', '/announcements/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await call('DELETE', '/announcements/not-a-uuid')).status, 404);
});

test('the admin tier set to "don\'t record" does not drop the announcement record (dedupe, history, retract depend on it)', async () => {
  setActivityGateForTests(type => !type.startsWith('admin.'));
  try {
    const r = await sendAnnouncement(1, {
      text: { title: 'Gate', body: 'Off.', link: null }, audience: { audience: 'users', userIds: [3] },
      confirmCount: 1, requestId: 'req-gate-0001', allowDuplicate: false,
    }, { actorUserId: 1 });
    assert.ok(r.ok);
    const aid = (r as any).announcementId;
    assert.equal((await eventsOf('admin.announcement_sent', aid)).length, 1, 'the sent event is written anyway');
    const again = await sendAnnouncement(1, {
      text: { title: 'Gate', body: 'Off.', link: null }, audience: { audience: 'users', userIds: [3] },
      confirmCount: 1, requestId: 'req-gate-0001', allowDuplicate: false,
    }, { actorUserId: 1 });
    assert.equal(again.ok, false, 'double submit still refused');
    const rt = await retractAnnouncement(aid, { actorUserId: 1 });
    assert.equal(rt.status, 200);
    assert.equal(rt.body.removed, 1);
    assert.equal((await eventsOf('admin.announcement_retracted', aid)).length, 1, 'the retract is recorded too');
    // Other admin events still follow the gate.
    assert.equal((await eventsOf('notification.sent', aid)).length, 1);
  } finally {
    setActivityGateForTests(() => true);
  }
});
