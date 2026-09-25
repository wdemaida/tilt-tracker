import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import Exifr from 'exifr';
import { and, between, eq } from 'drizzle-orm';
import { db, venues, users } from '@workspace/db';
import { getAuth } from '@clerk/express';
import { requireAuth } from '../middleware/requireAuth.js';
import { extractScoreReads } from '../lib/anthropic.js';
import { mergeReads, templateToScore, checkPlausibility } from '../lib/scoreRead.js';
import { getMachineScoreStats } from '../lib/machineScoreStats.js';
import { fitUnderAnthropicLimit, TARGET_RAW_BYTES } from '../lib/imageCompress.js';
import { getNearbyVenues, type Venue } from '../lib/hereApi.js';
import { findNearestPmLocations, type PmLocation } from '../lib/pinballmapApi.js';
import { redactVenue } from '../lib/venuePrivacy.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// The wizard allows 3 items, and a video item contributes its best 3 frames (extracted in the
// browser — the video itself never comes here), so up to 9 images can arrive in one request.
const MAX_IMAGES = 9;
// Photos further apart than this probably aren't the same game — surfaced as a non-blocking warning.
const SAME_GAME_MAX_MINUTES = 10;
const SAME_GAME_MAX_METERS = 200;

// `photos` (1–9, the current client) or the legacy single `photo`. multer's own errors (too many
// files, one over 20MB) would otherwise fall through to Express's default HTML 500.
const acceptPhotos = upload.fields([{ name: 'photos', maxCount: MAX_IMAGES }, { name: 'photo', maxCount: 1 }]);
function receivePhotos(req: Request, res: Response, next: NextFunction) {
  acceptPhotos(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Each photo must be under 20MB'
        : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT'
          ? `Up to ${MAX_IMAGES} images at a time`
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

router.post('/', requireAuth, receivePhotos, async (req, res) => {
  const fileMap = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
  const files = fileMap.photos?.length ? fileMap.photos : (fileMap.photo ?? []);
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
    const extracted = await extractScoreReads(images);
    const merged = mergeReads(extracted.reads);

    // Deterministic "may be missing digits" check against what's already recorded on this machine.
    // The machine here is only the AI's reading of the name; the wizard re-runs the same check via
    // /api/machines/score-stats once the user has actually picked one. Never fails the upload.
    const stats = extracted.machineName
      ? await getMachineScoreStats({ name: extracted.machineName }).catch(err => {
          console.error('Score plausibility lookup failed:', err?.message ?? err);
          return null;
        })
      : null;
    const plausibility = stats ? checkPlausibility(merged.template, stats.median, stats.count) : null;

    // GPS from the first photo that has any; playedAt from the earliest camera timestamp (zone-less
    // strings of one fixed shape, so they sort lexically).
    const gpsMeta = meta.find(m => m.latitude != null && m.longitude != null);
    const gps = gpsMeta ? { latitude: gpsMeta.latitude!, longitude: gpsMeta.longitude! } : null;
    const exifDatetime = meta.map(m => m.exifDatetime).filter((t): t is string => !!t).sort()[0] ?? null;

    let venueList: Venue[] = [];
    if (gps) {
      const { userId: clerkId } = getAuth(req);
      let requesterUserId: number | undefined;
      let isAdmin = false;
      if (clerkId) {
        const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
        requesterUserId = u?.id;
        isAdmin = u?.role === 'admin';
      }

      const [history, here, pmLocations] = await Promise.all([
        getHistoryVenues(gps.latitude, gps.longitude, requesterUserId, isAdmin),
        getNearbyVenues(gps.latitude, gps.longitude),
        // Venue suggestions are the point of this call; Pinball Map ids are a bonus on top. If PM is
        // down or the api_token is missing, the user should still get their venue list.
        findNearestPmLocations(gps.latitude, gps.longitude).catch(err => {
          console.error('Pinball Map lookup failed during upload:', err?.message ?? err);
          return [] as PmLocation[];
        }),
      ]);

      // History venues first; de-duplicate HERE results by hereId and name
      const hereIdsSeen = new Set(history.map(v => v.hereId).filter(Boolean));
      const namesSeen = new Set(history.map(v => v.name.toLowerCase()));

      const freshHere = here.filter(
        v => !hereIdsSeen.has(v.hereId) && !namesSeen.has(v.name.toLowerCase())
      );

      venueList = attachPinballMapIds([...history, ...freshHere], pmLocations);
    }

    res.json({
      machineName: extracted.machineName,
      // Only set when every digit was read — kept for older clients. `scoreRead` carries the rest.
      score: templateToScore(merged.template),
      scoreRead: {
        ...merged,
        bestImageIndex: extracted.bestImageIndex,
        perImage: extracted.reads.map(r => r.template),
        plausibility,
      },
      photoCount: files.length,
      differentGamesWarning: multi ? differentGamesWarning(meta) : null,
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
