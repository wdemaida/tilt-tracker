import { Router } from 'express';
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
import { fitUnderAnthropicLimit } from '../lib/imageCompress.js';
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
    // isn't in its Options type, and this matches the client-side path in heicClientConvert.ts.
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

router.post('/', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const originalBuffer = req.file.buffer;
    let buffer = originalBuffer;
    let mimeType = req.file.mimetype;

    // The frontend extracts GPS/EXIF from HEIC photos client-side before converting them, since
    // conversion strips EXIF and doing the conversion client-side avoids the memory-heavy server-side
    // HEIC decode for the common case (see imageCompress.ts). Falls back to server-side extraction
    // when absent — non-HEIC uploads, or the client's conversion attempt failed.
    const clientLat = req.body.latitude != null ? Number(req.body.latitude) : null;
    const clientLng = req.body.longitude != null ? Number(req.body.longitude) : null;
    // The client sends the same zone-less shape `toNaiveLocal` produces (heicClientConvert.ts), but
    // normalize anyway so a stale client can't reintroduce a `Z` the frontend would misread.
    const clientExifDatetime = normalizeNaiveDatetime(
      typeof req.body.exifDatetime === 'string' ? req.body.exifDatetime : null
    );
    const hasClientGps = clientLat != null && !Number.isNaN(clientLat) && clientLng != null && !Number.isNaN(clientLng);

    const [serverGps, serverExifDatetime] = await Promise.all([
      hasClientGps ? Promise.resolve(null) : extractGps(originalBuffer),
      clientExifDatetime ? Promise.resolve(null) : extractExifDatetime(originalBuffer),
    ]);
    const gps = hasClientGps ? { latitude: clientLat!, longitude: clientLng! } : serverGps;
    const exifDatetime = clientExifDatetime ?? serverExifDatetime;

    let thumbnailBase64: string | null = null;
    if (mimeType === 'image/heic' || mimeType === 'image/heif' || req.file.originalname.toLowerCase().endsWith('.heic')) {
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
    const fitted = await fitUnderAnthropicLimit(buffer, mimeType);
    const base64 = fitted.buffer.toString('base64');
    const extracted = await extractScoreReads([{ base64, mimeType: fitted.mimeType }]);
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
      // Zone-less wall clock ("2026-09-10T22:01:00") — see toNaiveLocal. The browser resolves it
      // against the viewer's timezone; do not hand this to `new Date()` on the server.
      playedAt: exifDatetime ?? normalizeNaiveDatetime(extracted.playedAt),
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      venues: venueList,
      thumbnailBase64,
    });
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Failed to process photo — please try again' });
  }
});

export default router;
