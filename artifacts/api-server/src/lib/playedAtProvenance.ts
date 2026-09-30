// Where a score's played time came from (scores.played_at_source, migrate24) and the rules that keep
// a camera-recorded time from being rewritten by the player.
//
// The loophole this closes: a May photo's score, edited to "today", counted in four challenges that
// started this week. Challenges compare played_at against their window, so a time the player can
// move freely is a time they can move into any window.
//
//  - 'photo'  — the time came from the upload's camera metadata (EXIF DateTimeOriginal). The server
//               vouches for it with a signed token issued by POST /api/upload (below); the client
//               cannot claim 'photo' on its own word.
//  - 'video'  — metadata inside a video file: Apple's creationdate (a camera wall clock, which goes up
//               to /api/upload in the same `exifDatetime` field and so also gets a token, kind
//               'video'), or the QuickTime `mvhd` time (an instant, never sent to the server — a bare
//               client claim). Videos are never uploaded, so either way it's read in the browser.
//  - 'manual' — typed, AI-read off the screen, a video's file-modified time (a forwarded or re-saved
//               video has no recording time left), or no metadata at all.
//  - null     — legacy: scores from before migrate24. Unknown provenance, so they stay editable.
//
// Locked ('photo' / 'video'): only an admin may change the played time, with a reason, and the
// correction is recorded on the row (played_at_corrected_by_id / _at) and as an
// `admin.played_at_corrected` activity event. The source is left as it was, so the lock survives the
// correction — setting it to 'manual' would hand the player the edit the admin just made for them.
//
// How strong 'photo' is: the photo's EXIF is read in the browser (the downscale strips it before
// upload) and sent as `meta`, so the token proves "this is the time /api/upload told this user", not
// that the camera's clock was right. Beating it takes a hand-built upload request — about the same
// effort as editing a photo's EXIF, which nothing server-side could detect anyway. What it closes is
// the edit box: the wizard, the edit dialog and a plain PATCH/POST can no longer move the time.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type PlayedAtSource = 'photo' | 'video' | 'manual';
export const PLAYED_AT_SOURCES: readonly PlayedAtSource[] = ['photo', 'video', 'manual'];
export type LockedSource = 'photo' | 'video';

export const isLockedSource = (s: unknown): s is LockedSource => s === 'photo' || s === 'video';

// ── the played-time token ────────────────────────────────────────────────────
//
// `<base64url(JSON {v, u, t, s, e})>.<base64url(HMAC-SHA256)>`:
//   u — the uploader's Clerk user id (a token is useless to anyone else),
//   t — the naive camera wall clock /api/upload returned as `playedAt` ("2026-05-02T23:30:00"),
//   s — 'photo' or 'video': the kind of file that clock came from (becomes the score's source),
//   e — expiry, epoch ms (24 h: a score saved the next day still carries its photo's time).
//
// Key: PLAYED_AT_TOKEN_SECRET when set, else derived from CLERK_SECRET_KEY (always set wherever the
// API can authenticate anyone, Render included) — so production needs no new variable. Rotating
// either invalidates outstanding tokens, which only means an in-progress upload saves as 'manual'.

export const PLAYED_AT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_VERSION = 1;
const KEY_LABEL = 'tilttrack:played-at-token:v1';

let keyOverride: Buffer | null | undefined;
/** Unit tests only: a fixed key, or null for "no key configured". `undefined` restores the env. */
export function setPlayedAtTokenKeyForTests(key: string | null | undefined): void {
  keyOverride = key == null ? key : Buffer.from(key);
}

function tokenKey(): Buffer | null {
  if (keyOverride !== undefined) return keyOverride;
  const own = process.env.PLAYED_AT_TOKEN_SECRET;
  if (own) return Buffer.from(own);
  const clerk = process.env.CLERK_SECRET_KEY;
  if (clerk) return createHmac('sha256', clerk).update(KEY_LABEL).digest();
  return null;
}

