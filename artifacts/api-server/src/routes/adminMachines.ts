import { Router } from 'express';
import { fromReq } from '../lib/activity.js';
import {
  MachineMergeError, applyMachineMerge, mergeCandidates, parseMachineId, previewMachineMerge,
} from '../lib/machineMerge.js';

// Admin machine merge — "Fix this machine" on /machines/:name (mounted inside routes/admin.ts, so every
// route here is behind requireAppUser + requireAdmin; adminAuth.test.ts walks this router too). The
// rules live in lib/machineMerge.ts. Zero Pinball Map calls: the catalog is the stored copy.
//
//   GET  /machines/:id/merge-candidates?q=  → { source, suggestion, results, catalogAvailable }
//   POST /machines/:id/merge { targetId | targetName, dryRun?, confirmDifferentTitle?, expectedScoreCount? }
//        dryRun → the preview (no writes); else the merge, one transaction → result (admin.machine_merged)

const router = Router();

function fail(res: any, what: string, err: unknown) {
  if (err instanceof MachineMergeError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  }
  console.error(`admin ${what} error:`, err);
  return res.status(500).json({ error: `Failed to ${what}` });
}

router.get('/machines/:id/merge-candidates', async (req, res) => {
  const id = parseMachineId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Machine not found', code: 'machine_not_found' });
  try {
    res.json(await mergeCandidates(id, typeof req.query.q === 'string' ? req.query.q : ''));
  } catch (err) {
    fail(res, 'load merge candidates', err);
  }
});

router.post('/machines/:id/merge', async (req, res) => {
  const id = parseMachineId(req.params.id);
  if (id == null) return res.status(404).json({ error: 'Machine not found', code: 'machine_not_found' });
  const body = req.body ?? {};
  try {
    if (body.dryRun === true) return void res.json({ preview: await previewMachineMerge(id, body) });
    res.json({ merged: true, ...(await applyMachineMerge(id, body, fromReq(req))) });
  } catch (err) {
    fail(res, 'merge machines', err);
  }
});

export default router;
