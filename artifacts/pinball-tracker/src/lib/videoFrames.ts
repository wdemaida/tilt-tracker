// Turns a short video of a score display into a few sharp still frames, entirely in the browser.
//
// Why video at all: an old multiplexed 7-segment / gas-plasma display lights its digits in turn, so a
// single fast-shutter photo often catches some of them dark. A second or two of video almost always
// contains frames where each digit is lit. We never upload the video — frames are sampled here,
// scored for sharpness, and the best few (spread out in time, so they catch different refresh
// phases) go through the existing multi-image pipeline as if they were photos.
//
// Browser decode support is the main failure mode: e.g. an iPhone HEVC .mov won't decode in Chrome
// on Windows. That surfaces as a friendly VideoFrameError, never a broken wizard.

import { drawToJpeg, toNaiveLocal, type PreparedImage } from './prepareUploadImage';

export const MAX_VIDEO_SECONDS = 10;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Frames sampled across the clip for sharpness scoring. */
export const VIDEO_SAMPLE_FRAMES = 15;
/** Frames actually sent for reading. */
export const VIDEO_FRAMES_TO_SEND = 3;
/** Long edge of the small grayscale copy used for sharpness scoring. */
const SHARPNESS_EDGE = 320;
const EVENT_TIMEOUT_MS = 8000;

export const VIDEO_TOO_LONG_MESSAGE = `Keep videos under ${MAX_VIDEO_SECONDS} seconds — just point at the score for a second or two.`;
export const VIDEO_TOO_BIG_MESSAGE = `That video is over ${MAX_VIDEO_BYTES / 1024 / 1024}MB — keep it to a second or two of the score.`;
export const VIDEO_UNSUPPORTED_MESSAGE = "This video format isn't supported in this browser — try a photo instead.";

export class VideoFrameError extends Error {}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|3gp|3g2|mkv)$/i.test(file.name);
}

// ---------------------------------------------------------------------------
// Metadata: GPS + capture time
// ---------------------------------------------------------------------------

interface VideoMeta { latitude: number | null; longitude: number | null; exifDatetime: string | null }

const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const QT_EPOCH_OFFSET_S = 2082844800; // seconds from 1904-01-01 to 1970-01-01

/** Finds the top-level `moov` box of an MP4/QuickTime file without reading the whole file. */
async function readMoov(file: Blob): Promise<Uint8Array | null> {
  let offset = 0;
  for (let guard = 0; guard < 64 && offset + 8 <= file.size; guard++) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerLen = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = Number(head.getBigUint64(8));
      headerLen = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < headerLen) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES) return null;
      return new Uint8Array(await file.slice(offset + headerLen, offset + size).arrayBuffer());
    }
    offset += size;
  }
  return null;
}

/**
 * Reads GPS and capture time from a QuickTime/MP4 `moov` box. Deliberately a byte scan rather than a
 * full box parser: iPhones store location as an ISO 6709 string under the
 * `com.apple.quicktime.location.ISO6709` key and the capture time as `com.apple.quicktime.creationdate`
 * (a wall clock *with* its offset, which is exactly what we want); Android/older files use a `©xyz`
 * atom holding the same ISO 6709 string. `mvhd` creation time (UTC) is the fallback.
 */
async function readQuickTimeMeta(file: Blob): Promise<VideoMeta> {
  const out: VideoMeta = { latitude: null, longitude: null, exifDatetime: null };
  const moov = await readMoov(file).catch(() => null);
  if (!moov) return out;
  // A single-byte decoding keeps one char per byte, so string indexes line up with the buffer.
  const text = new TextDecoder('latin1').decode(moov);

  const loc = text.match(/([+-]\d{2}\.\d+)([+-]\d{3}\.\d+)(?:[+-]\d+(?:\.\d+)?)?\//);
  if (loc) {
    const lat = Number(loc[1]);
    const lng = Number(loc[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
      out.latitude = lat;
      out.longitude = lng;
    }
  }

  // Apple's creationdate is the camera's own wall clock plus offset — take the digits verbatim.
  const created = text.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})[+-]\d{2}:?\d{2}/);
  if (created) {
    out.exifDatetime = `${created[1]}T${created[2]}`;
  } else {
    const mvhd = text.indexOf('mvhd');
    if (mvhd >= 0 && mvhd + 16 <= moov.length) {
      const view = new DataView(moov.buffer, moov.byteOffset + mvhd + 4);
      const version = view.getUint8(0);
      const qtSeconds = version === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4);
      if (qtSeconds > QT_EPOCH_OFFSET_S) {
        // An instant (UTC); rendered on this device's clock, the same assumption photo EXIF makes.
        out.exifDatetime = toNaiveLocal(new Date((qtSeconds - QT_EPOCH_OFFSET_S) * 1000));
      }
    }
  }
  return out;
}

