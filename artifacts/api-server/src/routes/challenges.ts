import { Router } from 'express';
import {
  ChallengeError, createChallenge, actOnChallenge, getChallenge, listChallenges, getRecord, venueOptions, type ListFilter,
} from '../lib/challenges.js';

// Challenges (feature/challenges, phase 2). Rules: lib/challengeRules.ts; orchestration:
// lib/challenges.ts. This file only maps HTTP to those and ChallengeError to a status + code.
//
// PRIVACY: a challenge is only visible to its participants — any other id is 404
// challenge_not_found, the same as one that doesn't exist.
//
// Mounted behind requireAppUser in index.ts (`app.use('/api/challenges', requireAppUser, …)`), so
// every handler can rely on req.appUser. Kept out of this file so test-challenges.ts can mount the
// same router behind a stub.
const router = Router();

function fail(res: any, err: unknown, what: string) {
  if (err instanceof ChallengeError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`${what} error:`, err);
  res.status(500).json({ error: `Failed to ${what.toLowerCase()}` });
}

const FILTERS: ListFilter[] = ['pending', 'active', 'history', 'all'];

// GET /api/challenges?status=pending|active|history|all (default all) — the caller's challenges,
// newest first. Each item is a ChallengeView without per-score lists.
router.get('/', async (req, res) => {
  const raw = typeof req.query.status === 'string' ? req.query.status : 'all';
  if (!FILTERS.includes(raw as ListFilter)) return res.status(400).json({ error: 'status must be pending, active, history or all', code: 'invalid_status' });
  try {
    res.json(await listChallenges((req as any).appUser, raw as ListFilter));
  } catch (err) { fail(res, err, 'Load challenges'); }
});

// GET /api/challenges/record — the caller's W/L/T record, streaks and head-to-head.
router.get('/record', async (req, res) => {
  try {
    res.json(await getRecord(null, (req as any).appUser));
  } catch (err) { fail(res, err, 'Load challenge record'); }
});

// GET /api/challenges/record/:username — someone's record (head-to-head only against the caller).
router.get('/record/:username', async (req, res) => {
  try {
    res.json(await getRecord(req.params.username, (req as any).appUser));
  } catch (err) { fail(res, err, 'Load challenge record'); }
});

// GET /api/challenges/venue-options?machineId=&matchMode=game|exact — public venues that have the
// machine (Pinball Map roster, machine history or a score there), for the create form's venue lock.
// Declared before /:id so "venue-options" isn't read as an id.
router.get('/venue-options', async (req, res) => {
  try {
    res.json(await venueOptions(req.query as Record<string, unknown>));
  } catch (err) { fail(res, err, 'Load venue options'); }
});

// GET /api/challenges/:id — detail with live standings and each participant's counting scores.
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Challenge not found', code: 'challenge_not_found' });
  try {
    res.json(await getChallenge(id, (req as any).appUser));
  } catch (err) { fail(res, err, 'Load challenge'); }
});

// POST /api/challenges — body { friendId | friendUsername, type, machineId, matchMode?, venueId?,
// targetScore?, minPlays?, startsAt?, endsAt }. 201 with the ChallengeView.
router.post('/', async (req, res) => {
  try {
    res.status(201).json(await createChallenge((req as any).appUser, req.body ?? {}));
  } catch (err) { fail(res, err, 'Create challenge'); }
});

// POST /api/challenges/:id/accept | decline | cancel | forfeit — 200 with the updated ChallengeView.
for (const action of ['accept', 'decline', 'cancel', 'forfeit'] as const) {
  router.post(`/:id/${action}`, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Challenge not found', code: 'challenge_not_found' });
    try {
      res.json(await actOnChallenge(id, (req as any).appUser, action));
    } catch (err) { fail(res, err, `${action[0].toUpperCase()}${action.slice(1)} challenge`); }
  });
}

export default router;
