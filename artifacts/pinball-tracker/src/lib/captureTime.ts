// Which capture time a video gets, and whether it's the recording's own (pure — no DOM, unit-tested
// in captureTime.test.ts).
//
// Only metadata *inside* the file says when it was recorded: Apple's `creationdate` (a camera wall
// clock) or the QuickTime `mvhd` creation time (an instant). The file's modified time is a last
// resort for filling in the form — a forwarded or re-saved video has had its metadata stripped and
// that time is when it was saved, not played — so it never locks the score's played time
// (played_at_source stays 'manual'; see the api-server's lib/playedAtProvenance.ts).

export type CaptureTimeSource = 'container' | 'file';

export interface VideoCaptureTime {
  /** Apple's creationdate, zone-less ("2026-09-10T22:01:00") — goes up to /api/upload like EXIF. */
  exifDatetime: string | null;
  /** An instant (ISO, UTC): mvhd, else the file's modified time. Null when exifDatetime is set. */
  capturedAt: string | null;
  /** Where `capturedAt` came from; null when there is none (or exifDatetime carries the time). */
  capturedAtSource: CaptureTimeSource | null;
}

export function pickVideoCaptureTime(found: {
  creationdate: string | null;
  mvhd: string | null;
  lastModified: number | null | undefined;
}): VideoCaptureTime {
  if (found.creationdate) return { exifDatetime: found.creationdate, capturedAt: null, capturedAtSource: null };
  if (found.mvhd) return { exifDatetime: null, capturedAt: found.mvhd, capturedAtSource: 'container' };
  if (found.lastModified) {
    return { exifDatetime: null, capturedAt: new Date(found.lastModified).toISOString(), capturedAtSource: 'file' };
  }
  return { exifDatetime: null, capturedAt: null, capturedAtSource: null };
}

/**
 * The wizard's played-time lock for an upload result. `photo`/`video` = shown read-only and saved
 * with the server's token (or, for an mvhd time, as a 'video' claim); `unverified` = a video's
 * file-modified time — editable, with a "check the time" note; null = an ordinary editable time.
 */
export type PlayedTimeLock =
  | { kind: 'photo' | 'video'; token: string | null }
  | { kind: 'unverified' }
  | null;

export function playedTimeLockFor(input: {
  /** /api/upload's `playedAtSource` and `playedAtToken`. */
  serverSource: 'photo' | 'video' | null | undefined;
  serverToken: string | null | undefined;
  /** The instant the form used instead, and where it came from (a video with no creationdate). */
  instantSource: CaptureTimeSource | null;
}): PlayedTimeLock {
  if (input.serverSource && input.serverToken) return { kind: input.serverSource, token: input.serverToken };
  if (input.serverSource) return null; // camera time, but the server couldn't sign it: stays editable
  if (input.instantSource === 'container') return { kind: 'video', token: null };
  if (input.instantSource === 'file') return { kind: 'unverified' };
  return null;
}

/** scores.played_at_source as the API returns it; null = a legacy score (editable). */
export type PlayedAtSource = 'photo' | 'video' | 'manual' | null;

/** A camera-recorded played time — the player can't change it, only an admin (with a reason). */
export const isLockedPlayedAt = (s: unknown): s is 'photo' | 'video' => s === 'photo' || s === 'video';

/** "photo" / "video", for "From your photo" and "(time from your video)". */
export const lockedFromLabel = (s: 'photo' | 'video') => (s === 'video' ? 'video' : 'photo');
