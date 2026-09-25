import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import Exifr from 'exifr';
import { and, between, eq } from 'drizzle-orm';
import { db, venues, users } from '@workspace/db';
import { getAuth } from '@clerk/express';
import { requireAuth } from '../middleware/requireAuth.js';
import { extractScoreReads, ScoreReadTruncatedError, type ExtractedScoreReads } from '../lib/anthropic.js';
import { refineWithCrops, modelViewSize } from '../lib/displayCrops.js';
import { mergeReads, mergePlayerReads, defaultPlayerIndex, templateToScore, checkPlausibility } from '../lib/scoreRead.js';
import { getMachineScoreStats } from '../lib/machineScoreStats.js';
import { fitUnderAnthropicLimit, TARGET_RAW_BYTES } from '../lib/imageCompress.js';
import { getNearbyVenues, type Venue } from '../lib/hereApi.js';
import { findNearestPmLocations, type PmLocation } from '../lib/pinballmapApi.js';
import { redactVenue } from '../lib/venuePrivacy.js';
import {
  SlidingRateLimiter, TtlCache, cachedByCell, rateLimitMessage, NEARBY_RATE_WINDOWS, NEARBY_CACHE_TTL_MS,
} from '../lib/nearbyLookup.js';

const router = Router();

async function extractGps(buffer: Buffer): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const gps = await Exifr.gps(buffer);
    if (!gps || gps.latitude == null || gps.longitude == null) return null;
    return { latitude: gps.latitude, longitude: gps.longitude };
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * EXIF `DateTimeOriginal` is a *naive* wall clock — "2026:09:10 22:01:00", with no timezone. exifr
 * turns that into a Date by interpreting those digits in the **host's** timezone, so the instant it
 * produces is only meaningful if the host happens to share the camera's zone. Render runs in UTC, so
 * `toISOString()` here used to stamp a Chicago photo taken at 10:01pm as 22:01Z and every score card
 * rendered it five hours early.
 *
 * Reading the components back out through the local getters undoes exifr's assumption exactly,
 * whatever the host zone is, and hands the browser the wall clock the camera actually recorded. The
 * browser then interprets it in the *viewer's* zone on submit — see `datetime.ts` on the frontend.
 * That's an assumption (the uploader is in the photo's timezone), but it's right for anyone logging
 * a score on the trip they took it, and EXIF gives us nothing better to work from.
 */
function toNaiveLocal(dt: Date): string {
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}` +
    `T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

