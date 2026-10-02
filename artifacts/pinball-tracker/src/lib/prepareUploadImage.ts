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
// Memory (added 2026-10-01 — an Android tab with a 200MP camera was being killed): decodes go
// straight to the size they're drawn at (decodeScaled — a full-resolution 200MP bitmap is ~800MB),
// and one at a time across this file and fullSizePhoto.ts (withDecodeLock).
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

import type { CaptureTimeSource } from './captureTime';
import { fitWithin, readJpegSize, scaledBitmapUsable, type Size } from './imageSize';

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
  /** Where `capturedAt` came from — inside the video file, or its modified time (captureTime.ts). */
  capturedAtSource?: CaptureTimeSource | null;
  /** 'video' for a video frame: its `exifDatetime` is Apple's creationdate, and the score's source is 'video'. */
  timeKind?: 'photo' | 'video';
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

export { fitWithin };

/**
 * One large decode at a time, across prepareUploadImage and the background full-size encode
 * (fullSizePhoto.ts) — two 4096px bitmaps plus their canvases alive at once is ~250MB, enough to
 * get a tab with little headroom killed on Android. FIFO; a failed task doesn't block the next.
 */
let decodeTail: Promise<unknown> = Promise.resolve();
export function withDecodeLock<T>(task: () => Promise<T>): Promise<T> {
  const run = decodeTail.then(task, task);
  decodeTail = run.catch(() => undefined);
  return run;
}

/**
 * The displayed (EXIF-oriented) size of an image without decoding its pixels: a JPEG's header, else
 * an `<img>`'s natural size (browsers decode an unattached `<img>` lazily, and natural size honours
 * orientation). Null when neither works — the caller then decodes at full size, as before.
 */
export async function imageSourceSize(blob: Blob): Promise<Size | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
    const jpeg = readJpegSize(head);
    if (jpeg) return { width: jpeg.width, height: jpeg.height };
  } catch {
    // Unreadable as bytes: the decode below will fail the same way.
  }
  const loaded = await loadImage(blob);
  if (!loaded) return null;
  const { naturalWidth: width, naturalHeight: height } = loaded.img;
  loaded.release();
  return width && height ? { width, height } : null;
}

