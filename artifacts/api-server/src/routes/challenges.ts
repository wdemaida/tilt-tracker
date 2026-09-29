import { Router } from 'express';
import {
  ChallengeError, createChallenge, actOnChallenge, counterChallenge, getChallenge, listChallenges, getRecord, venueOptions, type ListFilter,
} from '../lib/challenges.js';
import { parseDeclineReason } from '../lib/challengeRules.js';
import { recommendationsFor } from '../lib/challengeReach.js';
import { logActivity, actorOf } from '../lib/activity.js';

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

// GET /api/challenges/recommendations/:username — machines to challenge this friend on, by level
// ("Challenge me on" / challenge locations / recent play), each flagged when the caller can reach it
// too. Friends only (403 not_friends). Reads TiltTrack's tables and cached Pinball Map rosters only —
// zero Pinball Map calls (lib/challengeReach.ts). Declared before /:id.
router.get('/recommendations/:username', async (req, res) => {
  try {
    res.json(await recommendationsFor((req as any).appUser, req.params.username));
  } catch (err) { fail(res, err, 'Load recommendations'); }
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
    const view = await createChallenge((req as any).appUser, req.body ?? {});
    const other = view.opponent;
    await logActivity({
      type: 'challenge.created', ...actorOf(req), subjectUserId: other?.id ?? null, targetType: 'challenge', targetId: view.id,
      payload: { challengeType: view.type, machineName: view.machine.name, venueId: view.venue?.id ?? null, targetScore: view.targetScore, minPlays: view.minPlays, endsAt: view.endsAt },
    });
    res.status(201).json(view);
  } catch (err) { fail(res, err, 'Create challenge'); }
});

// POST /api/challenges/:id/accept | decline | cancel | forfeit — 200 with the updated ChallengeView.
// decline takes an optional body { reason: 'cant_reach' | 'no_thanks' } (400 invalid_reason otherwise).
const EVENT = {
  accept: 'challenge.accepted', decline: 'challenge.declined', cancel: 'challenge.cancelled', forfeit: 'challenge.forfeited',
} as const;

for (const action of ['accept', 'decline', 'cancel', 'forfeit'] as const) {
  router.post(`/:id/${action}`, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Challenge not found', code: 'challenge_not_found' });
    const reason = action === 'decline' ? parseDeclineReason(req.body) : null;
    if (reason === 'invalid') return res.status(400).json({ error: "reason must be 'cant_reach' or 'no_thanks'", code: 'invalid_reason' });
    try {
      const view = await actOnChallenge(id, (req as any).appUser, action, undefined, { reason });
      await logActivity({
        type: EVENT[action], ...actorOf(req), targetType: 'challenge', targetId: id,
        payload: { challengeType: view.type, machineName: view.machine.name, status: view.status, ...(action === 'decline' ? { reason } : {}) },
      });
      res.json(view);
    } catch (err) { fail(res, err, `${action[0].toUpperCase()}${action.slice(1)} challenge`); }
  });
}

// POST /api/challenges/:id/counter — "can't get to this one": body is a create body for the counter-
// offer (machineId, type, matchMode?, venueId?, targetScore?, minPlays?, startsAt?, endsAt); the friend
// is always the original's creator. 201 with { original, counter } (both ChallengeViews). 409
// cannot_counter unless it's pending and waiting on the caller.
router.post('/:id/counter', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Challenge not found', code: 'challenge_not_found' });
  try {
    const { original, counter } = await counterChallenge(id, (req as any).appUser, req.body ?? {});
    const other = counter.opponent;
    await logActivity({
      type: 'challenge.countered', ...actorOf(req), subjectUserId: other?.id ?? null, targetType: 'challenge', targetId: id,
      payload: {
        challengeType: original.type, machineName: original.machine.name, reason: 'cant_reach',
        newChallengeId: counter.id, newChallengeType: counter.type, newMachineName: counter.machine.name,
      },
    });
    await logActivity({
      type: 'challenge.created', ...actorOf(req), subjectUserId: other?.id ?? null, targetType: 'challenge', targetId: counter.id,
      payload: {
        challengeType: counter.type, machineName: counter.machine.name, venueId: counter.venue?.id ?? null, targetScore: counter.targetScore,
        minPlays: counter.minPlays, endsAt: counter.endsAt, counteredFromId: id,
      },
    });
    res.status(201).json({ original, counter });
  } catch (err) { fail(res, err, 'Counter challenge'); }
});

export default router;
