// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/clerkWebhook.test.ts   (from artifacts/api-server)
//
// The Clerk webhook route (src/routes/clerkWebhook.ts), driven with Svix-signed fixtures made with a
// throwaway test secret — no network, no database. The handler's deps are in-memory fakes, so
// idempotency (a retried svix-id) is checked against the same contract the real UNIQUE index gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Webhook } from 'svix';
import { createClerkWebhookHandler, verifyClerkWebhook, type ClerkWebhookDeps } from '../routes/clerkWebhook.js';
import type { ActivityInput } from './activity.js';

// Svix secrets are "whsec_" + base64. This one exists only in this file.
const SECRET = `whsec_${Buffer.from('tilttrack-test-secret-0123456789').toString('base64')}`;

function signed(body: object, opts: { id?: string; at?: Date; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const at = opts.at ?? new Date();
  const signature = new Webhook(opts.secret ?? SECRET).sign(id, at, raw);
  return {
    raw,
    headers: { 'svix-id': id, 'svix-timestamp': String(Math.floor(+at / 1000)), 'svix-signature': signature } as Record<string, string>,
  };
}

function memoryDeps(overrides: Partial<ClerkWebhookDeps> = {}) {
  const events: ActivityInput[] = [];
  const seen = new Set<string>();
  const deps: ClerkWebhookDeps = {
    secret: SECRET,
    resolveUserId: async clerkId => (clerkId === 'user_known' ? 42 : null),
    record: async ev => {
      if (ev.svixId && seen.has(ev.svixId)) return null;
      if (ev.svixId) seen.add(ev.svixId);
      events.push(ev);
      return events.length;
    },
    ...overrides,
  };
  return { deps, events };
}

async function call(handler: ReturnType<typeof createClerkWebhookHandler>, raw: string | object, headers: Record<string, string>) {
  const req: any = { body: typeof raw === 'string' ? Buffer.from(raw) : raw, headers };
  let status = 200;
  let body: any;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: unknown) { body = b; return res; },
  };
  await handler(req, res);
  return { status, body };
}

const sessionCreated = (userId = 'user_known') => ({
  type: 'session.created',
  data: {
    id: 'sess_1', user_id: userId, created_at: 1760000000000,
    latest_activity: { id: 'act_1', browser_name: 'Edge', browser_version: '140', device_type: 'Windows', is_mobile: false, ip_address: '203.0.113.7', city: 'Chicago', country: 'US' },
  },
});

test('valid session.created → user.signed_in with the resolved user and client info', async () => {
  const { deps, events } = memoryDeps();
  const h = createClerkWebhookHandler(deps);
  const { raw, headers } = signed(sessionCreated());
  const r = await call(h, raw, headers);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, duplicate: false });
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.type, 'user.signed_in');
  assert.equal(ev.actorUserId, 42);
  assert.equal(ev.targetType, 'clerk_user');
  assert.equal(ev.targetId, 'user_known');
  assert.equal(ev.ip, '203.0.113.7');
  assert.equal(ev.userAgent, 'Edge 140 (Windows)');
  assert.equal(ev.svixId, headers['svix-id']);
  assert.equal((ev.payload as any).city, 'Chicago');
});

test('a retried delivery (same svix-id) is recorded once and still answers 200', async () => {
  const { deps, events } = memoryDeps();
  const h = createClerkWebhookHandler(deps);
  const { raw, headers } = signed(sessionCreated(), { id: 'msg_retry' });
  assert.deepEqual((await call(h, raw, headers)).body, { ok: true, duplicate: false });
  const again = await call(h, raw, headers);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, duplicate: true });
  assert.equal(events.length, 1);
});

test('user.created → user.signed_up without any email address in the payload', async () => {
  const { deps, events } = memoryDeps();
  const h = createClerkWebhookHandler(deps);
  const { raw, headers } = signed({ type: 'user.created', data: { id: 'user_new', created_at: 1760000000000, email_addresses: [{ email_address: 'someone@example.com' }], external_accounts: [] } });
  assert.equal((await call(h, raw, headers)).status, 200);
  assert.equal(events[0].type, 'user.signed_up');
  assert.equal(events[0].actorUserId, null, 'no profile yet');
  assert.equal(events[0].targetId, 'user_new');
  assert.ok(!JSON.stringify(events[0]).includes('someone@example.com'));
  assert.equal((events[0].payload as any).method, 'email');
});

test('user.deleted → user.clerk_deleted; unhandled types are acknowledged and ignored', async () => {
  const { deps, events } = memoryDeps();
  const h = createClerkWebhookHandler(deps);
  let s = signed({ type: 'user.deleted', data: { id: 'user_known', deleted: true } });
  assert.equal((await call(h, s.raw, s.headers)).status, 200);
  assert.equal(events[0].type, 'user.clerk_deleted');
  assert.equal(events[0].subjectUserId, 42);
  s = signed({ type: 'email.created', data: { id: 'e_1' } });
  const r = await call(h, s.raw, s.headers);
  assert.equal(r.status, 200);
  assert.equal(r.body.ignored, 'email.created');
  assert.equal(events.length, 1);
});

test('a tampered body, wrong secret, stale timestamp or missing headers → 400, nothing recorded', async () => {
  const { deps, events } = memoryDeps();
  const h = createClerkWebhookHandler(deps);
  const good = signed(sessionCreated());

  const tampered = good.raw.replace('user_known', 'user_other');
  assert.equal((await call(h, tampered, good.headers)).status, 400);

  const wrong = signed(sessionCreated(), { secret: `whsec_${Buffer.from('some-other-secret-xxxxxxxxxxxxxx').toString('base64')}` });
  assert.equal((await call(h, wrong.raw, wrong.headers)).status, 400);

  const stale = signed(sessionCreated(), { at: new Date(Date.now() - 60 * 60_000) });
  assert.equal((await call(h, stale.raw, stale.headers)).status, 400);

  assert.equal((await call(h, good.raw, {})).status, 400);
  const noSig = { ...good.headers };
  delete noSig['svix-signature'];
  assert.equal((await call(h, good.raw, noSig)).status, 400);

  assert.equal(events.length, 0);
});

test('an already-parsed (non-raw) body is refused rather than re-serialized', async () => {
  const { deps } = memoryDeps();
  const h = createClerkWebhookHandler(deps);
  const s = signed(sessionCreated());
  assert.equal((await call(h, JSON.parse(s.raw), s.headers)).status, 400);
});

test('no signing secret → 503 and nothing else happens', async () => {
  const { deps, events } = memoryDeps({ secret: undefined });
  const h = createClerkWebhookHandler(deps);
  const s = signed(sessionCreated());
  const r = await call(h, s.raw, s.headers);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'webhook_disabled');
  assert.equal(events.length, 0);
});

test('a database failure answers 500 so Svix retries', async () => {
  const { deps } = memoryDeps({ record: async () => { throw new Error('db down'); } });
  const h = createClerkWebhookHandler(deps);
  const s = signed(sessionCreated());
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await call(h, s.raw, s.headers)).status, 500);
  } finally {
    console.error = orig;
  }
});

test('verifyClerkWebhook returns the parsed event for a good signature', () => {
  const s = signed(sessionCreated('user_x'));
  const evt = verifyClerkWebhook(s.raw, s.headers, SECRET);
  assert.equal(evt.type, 'session.created');
  assert.equal(evt.data.user_id, 'user_x');
});
