// End-to-end check of self-service profile editing + profile photos against the Neon DEV branch.
//
// Mounts the REAL users, admin and Clerk-webhook routers on a throwaway express app. requireAppUser is
// the real middleware reading the real users table; only "which Clerk user is this" comes from an
// `x-test-clerk` header (setAuthForTests). Clerk's Backend API is faked (setClerkAdminForTests — the
// throwaway users don't exist in Clerk); webhooks are signed with a throwaway Svix secret.
//
// Creates three throwaway users (clerk ids `zz-profile-test-…`: one admin, one regular, one disabled)
// and deletes exactly those rows and every activity event that mentions them at the end.
//
//   cd artifacts/api-server && npx tsx migrate30.ts && npx tsx test-profile.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as test-admin.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const WEBHOOK_SECRET = `whsec_${Buffer.from('tilttrack-test-profile-secret-01').toString('base64')}`;
process.env.CLERK_WEBHOOK_SIGNING_SECRET = WEBHOOK_SECRET;

const { default: express } = await import('express');
const { Webhook } = await import('svix');
const { setAuthForTests } = await import('./src/middleware/requireAuth.js');
const { setClerkAdminForTests } = await import('./src/lib/clerkAdmin.js');
const { resetAvatarSyncState } = await import('./src/lib/profileAvatar.js');
const { default: usersRouter } = await import('./src/routes/users.js');
const { default: adminRouter } = await import('./src/routes/admin.js');
const { clerkWebhookHandler } = await import('./src/routes/clerkWebhook.js');
const { db, users, activityEvents } = await import('@workspace/db');
const { and, eq, inArray, or, sql } = await import('drizzle-orm');

const TAG = `zz-profile-test-${Date.now().toString(36)}`;
const clerkIds = { admin: `${TAG}-admin`, alice: `${TAG}-alice`, dora: `${TAG}-dora` };

setAuthForTests({ resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null });
// Fake Clerk: what getUser answers per clerk id; `null` = Clerk down.
const clerkPhotos = new Map<string, { hasImage: boolean; imageUrl: string } | null>();
let clerkCalls = 0;
setClerkAdminForTests({
  listUsers: async ids => ids.map(id => ({ id, lastSignInAt: null, lastActiveAt: null, banned: false })),
  ban: async () => {}, unban: async () => {},
  getUser: async id => {
    clerkCalls++;
    const p = clerkPhotos.get(id);
    if (p === null) throw new Error('clerk down (fake)');
    return { id, imageUrl: p?.imageUrl ?? 'https://img.clerk.com/default', hasImage: p?.hasImage ?? false, updatedAt: Date.now() };
  },
});

