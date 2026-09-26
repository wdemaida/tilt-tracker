// Prepares every photo for upload in the browser: EXIF first, then HEIC conversion, then a downscale.
//
// Why client-side: the server-side HEIC conversion (heic-convert, a pure-JS/WASM HEVC decoder) uses
// ~380MB RSS to decode even an ordinary 12MP iPhone photo — nearly the entire 512MB budget on a
// memory-constrained host. Doing it here moves that cost onto the user's own device and off a process
// shared by every concurrent request. See project_upload_crash_fix / feedback_render_oom_diagnosis
// memory for the incident this was built to prevent. Downscaling every upload to ~2000px (well above
// Claude's ~1568px effective vision resolution) also keeps multi-photo requests small, so the server
// never has to decode a 48MP original at all.
//
// Order matters: HEIC->JPEG conversion and canvas re-encoding both strip EXIF, so GPS/timestamp are
// read from the *original* file before anything else touches it.
//
// HEIC: the browser's native decoder is tried first (Safari 17+; see nativeHeicDownscale for why
// heic2any fails on 24MP+ photos on iPhones), then heic2any.
//
// Fallbacks: if HEIC conversion fails the original file is returned (`heicFailed: true`) — a single
// photo can still go up and use the server's own (slow, memory-heavy but functional) HEIC decode; the
// multi-photo path refuses that server-side, so the caller must reject it. If the downscale fails the
// converted/original blob is used as-is; the server's imageCompress.ts still keeps it under
// Anthropic's size limit.

export interface PreparedImage {
  file: Blob;
  filename: string;
  latitude: number | null;
  longitude: number | null;
  /** Zone-less camera wall clock ("2026-09-10T22:01:00"), or null. */
  exifDatetime: string | null;
  /**
   * An *instant* (ISO with Z) for when this was captured, when that's all we have — a video's `mvhd`
   * time (UTC) or the file's modified time. Never mixed into `exifDatetime`: rendering an instant as a
   * naive clock bakes in the *browser's* zone, and the form then re-reads it in the venue's zone.
   */
  capturedAt?: string | null;
  /** True when a HEIC photo couldn't be converted and `file` is still the original HEIC. */
  heicFailed: boolean;
  /**
   * Where the full-size photo (fullSizePhoto.ts) comes from, if this image becomes the score's photo.
   * Kept rather than encoded up front so only the one image the model picks is ever encoded at full
   * size. `ready` = already a GPS-free canvas JPEG within FULL_MAX_EDGE (video frames, whose <video>
   * is gone by the time the score saves); otherwise `blob` is a decodable original that still carries
   * EXIF/GPS and is always re-encoded. Absent = no full-size photo (e.g. `heicFailed`).
   */
  full?: { blob: Blob; ready: boolean; width?: number; height?: number };
}

/** Long edge of the uploaded JPEG. Digits need to stay legible; Claude downsamples past ~1568px anyway. */
export const UPLOAD_MAX_EDGE = 2000;
export const UPLOAD_JPEG_QUALITY = 0.9;

/**
 * Long edge of the full-size photo kept on R2. iOS Safari refuses canvases over ~16.7MP (4096×4096),
 * and a 24MP iPhone photo is 5712×4284 — so 4096 is both the storage cap and the canvas-safe size.
 */
export const FULL_MAX_EDGE = 4096;
export const FULL_JPEG_QUALITY = 0.92;