/** Coerces whatever the AI read off the score screen into the same zone-less shape. */
function normalizeNaiveDatetime(value: string | null): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}` : null;
}

async function extractExifDatetime(buffer: Buffer): Promise<string | null> {
  try {
    // `pick` is exifr's documented tag filter — `{ DateTimeOriginal: true }` happened to work but
    // isn't in its Options type, and this matches the client-side path in prepareUploadImage.ts.
    const tags = await Exifr.parse(buffer, { pick: ['DateTimeOriginal'] });
    const dt = tags?.DateTimeOriginal;
    return dt instanceof Date && !Number.isNaN(dt.getTime()) ? toNaiveLocal(dt) : null;
  } catch {
    return null;
  }
}

async function getHistoryVenues(lat: number, lng: number, requesterUserId: number | undefined, isAdmin: boolean): Promise<Venue[]> {
  // ~150 m bounding box
  const latDelta = 0.00135;
  const lngDelta = 0.00135 / Math.cos((lat * Math.PI) / 180);

  const rows = await db
    .select()
    .from(venues)
    .where(
      and(
        between(venues.latitude, lat - latDelta, lat + latDelta),
        between(venues.longitude, lng - lngDelta, lng + lngDelta),
      )
    );

  return rows.map(v => {
    const redacted = redactVenue(v, requesterUserId, isAdmin);
    return {
      venueId: v.id,
      name: v.name,
      address: redacted.address ?? '',
      distance: Math.round(haversineM(lat, lng, v.latitude!, v.longitude!)),
      hereId: v.hereId,
      source: 'history' as const,
    };
  });
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function attachPinballMapIds(venueList: Venue[], pmLocations: PmLocation[]): Venue[] {
  return venueList.map(v => {
    const vLat = v.venueLat ?? 0;
    const vLng = v.venueLng ?? 0;
    const match = pmLocations.find(pm => {
      if (vLat && vLng) return haversineM(vLat, vLng, pm.lat, pm.lon) < 150;
      return pm.name.toLowerCase().includes(v.name.toLowerCase().slice(0, 8));
    });
    return match ? { ...v, pinballMapId: match.id } : v;
  });
}

interface ExternalVenues {
  here: Venue[];
  pmLocations: PmLocation[];
  /** False when the Pinball Map call failed — a result that must not be cached. */
  pmOk: boolean;
}
type ExternalLookup = (lat: number, lng: number) => Promise<ExternalVenues>;

async function fetchExternalVenues(lat: number, lng: number): Promise<ExternalVenues> {
  let pmOk = true;
  const [here, pmLocations] = await Promise.all([
    getNearbyVenues(lat, lng),
    // Venue suggestions are the point of this call; Pinball Map ids are a bonus on top. If PM is
    // down or the api_token is missing, the user should still get their venue list.
    findNearestPmLocations(lat, lng).catch(err => {
      pmOk = false;
      console.error('Pinball Map lookup failed during venue suggestion:', err?.message ?? err);
      return [] as PmLocation[];
    }),
  ]);
  return { here, pmLocations, pmOk };
}

// "Use my current location" guards — see nearbyLookup.ts. One lookup per ~110m cell per 10 minutes
// (in flight or done), so repeat taps don't re-hit HERE or Pinball Map.
const nearbyLimiter = new SlidingRateLimiter(NEARBY_RATE_WINDOWS);
const nearbyCache = new TtlCache<Promise<ExternalVenues>>(NEARBY_CACHE_TTL_MS);
setInterval(() => { nearbyLimiter.sweep(); nearbyCache.sweep(); }, 10 * 60_000).unref();

// Don't keep a PM failure, or an empty HERE answer (which is how HERE failures surface), for 10 min.
const externalVenuesByCell = cachedByCell(fetchExternalVenues, nearbyCache, r => r.pmOk && r.here.length > 0);

const cachedExternalVenues: ExternalLookup = async (lat, lng) => {
  const result = await externalVenuesByCell(lat, lng);
  // HERE's distances were measured from whoever filled the cell; re-measure from this point.
  return {
    ...result,
    here: result.here.map(v => (v.venueLat != null && v.venueLng != null
      ? { ...v, distance: Math.round(haversineM(lat, lng, v.venueLat, v.venueLng)) }
      : v)),
  };
};

/**
 * Venue suggestions around a point: the requester's-eyes view of venues already in TiltTrack
 * (redacted per privacy tier), then HERE places not already listed, with Pinball Map ids attached.
 * Shared by the photo-GPS path (`POST /`) and the "Use my current location" fallback
 * (`POST /nearby-venues`), so both produce exactly the same list for the same point.
 * `external` swaps in how the HERE / Pinball Map half is fetched — the nearby route passes its
 * cached version; history venues are always read fresh, since they're redacted per requester.
 */
async function suggestVenuesNear(
  req: Request, lat: number, lng: number, external: ExternalLookup = fetchExternalVenues,
): Promise<Venue[]> {
  const { userId: clerkId } = getAuth(req);
  let requesterUserId: number | undefined;
  let isAdmin = false;
  if (clerkId) {
    const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
    requesterUserId = u?.id;
    isAdmin = u?.role === 'admin';
  }

  const [history, { here, pmLocations }] = await Promise.all([
    getHistoryVenues(lat, lng, requesterUserId, isAdmin),
    external(lat, lng),
  ]);

  // History venues first; de-duplicate HERE results by hereId and name
  const hereIdsSeen = new Set(history.map(v => v.hereId).filter(Boolean));
  const namesSeen = new Set(history.map(v => v.name.toLowerCase()));

  const freshHere = here.filter(
    v => !hereIdsSeen.has(v.hereId) && !namesSeen.has(v.name.toLowerCase())
  );

  return attachPinballMapIds([...history, ...freshHere], pmLocations);
}

// The wizard allows 3 items, and a video item contributes its best 3 frames (extracted in the
// browser — the video itself never comes here), so up to 9 images can arrive in one request.
const MAX_IMAGES = 9;
// Photos further apart than this probably aren't the same game — surfaced as a non-blocking warning.
const SAME_GAME_MAX_MINUTES = 10;
const SAME_GAME_MAX_METERS = 200;

// Two upload shapes, two multer instances, because memoryStorage holds every byte in RAM:
//  - `?set=1` + `photos` (current client): 1–9 images the browser already downscaled to ~2000px
//    (~1MB each), so 8MB per file is generous and 9 of them can't approach the old 9 × 20MB.
//  - legacy single `photo`, no query flag: 20MB, because it's also the path for a HEIC the browser
//    couldn't convert, which arrives as the camera original.
// Both also check Content-Length up front — a hard cap on the request body (Node won't read past the
// declared length), so a request can't queue up more than its budget in memory. A body without one
// (chunked) is refused; browsers always send it for FormData.
const MB = 1024 * 1024;
const SET_FILE_BYTES = 8 * MB;
const SET_TOTAL_BYTES = 40 * MB;
const LEGACY_FILE_BYTES = 20 * MB;
const LEGACY_TOTAL_BYTES = 21 * MB;
const DRAIN_CEILING_BYTES = 200 * MB;

const setUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: SET_FILE_BYTES, files: MAX_IMAGES } })
  .array('photos', MAX_IMAGES);
const legacyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LEGACY_FILE_BYTES, files: 1 } })
  .single('photo');

export function receivePhotos(req: Request, res: Response, next: NextFunction) {
  const isSet = req.query.set === '1';
  const cap = isSet ? SET_TOTAL_BYTES : LEGACY_TOTAL_BYTES;
  const declared = Number(req.headers['content-length']);
  if (!Number.isFinite(declared) || declared <= 0) {
    return res.status(411).json({ error: 'Upload needs a Content-Length', code: 'upload_rejected' });
  }
  if (declared > cap) {
    // Drain (read and discard — nothing is buffered) before answering: replying mid-upload makes the
    // browser see a reset connection instead of this message. Past the drain ceiling, just hang up.
    if (declared > DRAIN_CEILING_BYTES) return req.destroy();
    res.set('Connection', 'close');
    req.resume();
    req.once('end', () => res.status(413).json({ error: `Upload too large (max ${cap / MB}MB)`, code: 'upload_too_large' }));
    return;
  }
  (isSet ? setUpload : legacyUpload)(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `Each ${isSet ? 'image' : 'photo'} must be under ${(isSet ? SET_FILE_BYTES : LEGACY_FILE_BYTES) / MB}MB`
        : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT'
          ? (isSet ? `Up to ${MAX_IMAGES} images at a time` : 'Send one photo as "photo", or several as "photos" with ?set=1')
          : 'Upload rejected';
      return res.status(400).json({ error: message, code: 'upload_rejected' });
    }
    next(err);
  });
}

interface PhotoMeta {
  latitude: number | null;
  longitude: number | null;
  exifDatetime: string | null;
}

function toFiniteOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanMeta(raw: any): PhotoMeta {
  const latitude = toFiniteOrNull(raw?.latitude);
  const longitude = toFiniteOrNull(raw?.longitude);
  const hasGps = latitude != null && longitude != null;
  return {
    latitude: hasGps ? latitude : null,
    longitude: hasGps ? longitude : null,
    // The client sends the same zone-less shape `toNaiveLocal` produces (prepareUploadImage.ts), but
    // normalize anyway so a stale client can't reintroduce a `Z` the frontend would misread.
    exifDatetime: normalizeNaiveDatetime(typeof raw?.exifDatetime === 'string' ? raw.exifDatetime : null),
  };
}

/** Per-photo metadata: the JSON `meta` array, or the legacy flat latitude/longitude/exifDatetime fields. */
function readClientMeta(body: any, count: number): PhotoMeta[] {
  let list: any[] = [];
  if (typeof body.meta === 'string') {
    try {
      const parsed = JSON.parse(body.meta);
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* ignore — falls back to server-side extraction */ }
  }
  if (list.length === 0 && count === 1) list = [body];
  return Array.from({ length: count }, (_, i) => cleanMeta(list[i]));
}

const isHeic = (f: Express.Multer.File) =>
  f.mimetype === 'image/heic' || f.mimetype === 'image/heif' || /\.(heic|heif)$/i.test(f.originalname);

/**
 * Minutes between two zone-less EXIF wall clocks. Both are read as if UTC purely so they share a
 * frame — this is a difference between two readings of the same camera clock, not an instant.
 */
function naiveMinutesApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}Z`) - Date.parse(`${b}Z`)) / 60000;
}

