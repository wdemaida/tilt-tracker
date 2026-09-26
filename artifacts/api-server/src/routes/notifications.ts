import { Router } from 'express';
import { db, notifications } from '@workspace/db';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';

// The notifications inbox — reading side (feature/friends, phase 1). Writing is lib/notify.ts.
//
// PRIVACY: every query is `user_id = <caller>`. Someone else's notification id is a 404, the same
// as one that doesn't exist.
//
// Mounted behind requireAppUser in index.ts, like /api/friends and /api/pods.
const router = Router();

const PAGE_MAX = 50;

// GET /api/notifications?limit=20&before=<id> — newest first, keyset-paged on id. Ids are creation
// order: a re-raised notification is replaced with a new row, never bumped in place (lib/notify.ts).
// Answers { items, nextBefore } — pass nextBefore back as `before` for the next page; null = done.
router.get('/', async (req, res) => {
  const me = (req as any).appUser;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), PAGE_MAX);
  const before = Number(req.query.before);
  try {
    const rows = await db
      .select({
        id: notifications.id, kind: notifications.kind, payload: notifications.payload,
        createdAt: notifications.createdAt, readAt: notifications.readAt,
      })
      .from(notifications)
      .where(and(
        eq(notifications.userId, me.id),
        Number.isInteger(before) && before > 0 ? lt(notifications.id, before) : undefined,
      ))
      .orderBy(desc(notifications.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    res.json({ items: page, nextBefore: rows.length > limit ? rows[limit - 1].id : null });
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// GET /api/notifications/unread-count — { count }. What the header bell polls.
router.get('/unread-count', async (req, res) => {
  const me = (req as any).appUser;
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(notifications)
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)));
    res.json({ count });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Failed to load unread count' });
  }
});

// POST /api/notifications/read-all — marks every unread notification of the caller's read.
router.post('/read-all', async (req, res) => {
  const me = (req as any).appUser;
  try {
    const updated = await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    res.json({ updated: updated.length });
  } catch (err) {
    console.error('Read all notifications error:', err);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// POST /api/notifications/:id/read — marks one read. Idempotent; 404 unless it's the caller's.
router.post('/:id/read', async (req, res) => {
  const me = (req as any).appUser;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Notification not found', code: 'notification_not_found' });
  try {
    const [row] = await db.update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, id), eq(notifications.userId, me.id)))
      .returning({ id: notifications.id, readAt: notifications.readAt });
    if (!row) return res.status(404).json({ error: 'Notification not found', code: 'notification_not_found' });
    res.json(row);
  } catch (err) {
    console.error('Read notification error:', err);
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

export default router;
