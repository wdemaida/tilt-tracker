import { Router } from 'express';
import {
  ChallengeError, createChallenge, actOnChallengeDetailed, counterChallenge, getChallenge, listChallenges, getRecord, venueOptions, type ListFilter,
} from '../lib/challenges.js';
import { parseDeclineReason } from '../lib/challengeRules.js';
import { recommendationsFor, groupRecommendationsFor } from '../lib/challengeReach.js';
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

// GET /api/challenges/recommendations?users=a,b — machines to challenge several friends on at once:
// ranked by how many of them can reach it, then whether the caller can, then level (pure merge in
// lib/challengeRecs.ts). One user = exactly the /recommendations/:username list. Friends only, zero
// Pinball Map calls. Declared before /:id.
router.get('/recommendations', async (req, res) => {
  const raw = typeof req.query.users === 'string' ? req.query.users : '';
  try {
    res.json(await groupRecommendationsFor((req as any).appUser, raw.split(',')));
  } catch (err) { fail(res, err, 'Load recommendations'); }
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

// POST /api/challenges — body { friendIds: number[] (up to 7) | friendUsernames | friendId |
// friendUsername, type, machineId, matchMode?, venueId?, targetScore?, minPlays?, startsAt?, endsAt }.
// Every invitee must be the caller's friend (403 not_friends); 400 too_many_players / duplicate_invitee.
// 201 with the ChallengeView.
router.post('/', async (req, res) => {
  try {
    const view = await createChallenge((req as any).appUser, req.body ?? {});
    const other = view.opponent;
    const invitees = view.participants.filter(p => !p.isCreator).map(p => p.user.id);
    await logActivity({
      type: 'challenge.created', ...actorOf(req), subjectUserId: other?.id ?? null, targetType: 'challenge', targetId: view.id,
      payload: {
        challengeType: view.type, machineName: view.machine.name, venueId: view.venue?.id ?? null, targetScore: view.targetScore,
        minPlays: view.minPlays, endsAt: view.endsAt, ...(invitees.length > 1 ? { inviteeIds: invitees } : {}),
      },
    });
    res.status(201).json(view);
  } catch (err) { fail(res, err, 'Create challenge'); }
});

// POST /api/challenges/:id/accept | decline | cancel | forfeit | start — 200 with the updated
// ChallengeView. decline takes an optional body { reason: 'cant_reach' | 'no_thanks' } (400
// invalid_reason otherwise); an accepted player may decline too while it's pending (backing out).
// On a PROPOSAL (status 'proposed') the challenger's accept takes it for everyone and decline keeps
// hers. start = "Start with who's in" (the challenger, pending, at least one accepted) — its
// challenge.started event is written inside the transaction, so nothing extra here.
const EVENT = {
  accept: 'challenge.accepted', decline: 'challenge.declined', cancel: 'challenge.cancelled', forfeit: 'challenge.forfeited', start: null,
} as const;

for (const action of ['accept', 'decline', 'cancel', 'forfeit', 'start'] as const) {
  router.post(`/:id/${action}`, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Challenge not found', code: 'challenge_not_found' });
    const reason = action === 'decline' ? parseDeclineReason(req.body) : null;
    if (reason === 'invalid') return res.status(400).json({ error: "reason must be 'cant_reach' or 'no_thanks'", code: 'invalid_reason' });
    try {
      const { view, kind } = await actOnChallengeDetailed(id, (req as any).appUser, action, undefined, { reason });
      const type = kind === 'take' ? 'challenge.counter_accepted' : kind === 'reject' ? 'challenge.counter_rejected' : EVENT[action];
      if (type) {
        await logActivity({
          type, ...actorOf(req), subjectUserId: kind !== 'answer' ? view.proposedBy?.id ?? null : null, targetType: 'challenge', targetId: id,
          payload: {
            challengeType: view.type, machineName: view.machine.name, status: view.status,
            ...(action === 'decline' && kind === 'answer' ? { reason } : {}),
            ...(kind !== 'answer' ? { counteredFromId: view.counteredFromId, ...(kind === 'reject' ? { reason: 'rejected' } : {}) } : {}),
          },
        });
      }
      res.json(view);
    } catch (err) { fail(res, err, `${action[0].toUpperCase()}${action.slice(1)} challenge`); }
  });
}

// POST /api/challenges/:id/counter — "can't get to this one": body is a create body for the counter-
// offer (machineId, type, matchMode?, venueId?, targetScore?, minPlays?, startsAt?, endsAt); invitees
// in it are ignored. It's a PROPOSAL to the challenger (who takes it or keeps hers via /accept and
// /decline on the proposal's id); the original stays pending. 201 with { original, counter } (both
// ChallengeViews; `counter` is the proposal). 409 cannot_counter unless it's pending and waiting on
// the caller.
router.post('/:id/counter', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Challenge not found', code: 'challenge_not_found' });
  try {
    const { original, counter } = await counterChallenge(id, (req as any).appUser, req.body ?? {});
    // No challenge.created for the proposal: it only becomes a challenge if the challenger takes it
    // (challenge.counter_accepted).
    await logActivity({
      type: 'challenge.countered', ...actorOf(req), subjectUserId: original.creatorId, targetType: 'challenge', targetId: id,
      payload: {
        challengeType: original.type, machineName: original.machine.name, reason: 'cant_reach', proposal: true,
        newChallengeId: counter.id, newChallengeType: counter.type, newMachineName: counter.machine.name,
      },
    });
    res.status(201).json({ original, counter });
  } catch (err) { fail(res, err, 'Counter challenge'); }
});

export default router;
