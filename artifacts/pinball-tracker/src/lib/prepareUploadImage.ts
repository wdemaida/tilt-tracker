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
}

/** Long edge of the uploaded JPEG. Digits need to stay legible; Claude downsamples past ~1568px anyway. */
export const UPLOAD_MAX_EDGE = 2000;
export const UPLOAD_JPEG_QUALITY = 0.9;

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
  source: CanvasImageSource, width: number, height: number, maxEdge = UPLOAD_MAX_EDGE,
): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', UPLOAD_JPEG_QUALITY));
  if (!blob) throw new Error('JPEG encode failed');
  return blob;
}

async function downscale(blob: Blob): Promise<Blob | null> {
  try {
    // createImageBitmap applies EXIF orientation by default ('from-image'), so a portrait phone photo
    // stays upright after its EXIF is stripped by the re-encode.
    const bitmap = await createImageBitmap(blob);
    try {
      // Already small and already JPEG: re-encoding would only cost quality.
      if (Math.max(bitmap.width, bitmap.height) <= UPLOAD_MAX_EDGE && blob.type === 'image/jpeg') return blob;
      return await drawToJpeg(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** EXIF → HEIC conversion → downscale. Never throws; see the fallbacks above. */
export async function prepareUploadImage(file: File): Promise<PreparedImage> {
  const exif = await readExif(file);
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';

  let working: Blob = file;
  let heicFailed = false;
  if (isHeicFile(file)) {
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
  };
}