/** The naive "YYYY-MM-DDTHH:mm[:ss]" shape /api/upload returns; anything else is refused. */
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** A token for this user and camera time, or null when no key is configured (the score saves as 'manual'). */
export function signPlayedAtToken(clerkId: string, naive: string, kind: LockedSource = 'photo', now = Date.now()): string | null {
  const key = tokenKey();
  if (!key || !clerkId || !NAIVE_RE.test(naive)) return null;
  const body = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, u: clerkId, t: naive, s: kind, e: now + PLAYED_AT_TOKEN_TTL_MS })).toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export type TokenCheck =
  | { ok: true; naive: string; kind: LockedSource }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'wrong_user' | 'expired' | 'no_key' };

export function verifyPlayedAtToken(token: unknown, clerkId: string, now = Date.now()): TokenCheck {
  const key = tokenKey();
  if (!key) return { ok: false, reason: 'no_key' };
  if (typeof token !== 'string' || token.length > 1000) return { ok: false, reason: 'malformed' };
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return { ok: false, reason: 'malformed' };
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'bad_signature' };
  let p: any;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (p?.v !== TOKEN_VERSION || typeof p.t !== 'string' || !NAIVE_RE.test(p.t) || typeof p.e !== 'number' || !isLockedSource(p.s)) {
    return { ok: false, reason: 'malformed' };
  }
  if (p.u !== clerkId) return { ok: false, reason: 'wrong_user' };
  if (now > p.e) return { ok: false, reason: 'expired' };
  return { ok: true, naive: p.t, kind: p.s };
}

// ── does the submitted instant say what the camera said? ─────────────────────
//
// The token carries the camera's zone-less wall clock; POST /api/scores receives an instant the
// browser made from it with the venue's zone (localInputToIso, frontend datetime.ts), at minute
// precision (the datetime-local input drops seconds). So the check goes instant → wall clock in that
// zone, and compares to the minute. Formatting is the unambiguous direction: both instants of a
// fall-back hour format to the same wall clock.

/** "YYYY-MM-DDTHH:mm" as the clock reads in `tz` at `at`. Throws RangeError on an unknown zone. */
export function wallClockIn(at: Date, tz: string): string {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at).map(p => [p.type, p.value]));
  return `${f.year}-${f.month}-${f.day}T${String(Number(f.hour) % 24).padStart(2, '0')}:${f.minute}`;
}

const MIN = 60_000;

