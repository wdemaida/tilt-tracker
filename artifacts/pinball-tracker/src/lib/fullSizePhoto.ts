// Full-size score photos: encode in the browser, upload straight to Cloudflare R2, confirm with the
// api-server. The upload runs after the score has saved (so a failure never loses a score, and there's
// a score id to key the object by), in the background — AddScorePage shows a small status line.
//
// What goes up is never the camera original: the chosen image's source (PreparedImage.full) is
// decoded and redrawn through a canvas, which drops EXIF — GPS included, which matters for home
// venues — capped at FULL_MAX_EDGE (iOS Safari's canvas limit) and encoded as JPEG. Video frames
// arrive already encoded that way.
//
// Encoding starts when the image is picked (FullPhotoEncoder), not when the score saves: on Android,
// a gallery/cloud File picked minutes earlier may no longer be readable by then (added 2026-09-29 after
// an Android user's photos silently never uploaded). If the full-size encode fails anyway (a HEIF
// Chrome can't decode, running out of memory on a 50–200MP original, an unreadable File), the ~2000px
// copy prepareUploadImage made for the AI read is redrawn through a canvas and uploaded instead —
// always redrawn, because `file` is the untouched original when it was already a small JPEG.
//
// Flow: POST /photo/upload-url → PUT the blob to the signed R2 URL → POST /photo/confirm. The
// server HEADs the object before recording it (see api-server lib/photoStore.ts). Every failure is
// reported to POST /photo/failed (reportFullPhotoFailure) — the PUT to R2 is otherwise invisible to
// the server. Every failure is
// reported to POST /photo/failed (reportFullPhotoFailure) — the PUT to R2 is otherwise invisible to
// the server.

import type { createApi } from './api';
import {
  decodeScaled, drawToJpeg, fitWithin, withDecodeLock, FULL_MAX_EDGE, FULL_JPEG_QUALITY, UPLOAD_MAX_EDGE,
  type PreparedImage, type ScaledDecode,
} from './prepareUploadImage';

type Api = ReturnType<typeof createApi>;

/** Server-side limit is 12MB; stay a little under so a borderline encode doesn't fail at confirm. */
export const FULL_MAX_BYTES = 11.5 * 1024 * 1024;

export interface EncodedFullPhoto {
  blob: Blob;
  width: number;
  height: number;
  /** `fallback`: the ~2000px copy, because the full-size encode failed (why: `fallbackReason`). */
  variant: 'full' | 'fallback';
  fallbackReason?: EncodeFailReason;
}

/** `cancelled`: a newer image replaced this one before its encode finished — never reported. */
export type EncodeFailReason = 'heic' | 'decode' | 'too_large' | 'no_image' | 'cancelled';

export type FullPhotoEncodeResult =
  | { ok: true; photo: EncodedFullPhoto }
  | { ok: false; reason: EncodeFailReason; detail?: string; originalWidth?: number; originalHeight?: number };

/** Size/quality steps tried until the JPEG fits under FULL_MAX_BYTES. */
const ATTEMPTS: Array<{ edge: number; quality: number }> = [
  { edge: FULL_MAX_EDGE, quality: FULL_JPEG_QUALITY },
  { edge: FULL_MAX_EDGE, quality: 0.85 },
  { edge: 3072, quality: 0.85 },
];

function errorDetail(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  return `${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`.slice(0, 300);
}

const CANCELLED = { ok: false, reason: 'cancelled' } as const;

/** Encodes the full-size JPEG for an image, or says why it couldn't. Never throws. */
export async function encodeFullSizePhoto(image: PreparedImage | null | undefined, signal?: AbortSignal): Promise<FullPhotoEncodeResult> {
  if (!image) return { ok: false, reason: 'no_image' };
  if (image.heicFailed) return { ok: false, reason: 'heic', detail: 'HEIC could not be converted in this browser' };
  const full = image.full;
  if (!full) return { ok: false, reason: 'no_image', detail: 'no full-size source' };
  if (full.ready && full.width && full.height && full.blob.size <= FULL_MAX_BYTES) {
    return { ok: true, photo: { blob: full.blob, width: full.width, height: full.height, variant: 'full' } };
  }
  // Holds the decode lock: never alongside prepareUploadImage's decode of another photo.
  return withDecodeLock(() => encodeFromSource(full.blob, signal));
}