const app = express();
app.post('/api/webhooks/clerk', express.raw({ type: '*/*' }), clerkWebhookHandler);
app.use(express.json());
app.use('/api/users', usersRouter);
app.use('/api/admin', adminRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(as ? { 'x-test-clerk': as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function webhook(data: Record<string, unknown>) {
  const raw = JSON.stringify({ type: 'user.updated', data });
  const id = `msg_${TAG}_${Math.random().toString(36).slice(2)}`;
  const at = new Date();
  const res = await fetch(`http://localhost:${port}/api/webhooks/clerk`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(Math.floor(+at / 1000)),
      'svix-signature': new Webhook(WEBHOOK_SECRET).sign(id, at, raw),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 600)}`}`);
}
const row = async (clerkId: string) =>
  (await db.select({ displayName: users.displayName, username: users.username, imageUrl: users.imageUrl, imageSyncedAt: users.imageSyncedAt })
    .from(users).where(eq(users.clerkId, clerkId)))[0];

const createdIds: number[] = [];
try {
  const inserted = await db.insert(users).values([
    { clerkId: clerkIds.admin, username: `${TAG}-admin`.replace(/-/g, '_'), displayName: 'Profile Admin', role: 'admin' },
    { clerkId: clerkIds.alice, username: `${TAG}-alice`.replace(/-/g, '_'), displayName: 'Alice', role: 'user' },
    { clerkId: clerkIds.dora, username: `${TAG}-dora`.replace(/-/g, '_'), displayName: 'Dora', role: 'user', disabledAt: new Date(), disabledReason: 'test' },
  ]).returning({ id: users.id, clerkId: users.clerkId, username: users.username });
  createdIds.push(...inserted.map(u => u.id));
  const alice = inserted.find(u => u.clerkId === clerkIds.alice)!;
  const dora = inserted.find(u => u.clerkId === clerkIds.dora)!;

  // ── PATCH /api/users/me ──
  check('signed out → 401', (await call(null, 'PATCH', '/users/me', { displayName: 'X' })).status === 401);
  const ok = await call(clerkIds.alice, 'PATCH', '/users/me', { displayName: '  Alice   in   Wonderland ' });
  check('self edit → 200, normalized', ok.status === 200 && ok.body.displayName === 'Alice in Wonderland', ok);
  check('…stored', (await row(clerkIds.alice)).displayName === 'Alice in Wonderland');
  check('…response never carries the PM credential or synced_at', ok.body && !('pinballMapToken' in ok.body) && !('imageSyncedAt' in ok.body), ok.body);
  const locked = await call(clerkIds.alice, 'PATCH', '/users/me', { displayName: 'A', username: 'newname' });
  check('username in body → 400 username_locked, nothing saved', locked.status === 400 && locked.body.code === 'username_locked'
    && (await row(clerkIds.alice)).displayName === 'Alice in Wonderland', locked);
  for (const [label, displayName, code] of [
    ['blank', '   ', 'display_name_required'], ['control-only', '\u0000', 'display_name_required'],
    ['41 chars', 'a'.repeat(41), 'display_name_too_long'], ['leading @', '@alice', 'display_name_at'], ['not a string', 7, 'display_name_required'],
  ] as const) {
    const r = await call(clerkIds.alice, 'PATCH', '/users/me', { displayName });
    check(`${label} name → 400 ${code}`, r.status === 400 && r.body.code === code, r);
  }
  check('empty body → 400 nothing_to_update', (await call(clerkIds.alice, 'PATCH', '/users/me', {})).body?.code === 'nothing_to_update');
  const disabled = await call(clerkIds.dora, 'PATCH', '/users/me', { displayName: 'Dora 2' });
  check('disabled user → 403 account_disabled', disabled.status === 403 && disabled.body.code === 'account_disabled', disabled);
  check('no profile → 403 NO_PROFILE', (await call(`${TAG}-ghost`, 'PATCH', '/users/me', { displayName: 'Ghost' })).body?.code === 'NO_PROFILE');

  const [ev] = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'profile.updated'), eq(activityEvents.actorUserId, alice.id)));
  check('profile.updated logged with before/after', !!ev && (ev.payload as any)?.after?.displayName === 'Alice in Wonderland', ev);
  const same = await call(clerkIds.alice, 'PATCH', '/users/me', { displayName: 'Alice in Wonderland' });
  const evCount = (await db.select({ id: activityEvents.id }).from(activityEvents)
    .where(and(eq(activityEvents.type, 'profile.updated'), eq(activityEvents.actorUserId, alice.id)))).length;
  check('unchanged name → 200, no second event', same.status === 200 && evCount === 1, { same, evCount });

  // ── Admin PATCH uses the same rules ──
  const blank = await call(clerkIds.admin, 'PATCH', `/admin/users/${alice.id}`, { displayName: '   ' });
  check('admin can’t blank a name → 400', blank.status === 400 && blank.body.code === 'display_name_required', blank);
  const adm = await call(clerkIds.admin, 'PATCH', `/admin/users/${alice.id}`, { displayName: ' Alice  A ' });
  check('admin edit normalizes', adm.status === 200 && adm.body.displayName === 'Alice A', adm);

  // ── Photos: sync route, webhook, visibility ──
  clerkPhotos.set(clerkIds.alice, { hasImage: true, imageUrl: 'https://img.clerk.com/alice-1' });
  resetAvatarSyncState();
  const sync = await call(clerkIds.alice, 'POST', '/users/me/avatar/sync');
  check('avatar sync → 200 with the Clerk photo', sync.status === 200 && sync.body.imageUrl === 'https://img.clerk.com/alice-1', sync);
  check('…stored with a synced_at', (await row(clerkIds.alice)).imageSyncedAt != null);
  const photoEv = await db.select().from(activityEvents)
    .where(and(eq(activityEvents.type, 'profile.updated'), eq(activityEvents.actorUserId, alice.id), sql`${activityEvents.payload}->'fields' ? 'photo'`));
  check('…logs profile.updated (photo)', photoEv.length === 1, photoEv);

  clerkPhotos.set(clerkIds.alice, null);
  const down = await call(clerkIds.alice, 'POST', '/users/me/avatar/sync');
  check('Clerk down → 502, photo kept', down.status === 502 && (await row(clerkIds.alice)).imageUrl === 'https://img.clerk.com/alice-1', down);
  check('disabled user can’t sync → 403', (await call(clerkIds.dora, 'POST', '/users/me/avatar/sync')).status === 403);

  // Webhook: newer applies, older (out-of-order) is ignored, default avatar = null.
  const t0 = Date.now() + 60_000; // after the sync above
  let w = await webhook({ id: clerkIds.alice, has_image: true, image_url: 'https://img.clerk.com/alice-2', updated_at: t0 });
  check('webhook user.updated (newer) applies', w.status === 200 && w.body.avatarApplied === true && (await row(clerkIds.alice)).imageUrl === 'https://img.clerk.com/alice-2', w);
  w = await webhook({ id: clerkIds.alice, has_image: true, image_url: 'https://img.clerk.com/alice-stale', updated_at: t0 - 1000 });
  check('webhook delivered out of order is ignored (200)', w.status === 200 && w.body.avatarApplied === false && (await row(clerkIds.alice)).imageUrl === 'https://img.clerk.com/alice-2', w);
  w = await webhook({ id: clerkIds.alice, has_image: false, image_url: 'https://img.clerk.com/default', updated_at: t0 + 1000 });
  check('webhook: photo removed → null', w.status === 200 && (await row(clerkIds.alice)).imageUrl === null, w);
  w = await webhook({ id: clerkIds.alice, has_image: true, image_url: 'https://img.clerk.com/alice-3', updated_at: t0 + 2000 });

  const guest = await call(null, 'GET', `/users/${alice.username}`);
  check('guest profile view → no imageUrl field', guest.status === 200 && !('imageUrl' in guest.body.user), guest.body?.user);
  const signedIn = await call(clerkIds.admin, 'GET', `/users/${alice.username}`);
  check('signed-in profile view → imageUrl', signedIn.body?.user?.imageUrl === 'https://img.clerk.com/alice-3', signedIn.body?.user);
  check('…username unchanged throughout', (await row(clerkIds.alice)).username === alice.username);
  check('fake Clerk was only asked by the sync route', clerkCalls === 2, clerkCalls);
  void dora;
} finally {
  if (createdIds.length) {
    await db.delete(activityEvents).where(or(
      inArray(activityEvents.actorUserId, createdIds), inArray(activityEvents.subjectUserId, createdIds),
      sql`${activityEvents.svixId} LIKE ${`msg_${TAG}%`}`,
    ));
    await db.delete(users).where(inArray(users.id, createdIds));
  }
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
}