/** A size that fits within `maxEdge` on its long side, never upscaled. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toNaiveLocal(dt: Date): string {
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}` +
    `T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

export function isHeicFile(file: File): boolean {
  return file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
}

async function readExif(file: Blob): Promise<{ latitude: number | null; longitude: number | null; exifDatetime: string | null }> {
  try {
    const Exifr = (await import('exifr')).default;
    const [gps, tags] = await Promise.all([
      Exifr.gps(file).catch(() => null),
      Exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'] }).catch(() => null),
    ]);
    const dt = tags?.DateTimeOriginal ?? tags?.CreateDate;
    return {
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      // Zone-less wall clock, matching what the server's own EXIF path returns. exifr builds this
      // Date by reading the camera's naive digits in *this* machine's timezone, so the local getters
      // are the only way back to the digits themselves — `toISOString()` would bake the browser's
      // offset in and make the two upload paths disagree.
      exifDatetime: dt instanceof Date && !Number.isNaN(dt.getTime()) ? toNaiveLocal(dt) : null,
    };
  } catch {
    return { latitude: null, longitude: null, exifDatetime: null };
  }
}

/**
 * Draws a decodable image source to a canvas no larger than UPLOAD_MAX_EDGE and encodes a JPEG.
 * Shared with the video frame extractor, which hands in a <video> element.
 */
export async function drawToJpeg(
  source: CanvasImageSource, width: number, height: number, maxEdge = UPLOAD_MAX_EDGE, quality = UPLOAD_JPEG_QUALITY,
): Promise<Blob> {
  const size = fitWithin(width, height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  // Free the backing store now rather than at GC — matters on iOS, which caps total canvas memory.
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('JPEG encode failed');
  return blob;
}

async function downscaleBitmap(bitmap: ImageBitmap, blob: Blob): Promise<Blob> {
  // Already small and already JPEG: re-encoding would only cost quality.
  if (Math.max(bitmap.width, bitmap.height) <= UPLOAD_MAX_EDGE && blob.type === 'image/jpeg') return blob;
  return drawToJpeg(bitmap, bitmap.width, bitmap.height);
}

async function downscale(blob: Blob): Promise<Blob | null> {
  try {
    // createImageBitmap applies EXIF orientation by default ('from-image'), so a portrait phone photo
    // stays upright after its EXIF is stripped by the re-encode.
    const bitmap = await createImageBitmap(blob);
    try {
      return await downscaleBitmap(bitmap, blob);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * Decodes a HEIC with the browser's own decoder (Safari 17+ has one; Chrome/Firefox on Windows
 * don't and throw) and downscales it — no full-resolution canvas involved. heic2any, by contrast,
 * paints the *whole* decoded image into one canvas before encoding: a 24MP (5712×4284) or 48MP
 * iPhone HEIC exceeds iOS Safari's ~16.7MP canvas limit, `toBlob` comes back null, and the photo
 * falls into the `heicFailed` path (server-side decode). Trying the native decoder first avoids that
 * wherever it exists. Null when the browser can't decode it.
 */
async function nativeHeicDownscale(file: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    return await drawToJpeg(bitmap, bitmap.width, bitmap.height);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** EXIF → HEIC conversion → downscale. Never throws; see the fallbacks above. */
export async function prepareUploadImage(file: File): Promise<PreparedImage> {
  const exif = await readExif(file);
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';

  let working: Blob = file;
  let heicFailed = false;
  if (isHeicFile(file)) {
    const native = await nativeHeicDownscale(file);
    if (native) {
      // The original HEIC is the full-size source: the same native decoder re-reads it later.
      return { file: native, filename: `${baseName}.jpg`, ...exif, heicFailed: false, full: { blob: file, ready: false } };
    }
    try {
      const heic2any = (await import('heic2any')).default;
      const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: UPLOAD_JPEG_QUALITY });
      working = Array.isArray(converted) ? converted[0] : converted;
    } catch {
      heicFailed = true;
    }
  }

  if (heicFailed) return { file, filename: file.name, ...exif, heicFailed };

  const scaled = await downscale(working);
  const out = scaled ?? working;
  const isJpeg = out.type === 'image/jpeg';
  return {
    file: out,
    filename: isJpeg ? `${baseName}.jpg` : file.name,
    ...exif,
    heicFailed: false,
    // Pre-downscale: the camera original, or heic2any's full-resolution JPEG. Re-encoded (and so
    // stripped of EXIF/GPS) before it's ever uploaded — see fullSizePhoto.ts.
    full: { blob: working, ready: false },
  };
}
