import { Router } from 'express';
import { db, users, venues } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { requireAppUser } from '../middleware/requireAuth.js';
import { getPmUserToken, submitPmScore, PmApiError } from '../lib/pinballmapApi.js';
import { pmAuthLimiter, pmSubmitLimiter, refuseIfLimited } from '../lib/pmGuards.js';
import {
  authFailureReply, submitFailureReply, pmErrorReply, storedPmAuth, hasUsablePmConnection, type PmRouteReply,
} from '../lib/pmAccount.js';
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

function send(res: any, reply: PmRouteReply, context: string, err?: PmApiError) {
  if (reply.ourTokenRejected) {
    console.error(`!!! PINBALL MAP REJECTED OUR api_token (${context}) — PINBALL_MAP_API_TOKEN is missing, revoked or wrong. PM features are down for every user. Detail: ${err?.detail ?? ''}`);
  } else if (err) {
    console.error(`PM ${context} failed:`, err.kind, err.status ?? '', err.message);
  }
  if (reply.retryAfterSec) res.setHeader('Retry-After', String(reply.retryAfterSec));
  return res.status(reply.status).json(reply.body);
}

// GET /api/pinballmap/token — does the current user have a connection that can post? A token with no
// stored email (connected before migrate18) can't authenticate a write, so it reports false and the
// UI offers the connect form.
router.get('/token', requireAppUser, (req, res) => {
  const user = (req as any).appUser;
  const hasToken = hasUsablePmConnection(user);
  res.json({ hasToken, pmUsername: hasToken ? user.pinballMapUsername ?? null : null });
});

// POST /api/pinballmap/auth — exchange PM credentials (username or email + password) for a token and
// persist it with the canonical email PM returns (writes need both). 5 attempts per 15 minutes per
// user AND per IP (a password-guessing relay through our api_token would otherwise be unlimited).
// The PM user token and email stay server-side: the response carries only the username.
router.post('/auth', requireAppUser, async (req, res) => {
  // `login` is the field name; `email` is accepted from clients built before the rename.
  const body = req.body ?? {};
  const login = typeof body.login === 'string' ? body.login.trim() : typeof body.email === 'string' ? body.email.trim() : '';
  const password = body.password;
  if (!login || typeof password !== 'string' || !password || login.length > 320 || password.length > 1000) {
    return res.status(400).json({ error: 'Enter your Pinball Map username or email and your password', code: 'pm_missing_fields' });
  }
  const user = (req as any).appUser;

  const byUser = pmAuthLimiter.take(`u:${user.id}`);
  const tooMany = 'Too many Pinball Map sign-in attempts — wait 15 minutes and try again';
  if (refuseIfLimited(res, byUser, tooMany)) return;
  if (refuseIfLimited(res, pmAuthLimiter.take(`ip:${clientIp(req)}`), tooMany)) return;

  let result: Awaited<ReturnType<typeof getPmUserToken>>;
  try {
    result = await getPmUserToken(login, password);
  } catch (err) {
    if (err instanceof PmApiError) return send(res, pmErrorReply(err), 'auth', err);
    throw err;
  }
  if (!result.ok) return send(res, authFailureReply(result), 'auth');

  await db.update(users)
    .set({ pinballMapToken: result.token, pinballMapUsername: result.username, pinballMapEmail: result.email })
    .where(eq(users.id, user.id));

  res.json({ username: result.username });
});

// POST /api/pinballmap/submit-score
// Body: { venueId, machineName, score }. Always posts with the stored connection (token + email);
// there is no client-supplied token — PM can't authenticate a token without its email anyway.
router.post('/submit-score', requireAppUser, async (req, res) => {
  const { venueId, machineName, score } = req.body ?? {};
  const user = (req as any).appUser;

  if (!venueId || typeof machineName !== 'string' || !machineName || score == null) {
    return res.status(400).json({ error: 'venueId, machineName, and score are required' });
  }
  const stored = storedPmAuth(user);
  if (!stored.ok) return send(res, stored.reply, 'submit-score');

  // Pinball Map allows 80 score submissions / 2 min per api_token owner — and every TiltTrack user shares ours.
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

    // id 0 = the roster had the machine but no xref id for it; PM would only answer "Failed to find
    // machine", so don't spend a call finding that out.
    if (!xref || !xref.id) {
      return res.status(422).json({ error: `"${machineName}" not found on Pinball Map at this venue` });
    }

    let result: Awaited<ReturnType<typeof submitPmScore>>;
    try {
      result = await submitPmScore(stored.auth, xref.id, parsedScore);
    } catch (err) {
      // 429 / 5xx / timeout / breaker / our api_token: nothing to do with the user's credential, so
      // it is never cleared here — clearing it then forced a needless re-login.
      if (err instanceof PmApiError) return send(res, pmErrorReply(err), 'submit-score', err);
      throw err;
    }

    if (!result.ok) {
      const reply = submitFailureReply(result);
      if (reply.clearCredential) {
        await db.update(users).set({ pinballMapToken: null, pinballMapEmail: null }).where(eq(users.id, user.id));
      }
      console.error('PM submit-score refused:', result.reason, result.message);
      return send(res, reply, 'submit-score');
    }

    res.json({ success: true, machineName: xref.machine.name, xrefId: xref.id, pmUsername: result.username });
  } catch (err) {
    // e.g. the roster read failing with no cached copy to fall back on
    if (err instanceof PmApiError) return send(res, pmErrorReply(err), 'submit-score roster', err);
    console.error('PM submit-score error:', err);
    res.status(500).json({ error: 'Failed to submit score to Pinball Map' });
  }
});

export default router;
