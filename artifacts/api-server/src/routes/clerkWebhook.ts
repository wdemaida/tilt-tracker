import type { Request, Response } from 'express';
import { Webhook, WebhookVerificationError } from 'svix';
import { db, users } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { insertActivity, type ActivityInput } from '../lib/activity.js';

// POST /api/webhooks/clerk — Clerk → Svix → here. Records every sign-in and sign-up in the activity
// log (Clerk is the only place a sign-in is observable; the app never sees the password step).
//
//   session.created → user.signed_in   (actor = our user if they have a profile yet)
//   user.created    → user.signed_up
//   user.deleted    → user.clerk_deleted (our users row is left alone)
//   anything else   → 200, ignored
//
// NO app auth: the Svix signature IS the auth (svix-id / svix-timestamp / svix-signature headers
// over the exact raw body, with CLERK_WEBHOOK_SIGNING_SECRET). A bad or stale signature is 400.
// Mounted in index.ts with express.raw() BEFORE express.json(), so the body is still the raw bytes.
// Idempotent: Svix retries a delivery with the same svix-id, and activity_events.svix_id is UNIQUE,
// so a retry is a no-op 200. A database failure answers 500 so Svix retries later.
// Without the secret the route answers 503 (logged once at startup) and nothing else is affected.

export interface ClerkWebhookDeps {
  secret: string | undefined;
  /** Our users.id for a Clerk user id, if they've set up a profile. */
  resolveUserId: (clerkId: string) => Promise<number | null>;
  /** Insert an event; returns null when svixId was already recorded. Throws on failure. */
  record: (ev: ActivityInput) => Promise<number | null>;
}

type ClerkEvent = { type: string; data: Record<string, any> };

/** Verify and parse. Throws WebhookVerificationError on a bad signature. */
export function verifyClerkWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string): ClerkEvent {
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  // svix 2.x verify() checks the signature and timestamp (5-minute tolerance) and returns nothing;
  // the body is parsed only after it passes.
  new Webhook(secret).verify(rawBody, {
    'svix-id': h('svix-id') ?? '',
    'svix-timestamp': h('svix-timestamp') ?? '',
    'svix-signature': h('svix-signature') ?? '',
  });
  const evt = JSON.parse(rawBody) as ClerkEvent;
  if (!evt || typeof evt.type !== 'string') throw new WebhookVerificationError('Not a Clerk event');
  return evt;
}

const iso = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

/** Pure-ish mapping from a verified Clerk event to the activity row (null = not logged). */
export async function eventFor(evt: ClerkEvent, svixId: string, resolveUserId: ClerkWebhookDeps['resolveUserId']): Promise<ActivityInput | null> {
  const d = evt.data ?? {};
  switch (evt.type) {
    case 'session.created': {
      const clerkId: string | undefined = d.user_id;
      if (!clerkId) return null;
      const a = d.latest_activity ?? {};
      const ua = [a.browser_name, a.browser_version].filter(Boolean).join(' ') + (a.device_type ? ` (${a.device_type})` : '');
      return {
        type: 'user.signed_in',
        actorUserId: await resolveUserId(clerkId),
        targetType: 'clerk_user',
        targetId: clerkId,
        payload: {
          sessionId: d.id ?? null,
          at: iso(d.created_at),
          isMobile: a.is_mobile ?? null,
          city: a.city ?? null,
          country: a.country ?? null,
        },
        ip: a.ip_address ?? null,
        userAgent: ua.trim() || null,
        svixId,
      };
    }
    case 'user.created': {
      const clerkId: string | undefined = d.id;
      if (!clerkId) return null;
      return {
        type: 'user.signed_up',
        actorUserId: await resolveUserId(clerkId),
        targetType: 'clerk_user',
        targetId: clerkId,
        payload: {
          at: iso(d.created_at),
          // Which sign-up path — no addresses, just the kind.
          method: Array.isArray(d.external_accounts) && d.external_accounts.length
            ? String(d.external_accounts[0]?.provider ?? 'oauth')
            : (Array.isArray(d.email_addresses) && d.email_addresses.length ? 'email' : 'other'),
        },
        svixId,
      };
    }
    case 'user.deleted': {
      const clerkId: string | undefined = d.id;
      if (!clerkId) return null;
      return {
        type: 'user.clerk_deleted',
        subjectUserId: await resolveUserId(clerkId),
        targetType: 'clerk_user',
        targetId: clerkId,
        payload: {},
        svixId,
      };
    }
    default:
      return null;
  }
}

export function createClerkWebhookHandler(deps: ClerkWebhookDeps) {
  return async (req: Request, res: Response) => {
    if (!deps.secret) return void res.status(503).json({ error: 'Clerk webhook not configured', code: 'webhook_disabled' });

    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : null;
    if (raw == null) return void res.status(400).json({ error: 'Expected a raw body', code: 'bad_body' });

    let evt: ClerkEvent;
    try {
      evt = verifyClerkWebhook(raw, req.headers, deps.secret);
    } catch (err) {
      if (!(err instanceof WebhookVerificationError)) console.error('[clerk-webhook] verify error:', (err as any)?.message ?? err);
      return void res.status(400).json({ error: 'Invalid signature', code: 'bad_signature' });
    }

    const svixId = String(req.headers['svix-id']);
    try {
      const ev = await eventFor(evt, svixId, deps.resolveUserId);
      if (!ev) return void res.json({ ok: true, ignored: evt.type });
      const id = await deps.record(ev);
      res.json({ ok: true, duplicate: id == null });
    } catch (err: any) {
      console.error(`[clerk-webhook] failed to record ${evt.type}:`, err?.message ?? err);
      res.status(500).json({ error: 'Failed to record event' });
    }
  };
}

async function resolveUserId(clerkId: string): Promise<number | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return u?.id ?? null;
}

export const clerkWebhookHandler = createClerkWebhookHandler({
  get secret() { return process.env.CLERK_WEBHOOK_SIGNING_SECRET || undefined; },
  resolveUserId,
  record: ev => insertActivity(ev),
});

export function logClerkWebhookStatus(): void {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
    console.warn('[clerk-webhook] CLERK_WEBHOOK_SIGNING_SECRET not set — POST /api/webhooks/clerk answers 503; sign-ins are not being logged.');
  }
}
