import { Router } from 'express';
import { ChallengeError } from '../lib/challenges.js';
import { getChallengePrefs, updateChallengePrefs } from '../lib/challengeReach.js';
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

export default router;
