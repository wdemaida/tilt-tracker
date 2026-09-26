import { requireAuth as clerkRequireAuth, getAuth } from '@clerk/express';
import { db, users, type User } from '@workspace/db';
import { eq } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';

export const requireAuth = clerkRequireAuth();

// How the middleware below finds the caller. Swappable only for unit tests (setAuthForTests), so the
// real guards — not copies of them — can be exercised without Clerk or a database.
let resolveClerkId: (req: Request) => string | null | undefined = req => getAuth(req).userId;
let loadUserByClerkId: (clerkId: string) => Promise<User | undefined> = async clerkId => {
  const [user] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
  return user;
};

export function setAuthForTests(hooks: {
  resolveClerkId?: (req: Request) => string | null | undefined;
  loadUser?: (clerkId: string) => Promise<User | undefined>;
}): void {
  if (hooks.resolveClerkId) resolveClerkId = hooks.resolveClerkId;
  if (hooks.loadUser) loadUserByClerkId = hooks.loadUser;
}

export const ACCOUNT_DISABLED = {
  error: 'This account has been disabled. Contact the TiltTrack admin if you think this is a mistake.',
  code: 'account_disabled',
} as const;

/** Pure: the refusal for a signed-in caller's row, or null to let them through. Unit-tested. */
export function appUserRefusal(user: Pick<User, 'disabledAt'> | undefined): { status: number; body: Record<string, string> } | null {
  if (!user) return { status: 403, body: { error: 'Profile not set up', code: 'NO_PROFILE' } };
  if (user.disabledAt) return { status: 403, body: { ...ACCOUNT_DISABLED } };
  return null;
}

// Attaches req.appUser (our DB user row) after verifying Clerk auth. A disabled account (admin
// "disable", users.disabled_at) is refused here with 403 account_disabled — which covers every
// route behind requireAppUser, admin routes included.
export async function requireAppUser(req: Request, res: Response, next: NextFunction) {
  const clerkId = resolveClerkId(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const user = await loadUserByClerkId(clerkId);
  const refusal = appUserRefusal(user);
  if (refusal) return res.status(refusal.status).json(refusal.body);

  (req as any).appUser = user;
  next();
}

// For routers that authenticate with requireAuth only (e.g. /api/upload): lets anonymous and
// profile-less callers through untouched, but refuses a disabled account.
export async function rejectDisabledUser(req: Request, res: Response, next: NextFunction) {
  try {
    const clerkId = resolveClerkId(req);
    if (clerkId) {
      const user = await loadUserByClerkId(clerkId);
      if (user?.disabledAt) return res.status(403).json({ ...ACCOUNT_DISABLED });
    }
  } catch (err) {
    return next(err);
  }
  next();
}

// Must follow requireAppUser — rejects non-admins with 403
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as any).appUser?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