/** Non-blocking "these may be from different games" check across the uploaded photos. */
function differentGamesWarning(meta: PhotoMeta[]): string | null {
  const times = meta.map(m => m.exifDatetime).filter((t): t is string => !!t);
  const points = meta.filter(m => m.latitude != null && m.longitude != null);
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      if (naiveMinutesApart(times[i], times[j]) > SAME_GAME_MAX_MINUTES) {
        return `These photos were taken more than ${SAME_GAME_MAX_MINUTES} minutes apart — they may be from different games.`;
      }
    }
  }
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (haversineM(points[i].latitude!, points[i].longitude!, points[j].latitude!, points[j].longitude!) > SAME_GAME_MAX_METERS) {
        return 'These photos were taken in different places — they may be from different games.';
      }
    }
  }
  return null;
}

/**
 * Venue suggestions for the device's current position — the wizard's fallback when none of the
 * photos carried GPS ("Use my current location"). Read-only: the coordinates are used for this
 * lookup and nothing else — not stored, and never the score's location (the client keeps them out
 * of the score it saves, too).
 *
 * POST with a JSON body, not a query string, so the point stays out of URL/access logs; the client
 * also rounds it to 4 decimals (~11m) first. It does leave this server as the `at` parameter of the
 * HERE and Pinball Map requests — that's the lookup — and this route writes it to no log of its own.
 * Rate-limited per user and cached per ~110m cell — see nearbyLookup.ts.
 */
