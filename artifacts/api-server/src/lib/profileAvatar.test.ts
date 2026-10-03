// Run: npx tsx --test src/lib/profileAvatar.test.ts   (from artifacts/api-server)
//
// The profile-photo sync (profileAvatar.ts). The guarded UPDATE the webhook, the sync route and the
// backfill all use is rendered by drizzle's PgDialect and run against an in-process PGlite (real
// Postgres, WASM) — no server, nothing dialled; the dummy DATABASE_URL only satisfies @workspace/db's
// import-time check. The resync logic runs on injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  avatarUpdateSql, applyAvatar, avatarNeedsResync, resyncAvatar, kickAvatarResyncIfStale, resetAvatarSyncState,
  AVATAR_RESYNC_MS, AVATAR_FAILURE_BACKOFF_MS,
} = await import('./profileAvatar.js');
type Deps = import('./profileAvatar.js').AvatarSyncDeps;
const { PgDialect } = await import('drizzle-orm/pg-core');
const { PGlite } = await import('@electric-sql/pglite');

const pg = new PGlite();
await pg.exec(`
  CREATE TABLE users (id serial PRIMARY KEY, clerk_id text UNIQUE NOT NULL, image_url text, image_synced_at timestamptz);
  INSERT INTO users (clerk_id) VALUES ('user_a'), ('user_b');
`);
const dialect = new PgDialect();
const exec = async (q: ReturnType<typeof avatarUpdateSql>) => {
  const { sql, params } = dialect.sqlToQuery(q);
  return (await pg.query<Record<string, unknown>>(sql, params as unknown[])).rows;
};
const row = async (clerkId: string) =>
  (await pg.query<{ image_url: string | null; image_synced_at: Date | null }>('SELECT image_url, image_synced_at FROM users WHERE clerk_id = $1', [clerkId])).rows[0];

const T = (s: string) => new Date(`2026-10-02T${s}Z`);

test('guarded write: applies to a never-synced row and reports the change', async () => {
  const r = await applyAvatar('user_a', 'https://img.clerk.com/v1', T('12:00:00'), exec);
  assert.deepEqual(r, { applied: true, changed: true });
  const u = await row('user_a');
  assert.equal(u.image_url, 'https://img.clerk.com/v1');
  assert.equal(new Date(u.image_synced_at!).toISOString(), T('12:00:00').toISOString());
});

test('guarded write: an older (out-of-order) delivery is ignored, a newer one applies', async () => {
  assert.deepEqual(await applyAvatar('user_a', 'https://img.clerk.com/stale', T('11:59:59'), exec), { applied: false, changed: false });
  // Same instant is not newer either — a Svix retry of the delivery we already applied.
  assert.deepEqual(await applyAvatar('user_a', 'https://img.clerk.com/v1', T('12:00:00'), exec), { applied: false, changed: false });
  assert.equal((await row('user_a')).image_url, 'https://img.clerk.com/v1');

  assert.deepEqual(await applyAvatar('user_a', 'https://img.clerk.com/v2', T('12:05:00'), exec), { applied: true, changed: true });
  assert.equal((await row('user_a')).image_url, 'https://img.clerk.com/v2');
});

test('guarded write: a newer read with the same photo applies (advances synced_at) but is not a change', async () => {
  assert.deepEqual(await applyAvatar('user_a', 'https://img.clerk.com/v2', T('13:00:00'), exec), { applied: true, changed: false });
  assert.equal(new Date((await row('user_a')).image_synced_at!).toISOString(), T('13:00:00').toISOString());
});

test('guarded write: removing the photo stores null; other users are untouched; unknown users match nothing', async () => {
  assert.deepEqual(await applyAvatar('user_a', null, T('14:00:00'), exec), { applied: true, changed: true });
  assert.equal((await row('user_a')).image_url, null);
  const b = await row('user_b');
  assert.equal(b.image_url, null);
  assert.equal(b.image_synced_at, null);
  assert.deepEqual(await applyAvatar('user_nobody', 'https://img.clerk.com/x', T('14:00:00'), exec), { applied: false, changed: false });
});

