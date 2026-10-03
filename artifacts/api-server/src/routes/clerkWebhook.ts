import type { Request, Response } from 'express';
import { Webhook, WebhookVerificationError } from 'svix';
import { db, users } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { insertActivity, isActivityRecorded, type ActivityInput } from '../lib/activity.js';
import { onSignInBadges } from '../lib/badges.js';
import { avatarFromClerk, clerkInstant } from '../lib/profileFields.js';
import { applyAvatar } from '../lib/profileAvatar.js';

// POST /api/webhooks/clerk — Clerk → Svix → here. Records every sign-in and sign-up in the activity
// log (Clerk is the only place a sign-in is observable; the app never sees the password step).
//
//   session.created → user.signed_in   (actor = our user if they have a profile yet), plus the
//                     badges' login_days mark (one per Eastern day) — written even when the
//                     retention gate below doesn't record the event, and on a Svix retry (idempotent)
//   user.created    → user.signed_up
//   user.deleted    → user.clerk_deleted (our users row is left alone)
//   user.updated    → users.image_url / image_synced_at (profile photo; guarded against
//                     out-of-order delivery by updated_at; no activity row)
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
  /** Whether this event type is recorded at all (its retention tier isn't 0). Default: always. */
  shouldRecord?: (type: string) => Promise<boolean>;
  /** A sign-in by a user with a profile (badges: login_days). Must not throw; failures are logged. */
  onSignedIn?: (userId: number, at: Date) => Promise<void>;
  /** user.updated: store the profile photo as of `at` (Clerk's updated_at), guarded against an
   *  out-of-order delivery. Throws on a DB failure (→ 500, Svix retries). Absent = ignored. */
  onUserUpdated?: (clerkId: string, imageUrl: string | null, at: Date) => Promise<{ applied: boolean }>;
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

    // user.updated: keep users.image_url current (profileAvatar.ts). No activity row — Clerk sends
    // this for any change to the user, and a photo change isn't worth the log. A retried or
    // out-of-order delivery is harmless: the write only applies when updated_at is newer than what
    // the row already reflects.
    if (evt.type === 'user.updated') {
      const clerkId = typeof evt.data?.id === 'string' ? evt.data.id : null;
      if (!clerkId || !deps.onUserUpdated) return void res.json({ ok: true, ignored: evt.type });
      try {
        const r = await deps.onUserUpdated(clerkId, avatarFromClerk(evt.data), clerkInstant(evt.data?.updated_at) ?? new Date());
        return void res.json({ ok: true, avatarApplied: r.applied });
      } catch (err: any) {
        console.error('[clerk-webhook] failed to apply user.updated:', err?.message ?? err);
        return void res.status(500).json({ error: 'Failed to apply user.updated' });
      }
    }

    try {
      const ev = await eventFor(evt, svixId, deps.resolveUserId);
      if (!ev) return void res.json({ ok: true, ignored: evt.type });
      // Before the retention gate: a login day counts for badges whether or not sign-ins are logged.
      if (ev.type === 'user.signed_in' && ev.actorUserId && deps.onSignedIn) {
        const at = typeof evt.data?.created_at === 'number' && evt.data.created_at > 0 ? new Date(evt.data.created_at) : new Date();
        try {
          await deps.onSignedIn(ev.actorUserId, at);
        } catch (err: any) {
          console.error('[clerk-webhook] sign-in badge hook failed:', err?.message ?? err);
        }
      }
      // Its retention tier is set to 0 ("don't record"): acknowledge so Svix doesn't retry.
      if (deps.shouldRecord && !(await deps.shouldRecord(ev.type))) return void res.json({ ok: true, notRecorded: ev.type });
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
  shouldRecord: isActivityRecorded,
  onSignedIn: onSignInBadges,
  onUserUpdated: (clerkId, imageUrl, at) => applyAvatar(clerkId, imageUrl, at),
});

export function logClerkWebhookStatus(): void {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
    console.warn('[clerk-webhook] CLERK_WEBHOOK_SIGNING_SECRET not set — POST /api/webhooks/clerk answers 503; sign-ins are not being logged.');
  }
}
