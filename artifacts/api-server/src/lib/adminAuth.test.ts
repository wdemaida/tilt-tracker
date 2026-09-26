// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/adminAuth.test.ts   (from artifacts/api-server)
//
// Disabled-account enforcement and admin authorization, using the REAL guards (requireAppUser /
// requireAdmin / rejectDisabledUser) and the REAL admin router, with Clerk and the users lookup
// swapped via setAuthForTests. Every route registered on the admin router (the old admin routes and
// the whole admin area) must refuse a guest (401), a regular user (403), a disabled admin (403
// account_disabled) and a profile-less caller (403 NO_PROFILE) before any handler runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { appUserRefusal, requireAppUser, requireAdmin, rejectDisabledUser, setAuthForTests } from '../middleware/requireAuth.js';
import adminRouter from '../routes/admin.js';
import adminAreaRouter from '../routes/adminArea.js';
import { getClerkActivity, setClerkBan, setClerkAdminForTests } from './clerkAdmin.js';

const base = { username: 'u', displayName: 'U', pinballMapToken: null, pinballMapUsername: null, disabledReason: null, disabledById: null, createdAt: new Date() };
const PEOPLE: Record<string, any> = {
  clerk_admin: { ...base, id: 1, clerkId: 'clerk_admin', role: 'admin', disabledAt: null },
  clerk_user: { ...base, id: 2, clerkId: 'clerk_user', role: 'user', disabledAt: null },
  clerk_disabled: { ...base, id: 3, clerkId: 'clerk_disabled', role: 'user', disabledAt: new Date() },
  clerk_disabled_admin: { ...base, id: 4, clerkId: 'clerk_disabled_admin', role: 'admin', disabledAt: new Date() },
};
setAuthForTests({
  resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null,
  loadUser: async clerkId => PEOPLE[clerkId],
});

const app = express();
app.use(express.json());
app.get('/app', requireAppUser, (_req, res) => void res.json({ ok: true }));
app.get('/upload', rejectDisabledUser, (_req, res) => void res.json({ ok: true }));
app.get('/adminonly', requireAppUser, requireAdmin, (_req, res) => void res.json({ ok: true }));
app.use('/api/admin', adminRouter);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
after(() => server.close());

async function hit(method: string, path: string, clerk?: string) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(clerk ? { 'x-test-clerk': clerk } : {}) },
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

test('appUserRefusal: no profile, disabled, active', () => {
  assert.deepEqual(appUserRefusal(undefined)?.body.code, 'NO_PROFILE');
  const d = appUserRefusal({ disabledAt: new Date() });
  assert.equal(d?.status, 403);
  assert.equal(d?.body.code, 'account_disabled');
  assert.equal(appUserRefusal({ disabledAt: null }), null);
});

test('requireAppUser: guest 401, profile-less 403, disabled 403 account_disabled, active passes', async () => {
  assert.equal((await hit('GET', '/app')).status, 401);
  assert.equal((await hit('GET', '/app', 'clerk_nobody')).body.code, 'NO_PROFILE');
  const d = await hit('GET', '/app', 'clerk_disabled');
  assert.equal(d.status, 403);
  assert.equal(d.body.code, 'account_disabled');
  assert.equal((await hit('GET', '/app', 'clerk_user')).status, 200);
});

test('rejectDisabledUser: anonymous and active pass, disabled is refused', async () => {
  assert.equal((await hit('GET', '/upload')).status, 200);
  assert.equal((await hit('GET', '/upload', 'clerk_user')).status, 200);
  assert.equal((await hit('GET', '/upload', 'clerk_nobody')).status, 200);
  assert.equal((await hit('GET', '/upload', 'clerk_disabled')).body.code, 'account_disabled');
});

test('requireAdmin: user 403, admin passes, disabled admin refused before the role check', async () => {
  assert.equal((await hit('GET', '/adminonly', 'clerk_user')).status, 403);
  assert.equal((await hit('GET', '/adminonly', 'clerk_admin')).status, 200);
  assert.equal((await hit('GET', '/adminonly', 'clerk_disabled_admin')).body.code, 'account_disabled');
});

function routesOf(router: any): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: layer.route.path });
    } else if (layer.handle?.stack) {
      out.push(...routesOf(layer.handle));
    }
  }
  return out;
}

test('every admin route refuses guests, users, disabled admins and profile-less callers', async () => {
  const routes = routesOf(adminRouter);
  const areaRoutes = routesOf(adminAreaRouter);
  assert.ok(areaRoutes.length >= 18, `admin area has its routes (${areaRoutes.length})`);
  for (const r of areaRoutes) {
    assert.ok(routes.some(x => x.method === r.method && x.path === r.path), `${r.method} ${r.path} is mounted inside the guarded admin router`);
  }
  for (const r of routes) {
    const path = `/api/admin${r.path.replace(/:[a-zA-Z]+/g, '1')}`;
    const label = `${r.method} ${path}`;
    assert.equal((await hit(r.method, path)).status, 401, `${label} guest`);
    assert.equal((await hit(r.method, path, 'clerk_user')).status, 403, `${label} user`);
    const dis = await hit(r.method, path, 'clerk_disabled_admin');
    assert.equal(dis.status, 403, `${label} disabled admin`);
    assert.equal(dis.body.code, 'account_disabled', `${label} disabled admin code`);
    assert.equal((await hit(r.method, path, 'clerk_nobody')).status, 403, `${label} no profile`);
  }
});

test('an admin gets past the guard (the handler runs — here it fails on the fake DB, not 401/403)', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await hit('GET', '/api/admin/activity/types', 'clerk_admin');
    assert.equal(r.status, 200, 'a DB-free handler answers');
    assert.ok(Array.isArray(r.body.admin));
  } finally {
    console.error = orig;
  }
});

test('clerkAdmin: batches lookups, caches for 60s, degrades without a backend', async () => {
  const calls: string[][] = [];
  setClerkAdminForTests({
    listUsers: async ids => { calls.push(ids); return ids.filter(i => i !== 'gone').map(id => ({ id, lastSignInAt: 1_760_000_000_000, lastActiveAt: null, banned: false })); },
    ban: async () => {}, unban: async () => { throw Object.assign(new Error('nope'), { errors: [{ message: 'Clerk says no' }] }); },
  });
  const ids = Array.from({ length: 150 }, (_, i) => `u${i}`).concat('gone');
  const t0 = 1_000_000;
  const first = await getClerkActivity(ids, t0);
  assert.equal(calls.length, 2, '151 ids → 2 batched calls');
  assert.equal(first.get('u0')?.lastSignInAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(first.get('gone'), null, 'unknown to Clerk → null');
  await getClerkActivity(ids, t0 + 30_000);
  assert.equal(calls.length, 2, 'cached');
  await getClerkActivity(['u1'], t0 + 61_000);
  assert.equal(calls.length, 3, 'expired entry refetched');
  assert.deepEqual(await setClerkBan('u1', true), { ok: true });
  const orig = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await setClerkBan('u1', false), { ok: false, error: 'Clerk says no' });
  } finally {
    console.error = orig;
  }
  setClerkAdminForTests(null);
  assert.equal((await getClerkActivity(['u1'])).size, 0, 'no backend → empty map');
  assert.equal((await setClerkBan('u1', true)).ok, false);
  setClerkAdminForTests(undefined);
});