async function encodeFromSource(source: Blob, signal?: AbortSignal): Promise<FullPhotoEncodeResult> {
  if (signal?.aborted) return CANCELLED;
  let decoded: ScaledDecode;
  try {
    // One decode, straight to ≤ the largest attempt edge (decodeScaled: no full-resolution bitmap of
    // a 50–200MP original where the browser can help it), reused for every attempt. EXIF
    // orientation is applied, so portrait photos stay upright once the re-encode drops the tag.
    decoded = await decodeScaled(source, ATTEMPTS[0].edge);
  } catch (err) {
    console.warn('Full-size photo decode failed:', err);
    return { ok: false, reason: 'decode', detail: errorDetail(err) };
  }
  const { sourceWidth: originalWidth, sourceHeight: originalHeight } = decoded;
  try {
    for (const { edge, quality } of ATTEMPTS) {
      if (signal?.aborted) return CANCELLED;
      // Sized from the original, as before — the (already reduced) decode is drawn into it.
      const size = fitWithin(originalWidth, originalHeight, edge);
      const blob = await drawToJpeg(decoded.source, size.width, size.height, edge, quality);
      if (blob.size <= FULL_MAX_BYTES) {
        return { ok: true, photo: { blob, ...size, variant: 'full' } };
      }
    }
    return { ok: false, reason: 'too_large', detail: `over ${FULL_MAX_BYTES} bytes at every size`, originalWidth, originalHeight };
  } catch (err) {
    // drawToJpeg: no canvas context or a null toBlob — what running out of canvas memory looks like.
    console.warn('Full-size photo encode failed:', err);
    return { ok: false, reason: 'decode', detail: errorDetail(err), originalWidth, originalHeight };
  } finally {
    decoded.close();
  }
}

/** The ~2000px copy made for the AI read, redrawn through a canvas (no EXIF/GPS). Never throws. */
async function encodeFallbackPhoto(image: PreparedImage): Promise<FullPhotoEncodeResult> {
  // A heicFailed `file` is the HEIC original this browser already couldn't decode.
  if (image.heicFailed) return { ok: false, reason: 'heic' };
  return withDecodeLock(async (): Promise<FullPhotoEncodeResult> => {
    let decoded: ScaledDecode | null = null;
    try {
      // `file` is still the original when the downscale failed, so this decodes reduced-size too.
      decoded = await decodeScaled(image.file, UPLOAD_MAX_EDGE);
      const blob = await drawToJpeg(decoded.source, decoded.width, decoded.height, UPLOAD_MAX_EDGE, FULL_JPEG_QUALITY);
      return { ok: true, photo: { blob, ...fitWithin(decoded.width, decoded.height, UPLOAD_MAX_EDGE), variant: 'fallback' } };
    } catch (err) {
      return { ok: false, reason: 'decode', detail: errorDetail(err) };
    } finally {
      decoded?.close();
    }
  });
}

/**
 * The photo to upload for a score: the full-size encode, else the smaller fallback copy. A failure
 * carries the full-size encode's reason (the fallback's detail appended). Never throws.
 */
export async function encodeScorePhoto(image: PreparedImage | null | undefined, signal?: AbortSignal): Promise<FullPhotoEncodeResult> {
  const full = await encodeFullSizePhoto(image, signal);
  if (full.ok || full.reason === 'cancelled' || !image) return full;
  if (signal?.aborted) return CANCELLED;
  const fallback = await encodeFallbackPhoto(image);
  if (fallback.ok) {
    return { ok: true, photo: { ...fallback.photo, fallbackReason: full.reason } };
  }
  const detail = [full.detail, fallback.detail && `fallback: ${fallback.detail}`].filter(Boolean).join('; ');
  return { ...full, detail: detail || undefined };
}

/**
 * Encodes the score's photo in the background as soon as it's picked, one encode at a time, latest
 * image wins. A replaced image's encode is aborted at its next step (an in-flight decode can't be
 * interrupted, so the next one queues behind it rather than holding two big bitmaps at once).
 */