router.post('/nearby-venues', requireAuth, async (req, res) => {
  const lat = toFiniteOrNull(req.body?.lat);
  const lng = toFiniteOrNull(req.body?.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'lat and lng are required', code: 'invalid_coordinates' });
  }
  const { userId: clerkId } = getAuth(req);
  const decision = nearbyLimiter.take(clerkId ?? req.ip ?? 'anonymous');
  if (!decision.ok) {
    res.set('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
    return res.status(429).json({ error: rateLimitMessage(decision.retryAfterMs), code: 'rate_limited' });
  }
  try {
    res.json({ venues: await suggestVenuesNear(req, lat, lng, cachedExternalVenues) });
  } catch (err: any) {
    console.error('Nearby venue lookup failed:', err?.message ?? err);
    res.status(502).json({ error: "Couldn't look up venues near you — pick one below instead" });
  }
});

router.post('/', requireAuth, receivePhotos, async (req, res) => {
  const files: Express.Multer.File[] = Array.isArray(req.files) && req.files.length
    ? req.files
    : req.file ? [req.file] : [];
  if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });
  const multi = files.length > 1;

  // Server-side HEIC decode costs ~380MB RSS per photo (it OOM-killed Render once — see
  // imageCompress.ts / prepareUploadImage.ts). One is survivable; several in one request is not, so
  // multi-photo uploads must arrive already converted by the browser.
  if (multi && files.some(isHeic)) {
    return res.status(400).json({
      error: "One of these photos is in HEIC format and couldn't be converted on your device. Upload it on its own, or convert it to JPEG first.",
      code: 'heic_multi_unsupported',
    });
  }

  try {
    const clientMeta = readClientMeta(req.body, files.length);
    // Several images share one Anthropic request; keep each well under its share of the budget.
    // The browser normally downscales to ~2000px, so this rarely has to do anything.
    const perImageTarget = multi ? Math.floor(TARGET_RAW_BYTES / files.length) : TARGET_RAW_BYTES;

    const meta: PhotoMeta[] = [];
    const images: Array<{ base64: string; mimeType: string }> = [];
    let thumbnailBase64: string | null = null;

    // Sequential on purpose: each iteration may decode an image, and doing three at once is exactly
    // the memory spike the upload-crash fix was about.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const originalBuffer = file.buffer;
      let buffer = originalBuffer;
      let mimeType = file.mimetype;

      // The frontend extracts GPS/EXIF client-side before converting/downscaling every photo, since
      // both strip EXIF (see prepareUploadImage.ts). Falls back to server-side extraction when
      // absent — an older client, or a photo whose EXIF the browser couldn't read.
      const m = clientMeta[i];
      const [serverGps, serverExifDatetime] = await Promise.all([
        m.latitude != null ? Promise.resolve(null) : extractGps(originalBuffer),
        m.exifDatetime ? Promise.resolve(null) : extractExifDatetime(originalBuffer),
      ]);
      meta.push({
        latitude: m.latitude ?? serverGps?.latitude ?? null,
        longitude: m.longitude ?? serverGps?.longitude ?? null,
        exifDatetime: m.exifDatetime ?? serverExifDatetime,
      });

      if (isHeic(file)) {
        // Single-photo only (guarded above) — the legacy fallback for a HEIC the browser couldn't convert.
        try {
          const heicConvert = (await import('heic-convert')).default;
          // heic-convert's WASM decoder is memory-heavy even for an ordinary 12MP photo (measured
          // ~365MB RSS, ~11s) — decode the HEIC source exactly once and derive the thumbnail from the
          // resulting JPEG via sharp instead of paying that full decode cost a second time.
          const mainBuf = await heicConvert({ buffer, format: 'JPEG', quality: 0.9 });
          buffer = Buffer.from(mainBuf);
          mimeType = 'image/jpeg';
          const thumbBuf = await sharp(buffer).resize(160).jpeg({ quality: 65 }).toBuffer();
          thumbnailBase64 = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
        } catch {
          return res.status(422).json({ error: 'Failed to convert HEIC image' });
        }
      }

      // Anthropic rejects images over 10MB base64 — HEIC→JPEG conversion in particular can inflate
      // well past that. Only compresses when actually oversized; see imageCompress.ts for why quality
      // reduction is preferred over resizing (score-screen digits need to stay legible).
      const fitted = await fitUnderAnthropicLimit(buffer, mimeType, perImageTarget);
      images.push({ base64: fitted.buffer.toString('base64'), mimeType: fitted.mimeType });
    }

    // One model call sees every photo; the per-image reads are merged in code (scoreRead.ts), so a
    // digit dark in one shot can be read from another and disagreements surface as conflicts.
    // Each photo's model-view size (header only) turns the display boxes pass 1 reports in pixels
    // into fractions the crop pass can cut from the full-resolution photo. A photo sharp can't read
    // goes without one (its boxes are then read as fractions).
    const sized: typeof images = [];
    for (const img of images) sized.push(await modelViewSize(img).catch(() => img));
    // A read cut off by max_tokens is incomplete and unusable — but the photos' GPS, time and venue
    // suggestions are still good, so answer normally with no score and say why (`readNotice`).
    // (try/catch rather than .catch(): an assignment inside a callback isn't seen by TS's flow
    // analysis, which then typed `readNotice` in the response as always null.)
    let readNotice: string | null = null;
    let extracted: ExtractedScoreReads;
    try {
      extracted = await extractScoreReads(sized);
    } catch (err) {
      if (!(err instanceof ScoreReadTruncatedError)) throw err;
      readNotice = "Couldn't read the score from this many photos at once — enter it below, or try fewer photos.";
      extracted = {
        usage: { inputTokens: 0, outputTokens: 0, ms: 0 }, machineName: null, playedAt: null,
        reads: images.map(() => ({ displays: [] })), bestImageIndex: 0,
      };
    }
    // Second pass: re-read each score display from a close crop, window by window, when the photo has
    // several displays or a strobed segment read (see displayCrops.ts). Skipped for a lone complete
    // DMD/LCD read. Any failure keeps the whole-photo read — this can never fail the upload.
    const cropPass = await refineWithCrops(sized, extracted.reads).catch(err => {
      console.error('Score crop pass failed:', err?.message ?? err);
      return null;
    });
    for (const r of cropPass?.report ?? []) {
      if (r.error) console.error(`Score crop pass failed for image ${r.imageIndex}:`, r.error);
    }
    const imageReads = cropPass?.reads ?? extracted.reads;
    // Merged per player: a 4-player backglass is four scores, and only the user knows which was
    // theirs (the wizard asks). Images with no readable display leave an empty list.
    const players = mergePlayerReads(imageReads);
    const selected = players.length ? defaultPlayerIndex(players) : 0;

    // Deterministic "may be missing digits" check against what's already recorded on this machine.
    // The machine here is only the AI's reading of the name; the wizard re-runs the same check via
    // /api/machines/score-stats once the user has actually picked one. Never fails the upload.
    const stats = extracted.machineName
      ? await getMachineScoreStats({ name: extracted.machineName }).catch(err => {
          console.error('Score plausibility lookup failed:', err?.message ?? err);
          return null;
        })
      : null;
    const playerReads = players.map(p => ({
      ...p,
      bestImageIndex: extracted.bestImageIndex,
      plausibility: stats ? checkPlausibility(p.template, stats.median, stats.count) : null,
    }));
    // What a client that can't ask "which player were you?" gets: the only display, or the highest.
    const scoreRead = playerReads[selected] ?? {
      ...mergeReads([]),
      player: null,
      perImage: images.map(() => ''),
      bestImageIndex: extracted.bestImageIndex,
      plausibility: null,
    };

    // GPS from the first photo that has any; playedAt from the earliest camera timestamp (zone-less
    // strings of one fixed shape, so they sort lexically).
    const gpsMeta = meta.find(m => m.latitude != null && m.longitude != null);
    const gps = gpsMeta ? { latitude: gpsMeta.latitude!, longitude: gpsMeta.longitude! } : null;
    const exifDatetime = meta.map(m => m.exifDatetime).filter((t): t is string => !!t).sort()[0] ?? null;

    const venueList: Venue[] = gps ? await suggestVenuesNear(req, gps.latitude, gps.longitude) : [];

    res.json({
      machineName: extracted.machineName,
      // Only set when every digit was read — kept for older clients. `scoreRead` carries the rest.
      // Both describe the default player (`selectedPlayerIndex`); `playerReads` has every player.
      score: templateToScore(scoreRead.template),
      scoreRead,
      playerReads,
      selectedPlayerIndex: playerReads.length ? selected : null,
      photoCount: files.length,
      differentGamesWarning: multi ? differentGamesWarning(meta) : null,
      readNotice,
      // Zone-less wall clock ("2026-09-10T22:01:00") — see toNaiveLocal. The browser resolves it
      // against the viewer's timezone; do not hand this to `new Date()` on the server.
      playedAt: exifDatetime ?? normalizeNaiveDatetime(extracted.playedAt),
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      venues: venueList,
      // Only the legacy server-side HEIC path makes one; the browser builds its own thumbnail from
      // the photo at `scoreRead.bestImageIndex` otherwise.
      thumbnailBase64,
    });
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Failed to process photo — please try again' });
  }
});

export default router;
