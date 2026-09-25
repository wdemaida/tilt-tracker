// End-to-end check of the /api/pods routes against the Neon DEV branch.
//
// Mounts the real pods router on a throwaway express app behind a stub that plays the part of
// requireAppUser (sets req.appUser from an `x-test-user` header), so the route logic, SQL and
// constraints are exercised for real without needing Clerk session tokens. The Clerk half —
// requireAppUser itself — is existing code; unauthenticated requests to the real server are checked
// separately (they get 401).
//
// Borrows the first three existing users as owner / other owner / member, creates pods named
// "__podtest…", and deletes everything it created at the end (pod_members cascade with the pod).
//
//   cd artifacts/api-server && npx tsx test-pods.ts

import 'dotenv/config';

// DEV-BRANCH GUARD — same as migrate13.ts. Never run this against production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { default: express } = await import('express');
const { default: podsRouter } = await import('./src/routes/pods.js');
const { db, users, pods } = await import('@workspace/db');
const { asc, like } = await import('drizzle-orm');

const people = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
  .from(users).orderBy(asc(users.id)).limit(3);
if (people.length < 3) throw new Error('Need at least 3 users in the dev DB');
const [owner, other, member] = people;

const app = express();
app.use(express.json());
app.use('/api/pods', (req: any, _res, next) => {
  req.appUser = people.find(p => p.id === Number(req.header('x-test-user')));
  next();
}, podsRouter);
const server = app.listen(0);
const port = (server.address() as any).port;

