import { Router } from 'express';
import { ChallengeError } from '../lib/challenges.js';
import { getChallengePrefs, updateChallengePrefs, searchChallengeVenues } from '../lib/challengeReach.js';
import { SlidingRateLimiter } from '../lib/nearbyLookup.js';
import { SEARCH_RATE_WINDOWS } from '../lib/venueSearch.js';
import { logActivity, actorOf } from '../lib/activity.js';

// The caller's own settings that aren't the profile itself (feature/challenge-recs). Mounted behind
// requireAppUser in index.ts (`app.use('/api/me', requireAppUser, …)`), so req.appUser is set; kept
// out of index.ts so test-challenges.ts can mount it behind a stub.
const router = Router();

function fail(res: any, err: unknown, what: string) {
  if (err instanceof ChallengeError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`${what} error:`, err);
  res.status(500).json({ error: `Failed to ${what.toLowerCase()}` });
}

// GET /api/me/challenge-prefs — "Challenge me on" machines (max 3), challenge locations (seeded once
// from your history on first read) and suggested locations to add. Only ever the caller's own.
router.get('/challenge-prefs', async (req, res) => {
  try {
    res.json(await getChallengePrefs((req as any).appUser.id));
  } catch (err) { fail(res, err, 'Load challenge preferences'); }
});

// PUT /api/me/challenge-prefs { machineIds?: number[] (max 3), venueIds?: number[] } — replaces
// whichever list is sent. 400 too_many_machines / machine_not_found / venue_not_found / invalid_prefs.
router.put('/challenge-prefs', async (req, res) => {
  try {
    const { prefs, changed } = await updateChallengePrefs((req as any).appUser.id, req.body ?? {});
    await logActivity({
      type: 'profile.challenge_prefs_updated', ...actorOf(req), targetType: 'user', targetId: (req as any).appUser.id,
      payload: { ...changed, machineCount: prefs.machines.length, venueCount: prefs.venues.length },
    });
    res.json(prefs);
  } catch (err) { fail(res, err, 'Save challenge preferences'); }
});

// GET /api/me/challenge-venue-search?q= — venues you could add as a challenge location, from
// TiltTrack's own venues table only (zero Pinball Map / HERE calls). Public venues, your own, or one
// you've scored at — never a stranger's private venue. Same per-user limit as the Add Score search.
const venueSearchLimiter = new SlidingRateLimiter(SEARCH_RATE_WINDOWS);
setInterval(() => venueSearchLimiter.sweep(), 10 * 60_000).unref();

router.get('/challenge-venue-search', async (req, res) => {
  const userId = (req as any).appUser.id as number;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const decision = venueSearchLimiter.take(String(userId));
  if (!decision.ok) {
    res.setHeader('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many venue searches — wait a moment and try again', code: 'rate_limited' });
  }
  try {
    res.json(await searchChallengeVenues(userId, q));
  } catch (err) { fail(res, err, 'Search venues'); }
});

export default router;
