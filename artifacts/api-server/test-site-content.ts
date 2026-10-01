// End-to-end check of the welcome-page content editor (feature/site-content, migrate28) against the
// Neon DEV branch: the real admin router (PUT / GET / DELETE /api/admin/content) and the real public
// router (GET /api/content/welcome) in-process over HTTP. Only Clerk is faked — the caller is the dev
// branch's first admin. Restores every site_content row it touched and deletes its activity events.
//
//   cd artifacts/api-server && npx tsx test-site-content.ts

import 'dotenv/config';
import express from 'express';
import type { AddressInfo } from 'node:net';

const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { db, users, siteContent, activityEvents } = await import('@workspace/db');
const { and, eq, gte, inArray } = await import('drizzle-orm');
const { setAuthForTests } = await import('./src/middleware/requireAuth.js');
const adminRouter = (await import('./src/routes/admin.js')).default;
const contentRouter = (await import('./src/routes/content.js')).default;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
if (!admin) { console.error('No admin user on the dev branch.'); process.exit(1); }
setAuthForTests({
  resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null,
  loadUser: async clerkId => (clerkId === admin.clerkId ? admin : undefined),
});

const app = express();
app.use(express.json());
app.use('/api/admin', adminRouter);
app.use('/api/content', contentRouter);
const server = app.listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

async function hit(method: string, path: string, body?: unknown, asAdmin = true) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(asAdmin ? { 'x-test-clerk': admin.clerkId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
}

const KEYS = ['welcome.hero', 'welcome.socials'];
const before = await db.select().from(siteContent).where(inArray(siteContent.key, KEYS));
const startedAt = new Date(Date.now() - 5_000);

try {
  // Admin GET: every section with its spec.
  const list = await hit('GET', '/api/admin/content');
  check(list.status === 200 && list.body.sections.length === 9, `GET /admin/content → 9 sections (${list.status})`);
  check(!!list.body.sections.find((s: any) => s.key === 'welcome.hero')?.spec?.fields?.headline, 'the spec comes with each section');

  // Guest is refused.
  check((await hit('GET', '/api/admin/content', undefined, false)).status === 401, 'guest → 401');

  // A bad value: per-field errors, nothing written.
  const bad = await hit('PUT', '/api/admin/content/welcome.hero', { value: { headline: '', subhead: 'see [x](javascript:alert(1))', extra: 1 } });
  check(bad.status === 400 && bad.body.code === 'invalid_content', `invalid value → 400 invalid_content (${bad.status})`);
  check(!!bad.body.errors?.headline && !!bad.body.errors?.subhead && !!bad.body.errors?.extra, 'errors name headline, subhead and the unknown field');
  check((await hit('PUT', '/api/admin/content/welcome.nope', { value: {} })).status === 404, 'unknown key → 404');

  // Save.
  const hero = { eyebrow: 'zz-site-content-test', headline: 'Test **headline**\n==glow==', subhead: '  Line one.\r\n\r\nLine two.  ' };
  const put = await hit('PUT', '/api/admin/content/welcome.hero', { value: hero });
  check(put.status === 200, `PUT welcome.hero → 200 (${put.status})`);
  check(put.body.value?.subhead === 'Line one.\n\nLine two.', 'stored value is normalized');
  check(put.body.updatedBy?.id === admin.id && !!put.body.updatedAt, 'updatedBy / updatedAt returned');

  // Public read sees it immediately (the write cleared the cache), with a cache header.
  const pub = await hit('GET', '/api/content/welcome', undefined, false);
  check(pub.status === 200 && pub.body['welcome.hero']?.eyebrow === 'zz-site-content-test', 'public GET serves the override');
  check(pub.headers.get('cache-control') === 'public, max-age=60', `Cache-Control: ${pub.headers.get('cache-control')}`);

  const socials = await hit('PUT', '/api/admin/content/welcome.socials', { value: { title: 'Follow', email: 'tilttrack@gmail.com', links: [{ label: 'Instagram', url: 'https://instagram.com/tilttrack' }] } });
  check(socials.status === 200, 'PUT welcome.socials → 200');

  // Activity: one admin.content_updated per save, payload names the key and fields.
  const evs = await db.select().from(activityEvents).where(and(
    inArray(activityEvents.type, ['admin.content_updated', 'admin.content_reset']),
    eq(activityEvents.actorUserId, admin.id), gte(activityEvents.createdAt, startedAt),
  ));
  const heroEv = evs.find(e => e.targetId === 'welcome.hero' && e.type === 'admin.content_updated');
  check(!!heroEv, 'admin.content_updated logged for welcome.hero');
  check((heroEv?.payload as any)?.contentKey === 'welcome.hero' && Array.isArray((heroEv?.payload as any)?.fields), `payload ${JSON.stringify(heroEv?.payload)}`);

  // Reset.
  const del = await hit('DELETE', '/api/admin/content/welcome.hero');
  check(del.status === 200 && del.body.removed === true && del.body.value === null, 'DELETE → removed, back to default');
  const pub2 = await hit('GET', '/api/content/welcome', undefined, false);
  check(!('welcome.hero' in pub2.body), 'public GET no longer has welcome.hero');
  const del2 = await hit('DELETE', '/api/admin/content/welcome.hero');
  check(del2.status === 200 && del2.body.removed === false, 'second DELETE is a no-op');
  const resetEvs = await db.select().from(activityEvents).where(and(eq(activityEvents.type, 'admin.content_reset'), gte(activityEvents.createdAt, startedAt), eq(activityEvents.actorUserId, admin.id)));
  check(resetEvs.length === 1, `exactly one admin.content_reset (${resetEvs.length})`);
} finally {
  // Restore the rows exactly as they were, and remove this run's events.
  await db.delete(siteContent).where(inArray(siteContent.key, KEYS));
  if (before.length) await db.insert(siteContent).values(before);
  await db.delete(activityEvents).where(and(
    inArray(activityEvents.type, ['admin.content_updated', 'admin.content_reset']),
    eq(activityEvents.actorUserId, admin.id), gte(activityEvents.createdAt, startedAt),
  ));
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