export class FullPhotoEncoder {
  private image: PreparedImage | null = null;
  private pending: Promise<FullPhotoEncodeResult> | null = null;
  private controller: AbortController | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  /** Starts encoding `image` (no-op when it's already the current one); null just drops the current. */
  prepare(image: PreparedImage | null): void {
    if (image === this.image && (this.pending || !image)) return;
    this.controller?.abort();
    this.image = image;
    this.pending = null;
    this.controller = null;
    if (!image) return;
    const controller = new AbortController();
    const run = this.tail.then(() => encodeScorePhoto(image, controller.signal));
    this.controller = controller;
    this.pending = run;
    this.tail = run.catch(() => undefined);
  }

  /** The encode for `image` — the background one when it's current, else a fresh one. */
  result(image: PreparedImage): Promise<FullPhotoEncodeResult> {
    this.prepare(image);
    return this.pending!;
  }

  /** Forgets a finished (failed) encode so the next result() tries again — Retry. */
  reset(): void {
    this.prepare(null);
  }
}

export type UploadStage = 'upload_url' | 'put' | 'confirm';

export type FullPhotoUploadResult =
  | { ok: true }
  /** `disabled`: the server has no R2 configured — say nothing, it's not the user's problem. */
  | { ok: false; disabled: boolean; message: string; stage: UploadStage; detail: string };

/** Upload URL → PUT → confirm. Never throws. */
export async function uploadFullSizePhoto(api: Api, scoreId: number, photo: EncodedFullPhoto): Promise<FullPhotoUploadResult> {
  let stage: UploadStage = 'upload_url';
  try {
    const { key, url } = await api.scores.photoUploadUrl(scoreId);
    stage = 'put';
    // Content-Type is part of the signature — it must be exactly this.
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: photo.blob });
    if (!put.ok) {
      return { ok: false, disabled: false, message: `Upload failed (${put.status})`, stage, detail: `HTTP ${put.status} ${put.statusText}`.trim() };
    }
    stage = 'confirm';
    await api.scores.photoConfirm(scoreId, {
      key, width: photo.width, height: photo.height, variant: photo.variant, fallbackReason: photo.fallbackReason,
    });
    return { ok: true };
  } catch (err: any) {
    if (err?.code === 'photos_disabled') return { ok: false, disabled: true, message: '', stage, detail: 'photos_disabled' };
    // A PUT that never got a response (CORS, network, offline) rejects with a bare TypeError.
    const detail = err?.status ? `HTTP ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message ?? ''}` : errorDetail(err);
    return { ok: false, disabled: false, message: err?.message ?? 'Upload failed', stage, detail };
  }
}

/** The user-facing reason an encode failed. */
export function encodeFailMessage(reason: EncodeFailReason): string {
  switch (reason) {
    case 'heic': return 'This HEIC photo couldn’t be converted on this device — try a JPEG.';
    case 'too_large': return 'The photo is too large to upload.';
    default: return 'This browser couldn’t read the photo.';
  }
}

export interface FullPhotoFailure {
  stage: 'encode' | UploadStage;
  reason: string;
  detail?: string;
  originalWidth?: number;
  originalHeight?: number;
}

/**
 * Tells the server a full-size upload failed (activity log `photo.failed`). Fire-and-forget: never
 * throws, never awaited by the UI. The image's source type/size (the picked file, for photos) goes
 * with it — never the file itself.
 */
export function reportFullPhotoFailure(
  api: Api, scoreId: number, image: Pick<PreparedImage, 'file' | 'full' | 'heicFailed'> | null | undefined, failure: FullPhotoFailure,
): void {
  try {
    const source = image?.full?.blob ?? image?.file;
    void api.scores.photoFailed(scoreId, {
      ...failure,
      detail: failure.detail?.slice(0, 300),
      userAgent: navigator.userAgent,
      fileType: source?.type || null,
      fileSize: source?.size ?? null,
      heicFailed: image?.heicFailed ?? null,
    }).catch(() => undefined);
  } catch {
    // Reporting must never break the caller.
  }
}

/** The failure report for an upload that failed (reason: HTTP status, or `network`). */
export function uploadFailure(result: Extract<FullPhotoUploadResult, { ok: false }>): FullPhotoFailure {
  const status = /HTTP (\d{3})/.exec(result.detail)?.[1];
  return { stage: result.stage, reason: status ? `http_${status}` : 'network', detail: result.detail };
}
