// Full-size score photos: encode in the browser, upload straight to Cloudflare R2, confirm with the
// api-server. Runs after the score has saved (so a failure never loses a score, and there's a score
// id to key the object by), in the background — AddScorePage shows a small status line.
//
// What goes up is never the camera original: the chosen image's source (PreparedImage.full) is
// decoded and redrawn through a canvas, which drops EXIF — GPS included, which matters for home
// venues — capped at FULL_MAX_EDGE (iOS Safari's canvas limit) and encoded as JPEG. Video frames
// arrive already encoded that way. A HEIC the browser couldn't convert (`heicFailed`) gets none.
//
// Flow: POST /photo/upload-url → PUT the blob to the signed R2 URL → POST /photo/confirm. The
// server HEADs the object before recording it (see api-server lib/photoStore.ts).

import type { createApi } from './api';
import { drawToJpeg, fitWithin, FULL_MAX_EDGE, FULL_JPEG_QUALITY, type PreparedImage } from './prepareUploadImage';

type Api = ReturnType<typeof createApi>;

/** Server-side limit is 12MB; stay a little under so a borderline encode doesn't fail at confirm. */
export const FULL_MAX_BYTES = 11.5 * 1024 * 1024;

export interface EncodedFullPhoto { blob: Blob; width: number; height: number }

/** Size/quality steps tried until the JPEG fits under FULL_MAX_BYTES. */
const ATTEMPTS: Array<{ edge: number; quality: number }> = [
  { edge: FULL_MAX_EDGE, quality: FULL_JPEG_QUALITY },
  { edge: FULL_MAX_EDGE, quality: 0.85 },
  { edge: 3072, quality: 0.85 },
];

/** Encodes the full-size JPEG for an image, or null when there is none to make. Never throws. */
export async function encodeFullSizePhoto(image: PreparedImage | null | undefined): Promise<EncodedFullPhoto | null> {
  const full = image?.full;
  if (!image || image.heicFailed || !full) return null;
  if (full.ready && full.width && full.height && full.blob.size <= FULL_MAX_BYTES) {
    return { blob: full.blob, width: full.width, height: full.height };
  }
  let bitmap: ImageBitmap | null = null;
  try {
    // Applies EXIF orientation ('from-image' is the default), so portrait photos stay upright once
    // the re-encode drops the orientation tag.
    bitmap = await createImageBitmap(full.blob);
    for (const { edge, quality } of ATTEMPTS) {
      const blob = await drawToJpeg(bitmap, bitmap.width, bitmap.height, edge, quality);
      if (blob.size <= FULL_MAX_BYTES) return { blob, ...fitWithin(bitmap.width, bitmap.height, edge) };
    }
    return null;
  } catch (err) {
    console.warn('Full-size photo encode failed:', err);
    return null;
  } finally {
    bitmap?.close();
  }
}

export type FullPhotoUploadResult =
  | { ok: true }
  /** `disabled`: the server has no R2 configured — say nothing, it's not the user's problem. */
  | { ok: false; disabled: boolean; message: string };

/** Upload URL → PUT → confirm. Never throws. */
export async function uploadFullSizePhoto(api: Api, scoreId: number, photo: EncodedFullPhoto): Promise<FullPhotoUploadResult> {
  try {
    const { key, url } = await api.scores.photoUploadUrl(scoreId);
    // Content-Type is part of the signature — it must be exactly this.
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: photo.blob });
    if (!put.ok) return { ok: false, disabled: false, message: `Upload failed (${put.status})` };
    await api.scores.photoConfirm(scoreId, { key, width: photo.width, height: photo.height });
    return { ok: true };
  } catch (err: any) {
    if (err?.code === 'photos_disabled') return { ok: false, disabled: true, message: '' };
    return { ok: false, disabled: false, message: err?.message ?? 'Upload failed' };
  }
}
