// Live round trip of full-size score photos against the Neon DEV branch and the R2 DEV bucket.
//
// Mounts the real photo + scores routers on a throwaway express app behind the same auth stub as
// test-challenges.ts (req.appUser + a req.auth() answering the test user's clerk id; no header =
// guest). Then, for real: presigned PUT → R2 → confirm (HeadObject) → list shows hasFullPhoto and no
// key → guest GET signs a URL whose bytes match → replace deletes the old object → hidden home-venue
// score is a 404 to strangers and guests → DELETE /api/scores/:id removes the object.
//
// Borrows two existing non-admin users (the owner and a stranger), and makes one throwaway
// `zz-photo-test` machine and one hidden home venue owned by the owner. Everything it creates —
// scores, venue, machine, and every object under those scores' prefixes — is removed at the end.
// Skips (exit 0) when the R2_* variables aren't set.
//
//   cd artifacts/api-server && npx tsx test-photos.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { missingR2Vars, getPhotoStore, PHOTO_KEY_PREFIX } = await import('./src/lib/photoStore.js');
const missing = missingR2Vars();
if (missing.length) {
  console.log(`SKIP  R2 not configured (missing ${missing.join(', ')}) — nothing to test live.`);
  process.exit(0);
}
if (process.env.R2_BUCKET !== 'tilttrack-photos-dev') {
  console.error('Refusing to run: R2_BUCKET is not the dev bucket (tilttrack-photos-dev).');
  process.exit(1);
}

const { default: express } = await import('express');
const { default: sharp } = await import('sharp');
const { default: scoresRouter } = await import('./src/routes/scores.js');
const { default: scorePhotosRouter } = await import('./src/routes/scorePhotos.js');
const { db, users, scores, machines, venues } = await import('@workspace/db');
const { eq, inArray } = await import('drizzle-orm');

const store = getPhotoStore()!;

const people = await db.select().from(users).where(eq(users.role, 'user')).limit(2);
if (people.length < 2) throw new Error('Need at least 2 non-admin users in the dev DB');
const [owner, stranger] = people;

