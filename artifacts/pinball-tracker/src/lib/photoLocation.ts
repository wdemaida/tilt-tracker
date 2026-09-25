// Photo location: did the picked photos carry GPS, and if not, can the device's current position
// stand in for venue *suggestions*?
//
// What a web page can and can't know. It cannot read whether the phone's Camera app geotags photos.
// It can see whether a picked file actually has GPS (read client-side in prepareUploadImage.ts /
// videoFrames.ts), the site's geolocation permission state (Permissions API — not everywhere), and
// the device's position, but only via a user-initiated prompt.
//
// Privacy: a current position is only ever used to fetch venue suggestions. It never becomes the
// photo's GPS or the score's latitude/longitude — AddScorePage keeps it out of the `gps` state that
// is spread into the saved score — and the server route stores nothing.

import type { PreparedImage } from './prepareUploadImage';

/** A photo taken within this long of now is treated as "you're probably still at the venue". */
export const RECENT_PHOTO_MS = 2 * 60 * 60 * 1000;

export type PhotoRecency = 'recent' | 'old' | 'unknown';

/** Where the picked files came from: the in-browser camera input, or the photo/video picker. */
export type PhotoSource = 'camera' | 'picker';

export interface PhotoLocationInfo {
  hasGps: boolean;
  recency: PhotoRecency;
  /** True when every file came from the "Take photo" (capture) input. */
  fromCamera: boolean;
}

/** Latest capture time across the set, in ms since epoch — or null when none has one. */
function latestCaptureMs(images: PreparedImage[]): number | null {
  let latest: number | null = null;
  for (const im of images) {
    // exifDatetime is a zone-less camera wall clock; a date-time string with no offset parses as the
    // browser's local time, which is the right frame for "was this taken just now, here?".
    const candidates = [im.exifDatetime, im.capturedAt].filter((t): t is string => !!t);
    for (const t of candidates) {
      const ms = Date.parse(t);
      if (Number.isFinite(ms) && (latest == null || ms > latest)) latest = ms;
    }
  }
  return latest;
}

export function describePhotoLocation(images: PreparedImage[], fromCamera: boolean, now = Date.now()): PhotoLocationInfo {
  const hasGps = images.some(im => im.latitude != null && im.longitude != null);
  const t = latestCaptureMs(images);
  // A little future skew is tolerated (camera clock slightly ahead of the browser's).
  const recency: PhotoRecency = t == null ? 'unknown' : (now - t <= RECENT_PHOTO_MS && t - now <= 10 * 60 * 1000 ? 'recent' : 'old');
  return { hasGps, recency, fromCamera };
}

/**
 * How to offer "Use my current location" when no photo had GPS. It's always offered — the user taps
 * it, so they're the one saying "I'm still here" — but its prominence follows the photo's age:
 *  - 'primary': the photo looks like it was taken just now (within RECENT_PHOTO_MS), or we can't
 *    tell its age at all (camera input; or a picked file with no timestamp — screenshots and photos
 *    forwarded through messaging apps arrive with EXIF stripped). Nothing suggests they've left.
 *  - 'secondary': the photo's own clock says it's older — they may have gone home, so manual search
 *    leads and current location is a quieter "still there?" link. (2026-09-25: users with an old,
 *    GPS-less photo typed a new venue by hand, one of them duplicating an existing venue.)
 */
export type CurrentLocationOffer = 'primary' | 'secondary';

export function currentLocationOffer(info: PhotoLocationInfo): CurrentLocationOffer {
  return info.recency === 'old' ? 'secondary' : 'primary';
}

export type Platform = 'ios' | 'android' | 'other';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as desktop Safari on a Mac; touch points give it away.
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export type GeoPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/** The site's geolocation permission, where the Permissions API exposes it. Never prompts. */
export async function queryGeoPermission(): Promise<GeoPermission> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state === 'granted' || status.state === 'prompt' || status.state === 'denied' ? status.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type GeoFailure = 'unsupported' | 'denied' | 'unavailable' | 'timeout';

export class CurrentPositionError extends Error {
  constructor(public reason: GeoFailure) {
    super(reason);
  }
}

export interface CurrentPosition {
  latitude: number;
  longitude: number;
  /** Metres, as reported by the browser. */
  accuracy: number;
}

/** One high-accuracy fix. Call only from a user gesture — this is what shows the permission prompt. */
export function getCurrentPosition(timeoutMs = 15000): Promise<CurrentPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new CurrentPositionError('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      p => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      err => reject(new CurrentPositionError(
        err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable',
      )),
      // A fix up to a minute old is still "here"; anything older might be the last venue.
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

export function geoFailureMessage(reason: GeoFailure): string {
  switch (reason) {
    case 'denied':
      return "Location is blocked for this site, so we can't look up venues near you. You can allow it in your browser's site settings — or just pick the venue below.";
    case 'timeout':
      return "Couldn't get your location in time. Try again, or pick the venue below.";
    case 'unsupported':
      return "This browser can't share your location. Pick the venue below.";
    default:
      return "Couldn't find your location right now. Try again, or pick the venue below.";
  }
}