async function readVideoMeta(file: File): Promise<VideoMeta> {
  let meta: VideoMeta = { latitude: null, longitude: null, exifDatetime: null };
  // exifr first, in case a future version (or an unusual container) handles it; it currently
  // doesn't read QuickTime, which is what the moov scan below is for.
  try {
    const Exifr = (await import('exifr')).default;
    const gps = await Exifr.gps(file).catch(() => null);
    if (gps?.latitude != null && gps?.longitude != null) meta = { ...meta, latitude: gps.latitude, longitude: gps.longitude };
  } catch { /* not supported for video — expected */ }
  const qt = await readQuickTimeMeta(file).catch(() => meta);
  return {
    latitude: meta.latitude ?? qt.latitude,
    longitude: meta.longitude ?? qt.longitude,
    // Last resort for the time: the file's own modified time. No GPS fallback — the venue step
    // already copes with none (search, or pick from your venues).
    exifDatetime: qt.exifDatetime ?? (file.lastModified ? toNaiveLocal(new Date(file.lastModified)) : null),
  };
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function once(target: EventTarget, ok: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new VideoFrameError(VIDEO_UNSUPPORTED_MESSAGE)); }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new VideoFrameError(VIDEO_UNSUPPORTED_MESSAGE)); };
    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener('error', onErr);
    }
    target.addEventListener(ok, onOk);
    target.addEventListener('error', onErr);
  });
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 0.001) return;
  const done = once(video, 'seeked');
  video.currentTime = t;
  await done;
  // 'seeked' means the position is set; where supported, also wait for the frame to be presented so
  // drawImage can't grab the previous one. Bounded — some browsers don't fire it for paused seeks.
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  if (typeof v.requestVideoFrameCallback === 'function') {
    await Promise.race([
      new Promise<void>(resolve => v.requestVideoFrameCallback!(() => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 120)),
    ]);
  }
}

/**
 * Variance of the Laplacian over a grayscale image — the standard cheap focus measure. Blurry frames
 * (motion, focus hunting) have little high-frequency energy and score low.
 */
export function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += l;
      sumSq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function sharpnessOf(video: HTMLVideoElement, canvas: HTMLCanvasElement): number {
  const scale = Math.min(1, SHARPNESS_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(3, Math.round(video.videoWidth * scale));
  const h = Math.max(3, Math.round(video.videoHeight * scale));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return laplacianVariance(gray, w, h);
}

/**
 * Picks `count` samples spread across the clip: split the samples into `count` consecutive time
 * windows and take the sharpest from each. Spreading matters as much as sharpness — frames a few
 * refresh cycles apart are what light different digits.
 */
export function pickSpreadSharpest(scores: number[], count: number): number[] {
  if (scores.length <= count) return scores.map((_, i) => i);
  const picked: number[] = [];
  for (let k = 0; k < count; k++) {
    const start = Math.floor((k * scores.length) / count);
    const end = Math.floor(((k + 1) * scores.length) / count);
    let best = start;
    for (let i = start; i < end; i++) if (scores[i] > scores[best]) best = i;
    picked.push(best);
  }
  return picked;
}

export interface FrameProgress { done: number; total: number }

/** Samples, scores and returns the best frames of a short video as upload-ready JPEGs. */
export async function extractVideoFrames(file: File, onProgress?: (p: FrameProgress) => void): Promise<PreparedImage[]> {
  if (file.size > MAX_VIDEO_BYTES) throw new VideoFrameError(VIDEO_TOO_BIG_MESSAGE);

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.preload = 'auto';

  try {
    const metaReady = once(video, 'loadedmetadata');
    video.src = url;
    await metaReady;

    const duration = video.duration;
    if (Number.isFinite(duration) && duration > MAX_VIDEO_SECONDS) throw new VideoFrameError(VIDEO_TOO_LONG_MESSAGE);
    // Audio-only decode (HEVC video in a browser without HEVC) reports no picture size.
    if (!video.videoWidth || !video.videoHeight) throw new VideoFrameError(VIDEO_UNSUPPORTED_MESSAGE);
    if (video.readyState < 2) await once(video, 'loadeddata');
    if (!Number.isFinite(duration) || duration <= 0) throw new VideoFrameError(VIDEO_UNSUPPORTED_MESSAGE);

    const metaPromise = readVideoMeta(file);

    const total = VIDEO_SAMPLE_FRAMES + VIDEO_FRAMES_TO_SEND;
    const times = Array.from({ length: VIDEO_SAMPLE_FRAMES }, (_, i) =>
      duration * (0.05 + (0.9 * i) / Math.max(1, VIDEO_SAMPLE_FRAMES - 1)));
    const scratch = document.createElement('canvas');
    const scores: number[] = [];
    for (let i = 0; i < times.length; i++) {
      await seek(video, times[i]);
      scores.push(sharpnessOf(video, scratch));
      onProgress?.({ done: i + 1, total });
    }

    const picked = pickSpreadSharpest(scores, VIDEO_FRAMES_TO_SEND);
    const meta = await metaPromise;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'video';
    const frames: PreparedImage[] = [];
    for (let k = 0; k < picked.length; k++) {
      await seek(video, times[picked[k]]);
      const blob = await drawToJpeg(video, video.videoWidth, video.videoHeight);
      frames.push({
        file: blob,
        filename: `${baseName}-frame-${k + 1}.jpg`,
        latitude: meta.latitude,
        longitude: meta.longitude,
        exifDatetime: meta.exifDatetime,
        heicFailed: false,
      });
      onProgress?.({ done: VIDEO_SAMPLE_FRAMES + k + 1, total });
    }
    if (frames.length === 0) throw new VideoFrameError(VIDEO_UNSUPPORTED_MESSAGE);
    return frames;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
