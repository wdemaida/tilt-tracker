import { Router } from 'express';
import { db, users, venues } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';
import { getPmUserToken, submitPmScore, PmApiError } from '../lib/pinballmapApi.js';
import { pmAuthLimiter, pmSubmitLimiter, refuseIfLimited } from '../lib/pmGuards.js';
import { getVenueRoster } from '../lib/pmRosterCache.js';
import { parseScore } from '../lib/scoreRead.js';
import { canSeeVenueLinkage } from '../lib/venuePrivacy.js';

const router = Router();

// The app doesn't set `trust proxy`, so on Render req.ip is the load balancer's address — keying a
// per-IP limit on it would lock every user out together. The proxy appends the connecting address
// as the LAST X-Forwarded-For entry (earlier entries are client-supplied and spoofable).
function clientIp(req: any): string {
  const xff = req.headers?.['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  return list[list.length - 1] ?? req.ip ?? 'unknown';
}

// GET /api/pinballmap/token — check if the current user has a stored PM token
router.get('/token', requireAppUser, (req, res) => {
  const user = (req as any).appUser;
  res.json({ hasToken: !!user.pinballMapToken, pmUsername: user.pinballMapUsername ?? null });
});

// POST /api/pinballmap/auth — exchange PM credentials for a token and persist it.
// 5 attempts per 15 minutes per user AND per IP (a password-guessing relay through our api_token
// would otherwise be unlimited). The PM user token stays server-side: the response carries only the
// username — the frontend never used the token (submit-score reads the stored one).
router.post('/auth', requireAppUser, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password
    || email.length > 320 || password.length > 1000) {
    return res.status(400).json({ error: 'email and password required' });
  }
  const user = (req as any).appUser;

  const byUser = pmAuthLimiter.take(`u:${user.id}`);
  const tooMany = 'Too many Pinball Map sign-in attempts — wait 15 minutes and try again';
  if (refuseIfLimited(res, byUser, tooMany)) return;
  if (refuseIfLimited(res, pmAuthLimiter.take(`ip:${clientIp(req)}`), tooMany)) return;

  let result: Awaited<ReturnType<typeof getPmUserToken>>;
  try {
    result = await getPmUserToken(email, password);
  } catch (err) {
    if (err instanceof PmApiError) {
      console.error('PM auth error:', err.kind, err.message);
      if (err.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
      return res.status(503).json({ error: err.message, code: `PM_${err.kind.toUpperCase()}` });
    }
    throw err;
  }
  if (!result) return res.status(401).json({ error: 'Invalid Pinball Map credentials' });

  await db.update(users)
    .set({ pinballMapToken: result.token, pinballMapUsername: result.username })
    .where(eq(users.id, user.id));

  res.json({ username: result.username });
});

// POST /api/pinballmap/submit-score
// Body: { venueId, machineName, score, userToken? }
// Uses stored token if userToken is omitted.
router.post('/submit-score', requireAppUser, async (req, res) => {
  const { venueId, machineName, score } = req.body;
  const user = (req as any).appUser;
  const userToken: string | undefined = req.body.userToken ?? user.pinballMapToken ?? undefined;
  const usingStoredToken = !req.body.userToken && !!user.pinballMapToken;

  if (!userToken || !venueId || typeof machineName !== 'string' || !machineName || score == null) {
    return res.status(400).json({ error: 'venueId, machineName, and score are required; no Pinball Map token available' });
  }
  // Pinball Map allows 80 score submissions / 2 min per IP — and every TiltTrack user shares ours.
  if (refuseIfLimited(res, pmSubmitLimiter.take(String(user.id)), 'Too many score submissions — wait a minute and try again')) return;
  const parsedScore = parseScore(score);
  if (parsedScore == null) {
    return res.status(400).json({ error: 'score must be a positive whole number', code: 'invalid_score' });
  }

  try {
    const [venue] = await db.select().from(venues).where(eq(venues.id, Number(venueId))).limit(1);
    // A private venue's Pinball Map link is only its owner's (and admins') to use: the reply below
    // echoes the matched machine's canonical name and xref id, so letting anyone probe it with
    // machine names would read out the roster — and a roster identifies the listing, i.e. where the
    // venue is. For everyone else it answers exactly as if the venue had no link at all.
    if (!venue?.pinballMapId || !canSeeVenueLinkage(venue, user.id, user.role === 'admin')) {
      return res.status(422).json({ error: 'This venue is not linked to Pinball Map' });
    }

    const { xrefs } = await getVenueRoster(venue.pinballMapId);
    const needle = machineName.toLowerCase();
    const xref = xrefs.find(x =>
      x.machine.name.toLowerCase().includes(needle) || needle.includes(x.machine.name.toLowerCase())
    );

    if (!xref) {
      return res.status(422).json({ error: `"${machineName}" not found on Pinball Map at this venue` });
    }

    try {
      await submitPmScore(userToken, xref.id, parsedScore);
    } catch (err) {
      if (!(err instanceof PmApiError)) throw err;
      console.error('PM submit-score failed:', err.kind, err.status ?? '', err.message);
      // Only a 401/403 about the *user's* token means their session is gone. A 429, 5xx, timeout or
      // open breaker says nothing about it — clearing the token then forced a needless re-login.
      const userTokenRejected = err.kind === 'unauthorized' && !/api_token/i.test(err.detail ?? '');
      if (userTokenRejected && usingStoredToken) {
        await db.update(users).set({ pinballMapToken: null }).where(eq(users.id, user.id));
        return res.status(401).json({ error: 'Pinball Map session expired — please re-enter credentials', code: 'PM_TOKEN_EXPIRED' });
      }
      if (err.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
      const status = err.kind === 'rate_limited' || err.kind === 'unavailable' ? 503 : 502;
      return res.status(status).json({
        error: userTokenRejected ? 'Pinball Map rejected the score submission' : err.message,
        code: `PM_${err.kind.toUpperCase()}`,
      });
    }

    res.json({ success: true, machineName: xref.machine.name, xrefId: xref.id });
  } catch (err) {
    console.error('PM submit-score error:', err);
    res.status(500).json({ error: 'Failed to submit score to Pinball Map' });
  }
});

export default router;