/** `blob` in an unattached `<img>` — loaded, not yet decoded — or null if the browser can't read it. */
async function loadImage(blob: Blob): Promise<{ img: HTMLImageElement; release: () => void } | null> {
  if (typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  const img = new Image();
  const release = () => {
    img.onload = img.onerror = null;
    img.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  const ok = await new Promise<boolean>(resolve => {
    img.decoding = 'async';
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  if (!ok) {
    release();
    return null;
  }
  return { img, release };
}

/**
 * Draws `blob` into a `target`-sized canvas through an `<img>`, or null when this route isn't
 * available. Measured in Edge 2026-10-01 on a 200MP (16320×12240) JPEG — renderer peak: ~80MB this
 * way (Chromium decodes a JPEG at a reduced DCT scale when it's drawn small onto a CPU-backed
 * canvas), ~800MB for createImageBitmap even *with* resize options (it decodes in full, then
 * resizes), ~300MB drawing onto a GPU-backed canvas. Hence `willReadFrequently`, which keeps the
 * canvas on the CPU.
 */
async function drawImageScaled(blob: Blob, source: Size, target: Size): Promise<HTMLCanvasElement | null> {
  if (typeof document === 'undefined') return null;
  const loaded = await loadImage(blob);
  if (!loaded) return null;
  const canvas = document.createElement('canvas');
  let drawn = false;
  try {
    const { img } = loaded;
    // naturalWidth/Height are the EXIF-oriented size and drawImage draws oriented, in every current
    // browser. If they disagree with the oriented size `source` came from (a JPEG's header), this
    // browser doesn't do one of those — don't risk a sideways or squashed photo.
    if (img.naturalWidth !== source.width || img.naturalHeight !== source.height) return null;
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, target.width, target.height);
    // Drawing is deferred; a 1px read makes it happen now, while the <img> is still loaded.
    ctx.getImageData(0, 0, 1, 1);
    drawn = true;
    return canvas;
  } catch {
    return null;
  } finally {
    loaded.release();
    if (!drawn) canvas.width = canvas.height = 0;
  }
}

export interface ScaledDecode {
  /** The decoded image, `width`×`height` — drawn or encoded by the caller, then `close()`d. */
  source: HTMLCanvasElement | ImageBitmap;
  width: number;
  height: number;
  /** The source's displayed size (EXIF orientation applied), or the decoded size when it couldn't be read. */
  sourceWidth: number;
  sourceHeight: number;
  /** Frees the pixels now rather than at GC. */
  close: () => void;
}

/**
 * Decodes `blob` straight to ≤`maxEdge` on its long side, so a 50–200MP original never becomes a
 * full-resolution bitmap where the browser can help it. EXIF orientation is applied on every route.
 * In order:
 * 1. `<img>` drawn into a target-sized CPU canvas (drawImageScaled — the leanest by far in Chromium).
 * 2. createImageBitmap with resize options: off the main thread, a small result, though Chromium
 *    still decodes in full transiently. Only `resizeWidth` is passed — the browser derives the height
 *    from its own (oriented) aspect ratio, so a wrong size guess can't squash the photo — and
 *    `scaledBitmapUsable` rejects a bitmap that came out the wrong shape or size (e.g. a browser that
 *    resizes before applying EXIF orientation).
 * 3. The old plain full-size decode, also used when the size is unknown or already ≤ `maxEdge`.
 * Throws when the image can't be decoded at all.
 */
export async function decodeScaled(blob: Blob, maxEdge: number, size?: Size | null): Promise<ScaledDecode> {
  const source = size === undefined ? await imageSourceSize(blob) : size;
  if (source && Math.max(source.width, source.height) > maxEdge) {
    const target = fitWithin(source.width, source.height, maxEdge);
    const sourceSize = { sourceWidth: source.width, sourceHeight: source.height };
    const canvas = await drawImageScaled(blob, source, target);
    if (canvas) {
      return { source: canvas, ...target, ...sourceSize, close: () => { canvas.width = canvas.height = 0; } };
    }
    let scaled: ImageBitmap | null = null;
    try {
      scaled = await createImageBitmap(blob, { resizeWidth: target.width, resizeQuality: 'high' });
    } catch {
      scaled = null; // resize options unsupported, or this decode path failed: try the plain one
    }
    if (scaled) {
      const bitmap = scaled;
      if (scaledBitmapUsable(bitmap, target)) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height, ...sourceSize, close: () => bitmap.close() };
      }
      bitmap.close();
    }
  }
  const bitmap = await createImageBitmap(blob);
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    sourceWidth: source?.width ?? bitmap.width,
    sourceHeight: source?.height ?? bitmap.height,
    close: () => bitmap.close(),
  };
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
  // A canvas already at the output size (decodeScaled's) is encoded as is — no second copy. Its
  // owner frees it.
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement
    && source.width === size.width && source.height === size.height) {
    const direct = await new Promise<Blob | null>(resolve => source.toBlob(resolve, 'image/jpeg', quality));
    if (!direct) throw new Error('JPEG encode failed');
    return direct;
  }
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

async function downscale(blob: Blob): Promise<Blob | null> {
  try {
    const size = await imageSourceSize(blob);
    // Already small and already JPEG: re-encoding would only cost quality (no decode needed to know).
    if (size && Math.max(size.width, size.height) <= UPLOAD_MAX_EDGE && blob.type === 'image/jpeg') return blob;
    // Decoded straight to ≤UPLOAD_MAX_EDGE where the browser can (decodeScaled). EXIF orientation
    // is applied, so a portrait phone photo stays upright after the re-encode strips its EXIF.
    const decoded = await decodeScaled(blob, UPLOAD_MAX_EDGE, size);
    try {
      // Size unknown until decoded (the old check): small JPEG, keep it.
      if (!size && Math.max(decoded.width, decoded.height) <= UPLOAD_MAX_EDGE && blob.type === 'image/jpeg') return blob;
      return await drawToJpeg(decoded.source, decoded.width, decoded.height);
    } finally {
      decoded.close();
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
  let decoded: ScaledDecode;
  try {
    decoded = await decodeScaled(file, UPLOAD_MAX_EDGE);
  } catch {
    return null;
  }
  try {
    return await drawToJpeg(decoded.source, decoded.width, decoded.height);
  } catch {
    return null;
  } finally {
    decoded.close();
  }
}

/** EXIF → HEIC conversion → downscale. Never throws; see the fallbacks above. */
export async function prepareUploadImage(file: File): Promise<PreparedImage> {
  const exif = await readExif(file);
  // Every decode below is reduced-size where possible and holds the decode lock, so the background
  // full-size encode of an earlier photo never runs alongside it.
  return withDecodeLock(() => convertAndDownscale(file, exif));
}

async function convertAndDownscale(file: File, exif: Awaited<ReturnType<typeof readExif>>): Promise<PreparedImage> {
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