async function call(as: { id: number }, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/api/pods${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(as.id) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
}

try {
  // create — default color comes from the palette
  let r = await call(owner, 'POST', '/', { name: '  __podtest   Crew ' });
  check('create → 201', r.status === 201, r);
  const podId = r.body?.id;
  check('name trimmed/collapsed', r.body?.name === '__podtest Crew', r.body);
  check('default color is a palette hex', /^#[0-9a-f]{6}$/.test(r.body?.color ?? ''), r.body);
  check('starts with 0 members', r.body?.memberCount === 0 && Array.isArray(r.body?.members), r.body);

  r = await call(owner, 'POST', '/', { name: '__PODTEST crew' });
  check('duplicate name (case-insensitive) → 409 name_taken', r.status === 409 && r.body?.code === 'name_taken', r);

  r = await call(other, 'POST', '/', { name: '__podtest crew', color: '#ABC' });
  check('another owner may reuse the name → 201', r.status === 201, r);
  check('#ABC normalized to #aabbcc', r.body?.color === '#aabbcc', r.body);
  const otherPodId = r.body?.id;

  for (const color of ['red', '#12345', 'rgb(1,2,3)', '#aabbccdd', 42]) {
    r = await call(owner, 'POST', '/', { name: '__podtest bad', color });
    check(`invalid color ${JSON.stringify(color)} → 400 invalid_color`, r.status === 400 && r.body?.code === 'invalid_color', r);
  }
  r = await call(owner, 'POST', '/', { name: '   ' });
  check('blank name → 400 invalid_name', r.status === 400 && r.body?.code === 'invalid_name', r);
  r = await call(owner, 'POST', '/', { name: 'x'.repeat(41) });
  check('41-char name → 400 invalid_name', r.status === 400 && r.body?.code === 'invalid_name', r);

  // rename / recolor
  r = await call(owner, 'PATCH', `/${podId}`, { name: '__podtest Renamed' });
  check('rename → 200', r.status === 200 && r.body?.name === '__podtest Renamed', r);
  r = await call(owner, 'PATCH', `/${podId}`, { color: ' #D95926 ' });
  check('recolor → 200, normalized', r.status === 200 && r.body?.color === '#d95926', r);
  r = await call(owner, 'PATCH', `/${podId}`, { color: 'blue' });
  check('recolor invalid → 400', r.status === 400 && r.body?.code === 'invalid_color', r);
  r = await call(owner, 'POST', '/', { name: '__podtest Second' });
  const secondId = r.body?.id;
  check('second pod default color differs from first', r.status === 201 && r.body?.color !== '#d95926', r.body);
  r = await call(owner, 'PATCH', `/${secondId}`, { name: '__podtest renamed' });
  check('rename onto existing name → 409', r.status === 409 && r.body?.code === 'name_taken', r);

  // members
  r = await call(owner, 'POST', `/${podId}/members`, { userId: member.id });
  check('add member → 201', r.status === 201 && r.body?.memberCount === 1 && r.body?.members[0]?.id === member.id, r);
  check('member payload is basics only', Object.keys(r.body?.members?.[0] ?? {}).sort().join() === 'addedAt,displayName,id,username', r.body?.members);
  r = await call(owner, 'POST', `/${podId}/members`, { userId: member.id });
  check('add same member again → 200, still 1', r.status === 200 && r.body?.memberCount === 1, r);
  r = await call(owner, 'POST', `/${secondId}/members`, { userId: member.id });
  check('same user in two of my pods → 201', r.status === 201, r);
  r = await call(owner, 'POST', `/${podId}/members`, { userId: owner.id });
  check('add self → 400 cannot_add_self', r.status === 400 && r.body?.code === 'cannot_add_self', r);
  r = await call(owner, 'POST', `/${podId}/members`, { userId: 999999999 });
  check('add unknown user → 404 user_not_found', r.status === 404 && r.body?.code === 'user_not_found', r);

  r = await call(owner, 'GET', '/');
  const mine = (r.body ?? []).filter((p: any) => p.name.startsWith('__podtest'));
  check('list shows my 2 pods only', r.status === 200 && mine.length === 2 && !mine.some((p: any) => p.id === otherPodId), mine);

  // privacy — someone else's pod id is a 404 everywhere, indistinguishable from nonexistent
  r = await call(owner, 'PATCH', `/${otherPodId}`, { name: 'hijack' });
  check("PATCH other's pod → 404", r.status === 404 && r.body?.code === 'pod_not_found', r);
  r = await call(owner, 'DELETE', `/${otherPodId}`);
  check("DELETE other's pod → 404", r.status === 404, r);
  r = await call(owner, 'POST', `/${otherPodId}/members`, { userId: member.id });
  check("add member to other's pod → 404", r.status === 404, r);
  r = await call(owner, 'DELETE', `/${otherPodId}/members/${member.id}`);
  check("remove member from other's pod → 404", r.status === 404, r);
  const missing = await call(owner, 'PATCH', '/999999999', { name: 'x' });
  check('nonexistent pod → identical 404 body', missing.status === 404 && JSON.stringify(missing.body) === JSON.stringify(r.body), missing);
  r = await call(owner, 'PATCH', '/abc', { name: 'x' });
  check('malformed id → 404', r.status === 404, r);
  r = await call(member, 'GET', '/');
  check("member sees none of owner's pods", r.status === 200 && !(r.body ?? []).some((p: any) => p.id === podId || p.id === secondId), r.body);

  // user search
  const needle = member.username.slice(0, 3);
  r = await call(owner, 'GET', `/user-search?q=${encodeURIComponent(needle)}`);
  check('user search finds member', r.status === 200 && r.body.some((u: any) => u.id === member.id), r);
  check('user search ≤ 10 results', r.body.length <= 10, r.body.length);
  r = await call(owner, 'GET', `/user-search?q=${encodeURIComponent(owner.username)}`);
  check('user search excludes self', r.status === 200 && !r.body.some((u: any) => u.id === owner.id), r.body);
  r = await call(owner, 'GET', '/user-search?q=%25');
  check('"%" is literal, not a wildcard', r.status === 200 && Array.isArray(r.body), r);

  // remove member, delete pod
  r = await call(owner, 'DELETE', `/${podId}/members/${member.id}`);
  check('remove member → 200, 0 left', r.status === 200 && r.body?.memberCount === 0, r);
  r = await call(owner, 'DELETE', `/${podId}/members/${member.id}`);
  check('remove non-member → 404 not_a_member', r.status === 404 && r.body?.code === 'not_a_member', r);
  r = await call(owner, 'DELETE', `/${secondId}`);
  check('delete pod with a member → 204 (cascade)', r.status === 204, r);
  r = await call(owner, 'GET', '/');
  check('deleted pod gone from list', !(r.body ?? []).some((p: any) => p.id === secondId), r.body);
} finally {
  await db.delete(pods).where(like(pods.name, '\\_\\_podtest%'));
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