/** The naive clock read as if UTC, to the minute — only to measure offsets against, never an instant. */
function naiveAsUtcMs(naive: string): number {
  const m = naive.match(NAIVE_RE)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** A zone's offset at an instant, in ms. */
function offsetAt(at: number, tz: string): number {
  return naiveAsUtcMs(wallClockIn(new Date(at), tz)) - Math.floor(at / MIN) * MIN;
}

/** Real UTC offsets run from −12:00 to +14:00, in 15-minute steps (Nepal is +5:45). */
const MIN_OFFSET_MIN = -12 * 60, MAX_OFFSET_MIN = 14 * 60;

/**
 * Does `instant` (the submitted playedAt) show `naive` (the token's camera time)?
 *
 *  - With a zone (the venue's): its wall clock there must equal the camera's, to the minute. A camera
 *    time inside a spring-forward gap doesn't exist on that clock; the browser's conversion lands an
 *    hour to one side, so an exact hour's difference is accepted when the zone's offset changes
 *    within two hours of the instant.
 *  - Without one (no venue, or a venue with no zone yet): the browser used the viewer's own zone,
 *    which the server can't know. Accept any real offset — a whole number of quarter hours between
 *    −12 and +14. That still pins the time to within a day of the photo, not to any date the player
 *    likes; documented as the weaker case.
 */
export function instantMatchesNaive(instant: Date, naive: string, tz: string | null): boolean {
  if (Number.isNaN(instant.getTime()) || !NAIVE_RE.test(naive)) return false;
  if (tz) {
    let shown: string;
    try { shown = wallClockIn(instant, tz); } catch { return false; }
    if (shown === naive.slice(0, 16)) return true;
    if (Math.abs(naiveAsUtcMs(shown) - naiveAsUtcMs(naive)) !== 60 * MIN) return false;
    return offsetAt(+instant - 2 * 60 * MIN, tz) !== offsetAt(+instant + 2 * 60 * MIN, tz);
  }
  const offsetMin = (naiveAsUtcMs(naive) - Math.floor(+instant / MIN) * MIN) / MIN;
  return Number.isInteger(offsetMin / 15) && offsetMin >= MIN_OFFSET_MIN && offsetMin <= MAX_OFFSET_MIN;
}

// ── POST: which source does a new score get? ─────────────────────────────────

export type SourceDecision =
  | { ok: true; source: PlayedAtSource }
  | { ok: false; status: 400; body: { error: string; code: string } };

export const PLAYED_AT_MISMATCH = {
  error: "The played time doesn't match your photo's. Photo times can't be changed — save it with the photo's time, or ask an admin to correct it afterwards.",
  code: 'played_at_mismatch',
} as const;
export const PLAYED_AT_TOKEN_INVALID = {
  error: "Couldn't verify your photo's time — upload the photo again.",
  code: 'played_at_token_invalid',
} as const;

export interface VerifiedTime { naive: string; kind: LockedSource }

/**
 * Step 1 (before anything is written): check the token itself. A forged or someone else's token is a
 * 400. An expired one (or no server key) quietly downgrades to 'manual' — the player loses the lock,
 * never the score, and a manual time is the less privileged state.
 */
export function checkPlayedAtToken(token: unknown, clerkId: string, now = Date.now()): { verified: VerifiedTime | null; refusal: SourceDecision | null } {
  if (token == null || token === '') return { verified: null, refusal: null };
  const r = verifyPlayedAtToken(token, clerkId, now);
  if (r.ok) return { verified: { naive: r.naive, kind: r.kind }, refusal: null };
  if (r.reason === 'expired' || r.reason === 'no_key') return { verified: null, refusal: null };
  return { verified: null, refusal: { ok: false, status: 400, body: { ...PLAYED_AT_TOKEN_INVALID } } };
}

/**
 * Step 2: the source. `verified` is a checked token's camera time (or null); `claimed` is the
 * client's `playedAtSource`, which only counts for 'video' (a QuickTime mvhd instant the server never
 * saw) — 'photo' is never taken on the client's word.
 */
export function decidePlayedAtSource(input: {
  verified: VerifiedTime | null; playedAt: Date; tz: string | null; claimed: unknown;
}): SourceDecision {
  if (input.verified) {
    return instantMatchesNaive(input.playedAt, input.verified.naive, input.tz)
      ? { ok: true, source: input.verified.kind }
      : { ok: false, status: 400, body: { ...PLAYED_AT_MISMATCH } };
  }
  if (input.claimed === 'video') return { ok: true, source: 'video' };
  return { ok: true, source: 'manual' };
}

// ── PATCH: may this caller move the played time? ─────────────────────────────

export const PLAYED_AT_LOCKED = {
  error: 'This time was recorded by your camera, so it can’t be changed here. If the camera’s clock was wrong, ask an admin to correct it.',
  code: 'played_at_locked',
} as const;
export const PLAYED_AT_REASON_REQUIRED = {
  error: 'Say why this camera-recorded time is being corrected.',
  code: 'reason_required',
} as const;

/** Same minute ⇒ not a change. The edit form works in minutes, so re-saving it must not move the time. */
export function playedAtChanged(before: Date, after: Date): boolean {
  return Math.floor(+before / MIN) !== Math.floor(+after / MIN);
}

export type LockDecision =
  | { allow: true; correction: boolean; reason: string | null }
  | { allow: false; status: 400 | 403; body: { error: string; code: string } };

/**
 * The PATCH rule. Only reached when the played time actually changes (playedAtChanged).
 *  - Unlocked (manual / legacy null): anyone who may edit the score may move it.
 *  - Locked (photo / video), not an admin: 403 played_at_locked — whoever owns it.
 *  - Locked, admin: allowed with a reason (1–500 chars after trimming); it's a correction.
 */
export function playedAtEditDecision(source: unknown, isAdmin: boolean, reasonRaw: unknown): LockDecision {
  if (!isLockedSource(source)) return { allow: true, correction: false, reason: null };
  if (!isAdmin) return { allow: false, status: 403, body: { ...PLAYED_AT_LOCKED } };
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 500) : '';
  if (!reason) return { allow: false, status: 400, body: { ...PLAYED_AT_REASON_REQUIRED } };
  return { allow: true, correction: true, reason };
}
