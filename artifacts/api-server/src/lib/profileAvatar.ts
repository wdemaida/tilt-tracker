import { db } from '@workspace/db';
import { sql, type SQL } from 'drizzle-orm';
import { getClerkAvatar } from './clerkAdmin.js';

// Profile photos. Clerk hosts them (the browser uploads with user.setProfileImage); we keep Clerk's
// URL on users.image_url so profile reads don't call Clerk. It stays current three ways:
//
//   1. the Clerk `user.updated` webhook (routes/clerkWebhook.ts) — the normal path;
//   2. POST /api/users/me/avatar/sync — the browser calls it right after an upload/remove, so the
//      change shows at once even if the webhook is slow or not subscribed;
//   3. GET /api/users/me kicks a background resync when image_synced_at is null or > 24 h old —
//      bounded to one Clerk call per user per day (plus a 10-minute back-off after a failure).
//
// users.image_synced_at = the Clerk state instant image_url reflects: a webhook's `updated_at`, or
// when a resync STARTED reading Clerk. Every write is guarded `image_synced_at < at`, so a stale
// webhook delivered late (Svix doesn't promise order) or a slow resync can never overwrite newer
// state. (Residual edge: clock skew between Clerk and us of a second or two around a change; the
// next daily resync heals it.)

export const AVATAR_RESYNC_MS = 24 * 60 * 60 * 1000;
export const AVATAR_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

/** Pure: is the stored photo old enough (or never synced) to ask Clerk again? */
export function avatarNeedsResync(syncedAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!syncedAt) return true;
  const t = new Date(syncedAt).getTime();
  return !Number.isFinite(t) || now - t >= AVATAR_RESYNC_MS;
}

/**
 * The guarded write. Returns one row (`previous` = image_url before the write) when it applied, none
 * when the user doesn't exist or already reflects state at least as new as `at`.
 */
export function avatarUpdateSql(clerkId: string, imageUrl: string | null, at: Date): SQL {
  const ts = at.toISOString();
  return sql`
    UPDATE users u
       SET image_url = ${imageUrl}, image_synced_at = ${ts}::timestamptz
      FROM (SELECT id, image_url FROM users WHERE clerk_id = ${clerkId}) o
     WHERE u.id = o.id
       AND (u.image_synced_at IS NULL OR u.image_synced_at < ${ts}::timestamptz)
    RETURNING u.id, o.image_url AS previous`;
}

export interface AvatarApplyResult { applied: boolean; changed: boolean }

type Exec = (q: SQL) => Promise<Array<Record<string, unknown>>>;
const defaultExec: Exec = async q => (await db.execute(q)) as unknown as Array<Record<string, unknown>>;

/** Apply Clerk's photo state as of `at`. Throws on a DB failure (the webhook turns that into a 500). */
export async function applyAvatar(clerkId: string, imageUrl: string | null, at: Date, exec: Exec = defaultExec): Promise<AvatarApplyResult> {
  const rows = await exec(avatarUpdateSql(clerkId, imageUrl, at));
  if (!rows.length) return { applied: false, changed: false };
  return { applied: true, changed: (rows[0].previous ?? null) !== imageUrl };
}

export type AvatarSyncResult = { ok: true; changed: boolean } | { ok: false; error: string };

export interface AvatarSyncDeps {
  fetch: (clerkId: string) => Promise<{ ok: true; imageUrl: string | null } | { ok: false; error: string }>;
  apply: (clerkId: string, imageUrl: string | null, at: Date) => Promise<AvatarApplyResult>;
  now: () => number;
}

const realDeps: AvatarSyncDeps = { fetch: getClerkAvatar, apply: (c, u, at) => applyAvatar(c, u, at), now: () => Date.now() };

const inFlight = new Map<string, Promise<AvatarSyncResult>>();
const failedAt = new Map<string, number>();

/**
 * Read the user's photo from Clerk and store it (guarded). Concurrent calls for one user share one
 * Clerk request. After a failure, non-forced calls (the lazy /me path) back off for 10 minutes;
 * `force` (the explicit sync route) always asks. Never throws.
 */
export function resyncAvatar(clerkId: string, opts: { force?: boolean } = {}, deps: AvatarSyncDeps = realDeps): Promise<AvatarSyncResult> {
  const running = inFlight.get(clerkId);
  if (running) return running;
  const failed = failedAt.get(clerkId);
  if (!opts.force && failed != null && deps.now() - failed < AVATAR_FAILURE_BACKOFF_MS) {
    return Promise.resolve({ ok: false, error: 'backoff' });
  }
  const run = (async (): Promise<AvatarSyncResult> => {
    const startedAt = new Date(deps.now());
    try {
      const r = await deps.fetch(clerkId);
      if (!r.ok) {
        failedAt.set(clerkId, deps.now());
        return { ok: false, error: r.error };
      }
      const applied = await deps.apply(clerkId, r.imageUrl, startedAt);
      failedAt.delete(clerkId);
      return { ok: true, changed: applied.changed };
    } catch (err: any) {
      failedAt.set(clerkId, deps.now());
      console.error('[avatar] resync failed:', err?.message ?? err);
      return { ok: false, error: err?.message ?? String(err) };
    } finally {
      inFlight.delete(clerkId);
    }
  })();
  inFlight.set(clerkId, run);
  return run;
}

/** GET /me's lazy path: fire-and-forget a resync when the stored photo is stale. */
export function kickAvatarResyncIfStale(user: { clerkId: string; imageSyncedAt: Date | string | null }, deps: AvatarSyncDeps = realDeps): boolean {
  if (!avatarNeedsResync(user.imageSyncedAt, deps.now())) return false;
  void resyncAvatar(user.clerkId, {}, deps);
  return true;
}

/** Tests only: forget in-flight and back-off state. */
export function resetAvatarSyncState(): void {
  inFlight.clear();
  failedAt.clear();
}
