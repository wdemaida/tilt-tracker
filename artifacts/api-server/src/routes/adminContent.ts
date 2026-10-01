import { Router } from 'express';
import { db } from '@workspace/db';
import { fromReq, logActivity } from '../lib/activity.js';
import {
  CONTENT_SPEC, CONTENT_KEYS, isContentKey, validateContent, listStoredContent, getStoredContent, saveContent,
  resetContent, clearPublicContentCache, changedFields,
} from '../lib/siteContent.js';

// Admin editor for public page copy — /api/admin/content (mounted inside routes/admin.ts, so every
// route here is behind requireAppUser + requireAdmin; adminAuth.test.ts walks this router too).

const router = Router();

function fail500(res: any, what: string, err: unknown) {
  console.error(`admin ${what} error:`, err);
  res.status(500).json({ error: `Failed to ${what}` });
}

// GET /api/admin/content — every editable section: its spec (the editor builds its form from it), the
// stored override (null = showing the default) and who last edited it. A missing table (migrate28 not
// run yet) answers 503 `content_unavailable`, so the editor can say so instead of a generic failure.
router.get('/content', async (_req, res) => {
  try {
    const stored = new Map((await listStoredContent()).map(r => [r.key, r]));
    res.json({
      sections: CONTENT_KEYS.map(key => {
        const row = stored.get(key);
        return {
          key, spec: CONTENT_SPEC[key],
          value: row?.value ?? null,
          updatedAt: row?.updatedAt ?? null,
          updatedBy: row?.updatedBy ?? null,
        };
      }),
    });
  } catch (err: any) {
    if (err?.code === '42P01' || err?.cause?.code === '42P01') {
      return void res.status(503).json({ error: 'The site_content table does not exist yet (run migrate28).', code: 'content_unavailable' });
    }
    fail500(res, 'load site content', err);
  }
});

// PUT /api/admin/content/:key {value} — validate, then store the override. 400 with per-field errors
// ({"steps.1.body": "Text is required"}) when the value doesn't fit the spec.
router.put('/content/:key', async (req, res) => {
  const key = req.params.key;
  if (!isContentKey(key)) return void res.status(404).json({ error: 'Unknown content key', code: 'unknown_key' });
  const v = validateContent(key, req.body?.value);
  if (!v.ok) return void res.status(400).json({ error: Object.values(v.errors)[0], code: 'invalid_content', errors: v.errors });
  try {
    await db.transaction(async tx => {
      const before = await getStoredContent(key, tx);
      // Payload: which fields changed, not the copy itself (it can be long; the row holds the value).
      // `contentKey`, not `key` — sanitizePayload drops a field named exactly "key".
      await logActivity({
        type: 'admin.content_updated', ...fromReq(req), targetType: 'site_content', targetId: key,
        payload: { contentKey: key, wasDefault: before == null, fields: changedFields(before, v.value) },
      }, { tx });
      await saveContent(key, v.value, (req as any).appUser.id, tx);
    });
    clearPublicContentCache();
    const row = (await listStoredContent()).find(r => r.key === key);
    res.json({ key, value: row?.value ?? v.value, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null });
  } catch (err) { fail500(res, 'save site content', err); }
});

// DELETE /api/admin/content/:key — drop the override; the page goes back to its built-in default.
router.delete('/content/:key', async (req, res) => {
  const key = req.params.key;
  if (!isContentKey(key)) return void res.status(404).json({ error: 'Unknown content key', code: 'unknown_key' });
  try {
    const removed = await db.transaction(async tx => {
      const gone = await resetContent(key, tx);
      if (gone) {
        await logActivity({
          type: 'admin.content_reset', ...fromReq(req), targetType: 'site_content', targetId: key,
          payload: { contentKey: key },
        }, { tx });
      }
      return gone;
    });
    clearPublicContentCache();
    res.json({ key, value: null, updatedAt: null, updatedBy: null, removed });
  } catch (err) { fail500(res, 'reset site content', err); }
});

export default router;