test('avatarNeedsResync: null / unparseable / ≥ 24 h old → true', () => {
  const now = T('12:00:00').getTime();
  assert.equal(avatarNeedsResync(null, now), true);
  assert.equal(avatarNeedsResync(undefined, now), true);
  assert.equal(avatarNeedsResync('garbage', now), true);
  assert.equal(avatarNeedsResync(new Date(now - AVATAR_RESYNC_MS), now), true);
  assert.equal(avatarNeedsResync(new Date(now - AVATAR_RESYNC_MS + 1000), now), false);
  assert.equal(avatarNeedsResync(new Date(now - 1000).toISOString(), now), false);
});

function fakeDeps(over: Partial<Deps> = {}) {
  let clock = T('12:00:00').getTime();
  const calls: string[] = [];
  const applied: Array<{ clerkId: string; imageUrl: string | null; at: Date }> = [];
  const deps: Deps = {
    fetch: async clerkId => { calls.push(clerkId); return { ok: true, imageUrl: 'https://img.clerk.com/new' }; },
    apply: async (clerkId, imageUrl, at) => { applied.push({ clerkId, imageUrl, at }); return { applied: true, changed: true }; },
    now: () => clock,
    ...over,
  };
  return { deps, calls, applied, tick: (ms: number) => { clock += ms; } };
}

test('resync: stamps the write with when the read STARTED, and reports the change', async () => {
  resetAvatarSyncState();
  const f = fakeDeps();
  const fetch = f.deps.fetch;
  f.deps.fetch = async id => { f.tick(5000); return fetch(id); }; // Clerk takes 5 s to answer
  const r = await resyncAvatar('user_a', {}, f.deps);
  assert.deepEqual(r, { ok: true, changed: true });
  assert.equal(f.applied[0].at.toISOString(), T('12:00:00').toISOString());
});

test('resync: concurrent calls for one user share one Clerk request', async () => {
  resetAvatarSyncState();
  const f = fakeDeps();
  const [a, b] = await Promise.all([resyncAvatar('user_a', {}, f.deps), resyncAvatar('user_a', { force: true }, f.deps)]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(a, b);
  await resyncAvatar('user_a', {}, f.deps); // finished → a later call asks again
  assert.equal(f.calls.length, 2);
});

test('resync: after a Clerk failure the lazy path backs off 10 minutes; force still asks', async () => {
  resetAvatarSyncState();
  let fail = true;
  const f = fakeDeps({ fetch: async () => (fail ? { ok: false, error: 'down' } : { ok: true, imageUrl: null }) });
  assert.deepEqual(await resyncAvatar('user_a', {}, f.deps), { ok: false, error: 'down' });
  assert.deepEqual(await resyncAvatar('user_a', {}, f.deps), { ok: false, error: 'backoff' });
  assert.equal(f.applied.length, 0);
  fail = false;
  assert.equal((await resyncAvatar('user_a', { force: true }, f.deps)).ok, true);
  // Recovered: the back-off is cleared.
  assert.equal((await resyncAvatar('user_a', {}, f.deps)).ok, true);

  fail = true;
  await resyncAvatar('user_b', {}, f.deps);
  f.tick(AVATAR_FAILURE_BACKOFF_MS);
  fail = false;
  assert.equal((await resyncAvatar('user_b', {}, f.deps)).ok, true);
});

test('resync: a DB failure is caught, logged and reported, never thrown', async () => {
  resetAvatarSyncState();
  const f = fakeDeps({ apply: async () => { throw new Error('db down'); } });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await resyncAvatar('user_a', {}, f.deps), { ok: false, error: 'db down' });
  } finally {
    console.error = orig;
  }
});

test('kickAvatarResyncIfStale: only when never synced or ≥ 24 h old', async () => {
  resetAvatarSyncState();
  const f = fakeDeps();
  const now = f.deps.now();
  assert.equal(kickAvatarResyncIfStale({ clerkId: 'user_a', imageSyncedAt: new Date(now - 60_000) }, f.deps), false);
  assert.equal(kickAvatarResyncIfStale({ clerkId: 'user_a', imageSyncedAt: new Date(now - AVATAR_RESYNC_MS) }, f.deps), true);
  assert.equal(kickAvatarResyncIfStale({ clerkId: 'user_b', imageSyncedAt: null }, f.deps), true);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(f.calls.sort(), ['user_a', 'user_b']);
});
