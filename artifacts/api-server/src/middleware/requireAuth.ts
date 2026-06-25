import { requireAuth as clerkRequireAuth, getAuth } from '@clerk/express';
import { db, users } from '@workspace/db';
import { eq } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';

export const requireAuth = clerkRequireAuth();

// Attaches req.appUser (our DB user row) after verifying Clerk auth
export async function requireAppUser(req: Request, res: Response, next: NextFunction) {
  const { userId: clerkId } = getAuth(req);
  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const [user] = await db.select().from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (!user) return res.status(403).json({ error: 'Profile not set up', code: 'NO_PROFILE' });

  (req as any).appUser = user;
  next();
}

// Must follow requireAppUser — rejects non-admins with 403
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if ((req as any).appUser?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
