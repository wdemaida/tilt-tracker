import { Router } from 'express';
import multer from 'multer';
import Exifr from 'exifr';
import { and, between } from 'drizzle-orm';
import { db, venues } from '@workspace/db';
import { requireAuth } from '../middleware/requireAuth.js';
import { extractScoreFromImage } from '../lib/anthropic.js';
import { getNearbyVenues, type Venue } from '../lib/hereApi.js';
import { findNearestPmLocations, type PmLocation } from '../lib/pinballmapApi.js';

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

async function getHistoryVenues(lat: number, lng: number): Promise<Venue[]> {
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

  return rows.map(v => ({
    venueId: v.id,
    name: v.name,
    address: v.address ?? '',
    distance: Math.round(haversineM(lat, lng, v.latitude!, v.longitude!)),
    hereId: v.hereId,
    source: 'history' as const,
  }));
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

  const originalBuffer = req.file.buffer;
  let buffer = originalBuffer;
  let mimeType = req.file.mimetype;

  const gps = await extractGps(originalBuffer);

  if (mimeType === 'image/heic' || mimeType === 'image/heif' || req.file.originalname.toLowerCase().endsWith('.heic')) {
    try {
      const heicConvert = (await import('heic-convert')).default;
      buffer = Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: 0.9 }));
      mimeType = 'image/jpeg';
    } catch {
      return res.status(422).json({ error: 'Failed to convert HEIC image' });
    }
  }

  const base64 = buffer.toString('base64');
  const extracted = await extractScoreFromImage(base64, mimeType);

  let venueList: Venue[] = [];
  if (gps) {
    const [history, here, pmLocations] = await Promise.all([
      getHistoryVenues(gps.latitude, gps.longitude),
      getNearbyVenues(gps.latitude, gps.longitude),
      findNearestPmLocations(gps.latitude, gps.longitude),
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
    score: extracted.score,
    playedAt: extracted.playedAt,
    latitude: gps?.latitude ?? null,
    longitude: gps?.longitude ?? null,
    venues: venueList,
  });
});

export default router;
