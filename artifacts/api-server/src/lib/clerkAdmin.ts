import { createClerkClient } from '@clerk/express';

// Admin-only Clerk Backend API calls: sign-in/activity timestamps for the admin users view, and
// ban/unban for "disable account". Uses CLERK_SECRET_KEY (already required by clerkMiddleware).
//
// Activity lookups are batched (one getUserList call per 100 ids) and cached per user for 60 s, so
// paging around the admin area doesn't fan out to Clerk. Every failure degrades to "unknown" —
// the admin page still renders from our own data.

export interface ClerkActivity {
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  banned: boolean;
}

export interface ClerkAdminBackend {
  listUsers(clerkIds: string[]): Promise<Array<{ id: string; lastSignInAt: number | null; lastActiveAt: number | null; banned: boolean }>>;
  ban(clerkId: string): Promise<void>;
  unban(clerkId: string): Promise<void>;
}

function realBackend(): ClerkAdminBackend | null {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  const client = createClerkClient({ secretKey });
  return {
    async listUsers(ids) {
      const res = await client.users.getUserList({ userId: ids, limit: Math.min(ids.length, 100) });
      return res.data.map(u => ({ id: u.id, lastSignInAt: u.lastSignInAt, lastActiveAt: u.lastActiveAt, banned: u.banned }));
    },
    async ban(id) { await client.users.banUser(id); },
    async unban(id) { await client.users.unbanUser(id); },
  };
}

let backendOverride: ClerkAdminBackend | null | undefined;
let backendCache: ClerkAdminBackend | null | undefined;
function backend(): ClerkAdminBackend | null {
  if (backendOverride !== undefined) return backendOverride;
  if (backendCache === undefined) backendCache = realBackend();
  return backendCache;
}

export function setClerkAdminForTests(b: ClerkAdminBackend | null | undefined): void {
  backendOverride = b;
  cache.clear();
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: ClerkActivity | null }>();

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/**
 * Clerk activity for each id. Absent from the map = Clerk couldn't be asked (no key / error);
 * present with null = Clerk has no such user.
 */
export async function getClerkActivity(clerkIds: string[], now = Date.now()): Promise<Map<string, ClerkActivity | null>> {
  const out = new Map<string, ClerkActivity | null>();
  const b = backend();
  if (!b) return out;
  const missing: string[] = [];
  for (const id of new Set(clerkIds)) {
    const hit = cache.get(id);
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.value);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    try {
      const rows = await b.listUsers(chunk);
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const id of chunk) {
        const r = byId.get(id);
        const value = r ? { lastSignInAt: iso(r.lastSignInAt), lastActiveAt: iso(r.lastActiveAt), banned: r.banned } : null;
        cache.set(id, { at: now, value });
        out.set(id, value);
      }
    } catch (err: any) {
      console.error('[clerk-admin] user lookup failed:', err?.status ?? '', err?.message ?? err);
    }
  }
  return out;
}

/** Ban (true) or unban (false). Returns an error message instead of throwing. */
export async function setClerkBan(clerkId: string, banned: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const b = backend();
  if (!b) return { ok: false, error: 'CLERK_SECRET_KEY is not set' };
  try {
    if (banned) await b.ban(clerkId);
    else await b.unban(clerkId);
    cache.delete(clerkId);
    return { ok: true };
  } catch (err: any) {
    const msg = err?.errors?.[0]?.message ?? err?.message ?? String(err);
    console.error(`[clerk-admin] ${banned ? 'ban' : 'unban'} failed:`, err?.status ?? '', msg);
    return { ok: false, error: msg };
  }
}
