import { Router } from 'express';
import { fromReq } from '../lib/activity.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import {
  normalizeAnnouncement, parseAudience, audienceKey, resolveRecipients, findDuplicate, sendAnnouncement,
  listAnnouncements, retractAnnouncement, isAnnouncementId, parseRequestId,
  TITLE_MAX, BODY_MAX, LINK_MAX, MAX_PICKED, LINK_ROOTS, SAMPLE_SIZE, SENDS_PER_HOUR,
} from '../lib/announcements.js';

// Admin announcements — /api/admin/announcements (mounted inside routes/admin.ts, so every route here
// is behind requireAppUser + requireAdmin; adminAuth.test.ts walks this router too). The rules live
// in lib/announcements.ts.
//
//   POST   /announcements/preview          → normalised text, recipient count + sample, skipped, duplicateOf. No writes.
//   POST   /announcements                  → send (confirmCount must match; requestId de-duplicates; 10/hour/admin)
//   GET    /announcements?before=<id>      → history, newest first, with live delivered/unread counts
//   DELETE /announcements/:announcementId  → retract (delete the remaining notifications)

const router = Router();

const sendLimiter = createRateLimiter({ limit: SENDS_PER_HOUR, windowMs: 60 * 60 * 1000 });

function fail500(res: any, what: string, err: unknown) {
  console.error(`admin ${what} error:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
}

/** Validate text + audience from a body; on failure the 400 has already been sent. */
function parseBody(req: any, res: any) {
  const b = req.body ?? {};
  const text = normalizeAnnouncement({ title: b.title, body: b.body, link: b.link });
  if (!text.ok) {
    res.status(400).json({ error: Object.values(text.errors)[0], code: 'invalid_announcement', errors: text.errors });
    return null;
  }
  const audience = parseAudience({ audience: b.audience, userIds: b.userIds });
  if (!audience.ok) {
    res.status(400).json({ error: audience.error, code: audience.code, errors: { audience: audience.error } });
    return null;
  }
  return { text: text.value, audience: audience.value };
}

// GET /api/admin/announcements/limits — the editor's counters and link rule (no DB).
router.get('/announcements/limits', (_req, res) => {
  res.json({ titleMax: TITLE_MAX, bodyMax: BODY_MAX, linkMax: LINK_MAX, maxPicked: MAX_PICKED, linkRoots: LINK_ROOTS, sendsPerHour: SENDS_PER_HOUR });
});

router.post('/announcements/preview', async (req, res) => {
  const parsed = parseBody(req, res);
  if (!parsed) return;
  try {
    const { recipients, skipped } = await resolveRecipients(parsed.audience);
    const duplicateOf = await findDuplicate({
      requestId: null, title: parsed.text.title, body: parsed.text.body, audienceKey: audienceKey(parsed.audience),
    });
    res.json({
      normalized: parsed.text,
      audience: parsed.audience.audience,
      recipientCount: recipients.length,
      sample: recipients.slice(0, SAMPLE_SIZE),
      skipped,
      duplicateOf,
    });
  } catch (err) { fail500(res, 'preview announcement', err); }
});

router.post('/announcements', async (req, res) => {
  const parsed = parseBody(req, res);
  if (!parsed) return;
  const confirmCount = Number(req.body?.confirmCount);
  if (!Number.isSafeInteger(confirmCount) || confirmCount < 1) {
    return void res.status(400).json({ error: 'Preview first: confirmCount is the recipient count you confirmed', code: 'confirm_required' });
  }
  const admin = (req as any).appUser;
  const limit = sendLimiter.hit(admin.id);
  if (!limit.allowed) {
    const retryAfterSec = Math.ceil(limit.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return void res.status(429).json({ error: `At most ${SENDS_PER_HOUR} announcements an hour. Try again later.`, code: 'rate_limited', retryAfterSec });
  }
  try {
    const r = await sendAnnouncement(admin.id, {
      text: parsed.text, audience: parsed.audience, confirmCount,
      requestId: parseRequestId(req.body?.requestId), allowDuplicate: req.body?.allowDuplicate === true,
    }, fromReq(req));
    if (!r.ok) return void res.status(r.status).json(r.body);
    res.status(201).json({ announcementId: r.announcementId, sent: r.sent, skipped: r.skipped });
  } catch (err) { fail500(res, 'send announcement', err); }
});

router.get('/announcements', async (req, res) => {
  const before = Number(req.query.before);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  try {
    res.json(await listAnnouncements(Number.isSafeInteger(before) && before > 0 ? before : null, limit));
  } catch (err) { fail500(res, 'load announcements', err); }
});

router.delete('/announcements/:announcementId', async (req, res) => {
  const id = req.params.announcementId;
  if (!isAnnouncementId(id)) return void res.status(404).json({ error: 'Announcement not found', code: 'announcement_not_found' });
  try {
    const r = await retractAnnouncement(id.toLowerCase(), fromReq(req));
    res.status(r.status).json(r.body);
  } catch (err) { fail500(res, 'retract announcement', err); }
});

export default router;