const app = express();
app.use(express.json());
const stub = (req: any, _res: any, next: any) => {
  const u = people.find(p => p.id === Number(req.header('x-test-user')));
  req.appUser = u;
  req.auth = () => ({ userId: u?.clerkId ?? null, tokenType: 'session_token', sessionClaims: {} });
  next();
};
app.use('/api/scores', stub, scorePhotosRouter);
app.use('/api/scores', stub, scoresRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: { id: number } | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-user'] = String(as.id);
  const res = await fetch(`http://localhost:${port}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
}

let failures = 0, passes = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passes++; else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)?.slice(0, 400)}`}`);
}

const jpeg = (seed: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: seed % 255, g: 80, b: 160 } } }).jpeg({ quality: 80 }).toBuffer();

async function uploadVia(as: { id: number }, scoreId: number, bytes: Buffer) {
  const u = await call(as, 'POST', `/scores/${scoreId}/photo/upload-url`);
  if (u.status !== 200) return { u, put: null as Response | null };
  const put = await fetch(u.body.url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes });
  return { u, put };
}

let machineId: number | null = null;
let venueId: number | null = null;
const scoreIds: number[] = [];
const everScoreIds = new Set<number>();

try {
  const [m] = await db.insert(machines).values({ name: `zz-photo-test ${Date.now()}` }).returning();
  machineId = m.id;
  const [v] = await db.insert(venues).values({
    name: 'zz-photo-test home', ownerId: owner.id, isResidence: true, privacyTier: 'hidden', showMachinesAndScores: false,
  }).returning();
  venueId = v.id;

  // ── public score: create through the real route ─────────────────────────────
  const created = await call(owner, 'POST', '/scores', { machineId, score: 1234560, playedAt: new Date().toISOString() });
  check('POST /scores creates the score', created.status === 201, created);
  const sid: number = created.body.id;
  scoreIds.push(sid);
  everScoreIds.add(sid);
  check('create response has hasFullPhoto=false and no photoKey', created.body.hasFullPhoto === false && !('photoKey' in created.body), created.body);

  // ── permissions ────────────────────────────────────────────────────────────
  const strangerUrl = await call(stranger, 'POST', `/scores/${sid}/photo/upload-url`);
  check("stranger can't get an upload URL (403)", strangerUrl.status === 403, strangerUrl);
  const guestUrl = await call(null, 'POST', `/scores/${sid}/photo/upload-url`);
  check("guest can't get an upload URL (401)", guestUrl.status === 401, guestUrl);

  // ── upload + confirm ───────────────────────────────────────────────────────
  const bytes1 = await jpeg(1);
  const u1 = await call(owner, 'POST', `/scores/${sid}/photo/upload-url`);
  check('owner gets a presigned PUT', u1.status === 200 && typeof u1.body.url === 'string' && u1.body.key.startsWith(`${PHOTO_KEY_PREFIX}${sid}/`), u1);
  const key1: string = u1.body.key;

  const wrongType = await fetch(u1.body.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes1 });
  check('R2 refuses a PUT with a different Content-Type (signed header)', wrongType.status === 403, wrongType.status);

  const early = await call(owner, 'POST', `/scores/${sid}/photo/confirm`, { key: key1 });
  check('confirm before the PUT → 404 photo_not_uploaded', early.status === 404 && early.body.code === 'photo_not_uploaded', early);

  const put1 = await fetch(u1.body.url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes1 });
  check('PUT to R2 succeeds', put1.ok, put1.status);

  const foreignKey = await call(owner, 'POST', `/scores/${sid}/photo/confirm`, { key: key1.replace(`/${sid}/`, `/${sid + 1}/`) });
  check("confirm with another score's key → 400", foreignKey.status === 400 && foreignKey.body.code === 'photo_key_invalid', foreignKey);
  const strangerConfirm = await call(stranger, 'POST', `/scores/${sid}/photo/confirm`, { key: key1 });
  check("stranger can't confirm (403)", strangerConfirm.status === 403, strangerConfirm);

  const c1 = await call(owner, 'POST', `/scores/${sid}/photo/confirm`, { key: key1, width: 64, height: 48 });
  check('confirm → hasFullPhoto', c1.status === 200 && c1.body.hasFullPhoto === true, c1);
  const [row1] = await db.select().from(scores).where(eq(scores.id, sid));
  check('row stores key, size and dimensions', row1.photoKey === key1 && row1.photoBytes === bytes1.length && row1.photoWidth === 64 && row1.photoHeight === 48, row1);
  const again = await call(owner, 'POST', `/scores/${sid}/photo/confirm`, { key: key1 });
  check('re-confirming the same key is idempotent', again.status === 200, again);

  // ── lists expose only the boolean ──────────────────────────────────────────
  const list = await call(null, 'GET', '/scores');
  const listed = (list.body as any[]).find(s => s.id === sid);
  check('guest list shows hasFullPhoto=true', listed?.hasFullPhoto === true, listed);
  check('no list response contains a photo key', !list.raw.includes(PHOTO_KEY_PREFIX) && !list.raw.includes('photoKey'), 'key leaked');

  // ── viewing ────────────────────────────────────────────────────────────────
  const view = await call(null, 'GET', `/scores/${sid}/photo`);
  check('guest GET /photo signs a URL with dimensions', view.status === 200 && typeof view.body.url === 'string' && view.body.width === 64, view);
  const got = Buffer.from(await (await fetch(view.body.url)).arrayBuffer());
  check('signed URL returns exactly the uploaded bytes', got.equals(bytes1), { got: got.length, want: bytes1.length });

  // ── replace ────────────────────────────────────────────────────────────────
  const bytes2 = await jpeg(2);
  const { u: u2, put: put2 } = await uploadVia(owner, sid, bytes2);
  check('second upload PUT succeeds', !!put2?.ok, u2);
  const c2 = await call(owner, 'POST', `/scores/${sid}/photo/confirm`, { key: u2.body.key });
  check('confirm replacement', c2.status === 200, c2);
  check('replacing deletes the previous object', (await store.head(key1)) === null, key1);
  const key2: string = u2.body.key;

  // ── hidden home-venue score ────────────────────────────────────────────────
  const [hidden] = await db.insert(scores).values({ userId: owner.id, machineId, score: 999, playedAt: new Date(), venueId, venueName: 'zz-photo-test home' }).returning();
  scoreIds.push(hidden.id);
  everScoreIds.add(hidden.id);
  const { u: uh, put: puth } = await uploadVia(owner, hidden.id, await jpeg(3));
  const ch = await call(owner, 'POST', `/scores/${hidden.id}/photo/confirm`, { key: uh.body?.key });
  check('owner attaches a photo to a hidden-venue score', !!puth?.ok && ch.status === 200, ch);
  const hStranger = await call(stranger, 'GET', `/scores/${hidden.id}/photo`);
  const hGuest = await call(null, 'GET', `/scores/${hidden.id}/photo`);
  const hOwner = await call(owner, 'GET', `/scores/${hidden.id}/photo`);
  check('hidden-venue photo: stranger 404', hStranger.status === 404, hStranger);
  check('hidden-venue photo: guest 404', hGuest.status === 404, hGuest);
  check('hidden-venue photo: owner 200', hOwner.status === 200, hOwner);

  const none = await call(null, 'GET', `/scores/2147483000/photo`);
  check('unknown score → 404', none.status === 404, none);

  // ── delete removes the object ──────────────────────────────────────────────
  const del = await call(owner, 'DELETE', `/scores/${sid}`);
  check('DELETE /scores/:id → 204', del.status === 204, del);
  scoreIds.splice(scoreIds.indexOf(sid), 1);
  check('the object is gone after the score is deleted', (await store.head(key2)) === null, key2);
  const delHidden = await call(owner, 'DELETE', `/scores/${hidden.id}`);
  check('DELETE hidden-venue score → 204', delHidden.status === 204, delHidden);
  scoreIds.splice(scoreIds.indexOf(hidden.id), 1);
  check('its object is gone too', (await store.head(uh.body.key)) === null, uh.body.key);
} catch (err) {
  failures++;
  console.error('FAIL  unexpected error:', err);
} finally {
  // Every object under the test scores' prefixes (including any left by a failed step).
  const allIds = [...everScoreIds];
  for (const id of allIds) {
    const { objects } = await store.list(`${PHOTO_KEY_PREFIX}${id}/`);
    for (const o of objects) await store.delete(o.key).catch(() => {});
  }
  if (scoreIds.length) await db.delete(scores).where(inArray(scores.id, scoreIds));
  if (machineId != null) await db.delete(scores).where(eq(scores.machineId, machineId));
  if (venueId != null) await db.delete(venues).where(eq(venues.id, venueId));
  if (machineId != null) await db.delete(machines).where(eq(machines.id, machineId));
  server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
