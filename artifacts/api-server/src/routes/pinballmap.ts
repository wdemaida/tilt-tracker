import { Router } from 'express';
import { db, users, venues } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';
import { getPmUserToken, getPmMachinesAtLocation, submitPmScore } from '../lib/pinballmapApi.js';

const router = Router();

// GET /api/pinballmap/token — check if the current user has a stored PM token
router.get('/token', requireAppUser, (req, res) => {
  const user = (req as any).appUser;
  res.json({ hasToken: !!user.pinballMapToken, pmUsername: user.pinballMapUsername ?? null });
});

// POST /api/pinballmap/auth — exchange PM credentials for a token and persist it
router.post('/auth', requireAppUser, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const result = await getPmUserToken(email, password);
  if (!result) return res.status(401).json({ error: 'Invalid Pinball Map credentials' });

  const user = (req as any).appUser;
  await db.update(users)
    .set({ pinballMapToken: result.token, pinballMapUsername: result.username })
    .where(eq(users.id, user.id));

  res.json(result);
});

// POST /api/pinballmap/submit-score
// Body: { venueId, machineName, score, userToken? }
// Uses stored token if userToken is omitted.
router.post('/submit-score', requireAppUser, async (req, res) => {
  const { venueId, machineName, score } = req.body;
  const user = (req as any).appUser;
  const userToken: string | undefined = req.body.userToken ?? user.pinballMapToken ?? undefined;
  const usingStoredToken = !req.body.userToken && !!user.pinballMapToken;

  if (!userToken || !venueId || !machineName || !score) {
    return res.status(400).json({ error: 'venueId, machineName, and score are required; no Pinball Map token available' });
  }

  try {
    const [venue] = await db.select().from(venues).where(eq(venues.id, Number(venueId))).limit(1);
    if (!venue?.pinballMapId) {
      return res.status(422).json({ error: 'This venue is not linked to Pinball Map' });
    }

    const xrefs = await getPmMachinesAtLocation(venue.pinballMapId);
    const needle = machineName.toLowerCase();
    const xref = xrefs.find(x =>
      x.machine.name.toLowerCase().includes(needle) || needle.includes(x.machine.name.toLowerCase())
    );

    if (!xref) {
      return res.status(422).json({ error: `"${machineName}" not found on Pinball Map at this venue` });
    }

    const ok = await submitPmScore(userToken, xref.id, Number(score));
    if (!ok) {
      if (usingStoredToken) {
        await db.update(users).set({ pinballMapToken: null }).where(eq(users.id, user.id));
        return res.status(401).json({ error: 'Pinball Map session expired — please re-enter credentials', code: 'PM_TOKEN_EXPIRED' });
      }
      return res.status(502).json({ error: 'Pinball Map rejected the score submission' });
    }

    res.json({ success: true, machineName: xref.machine.name, xrefId: xref.id });
  } catch (err) {
    console.error('PM submit-score error:', err);
    res.status(500).json({ error: 'Failed to submit score to Pinball Map' });
  }
});

export default router;
