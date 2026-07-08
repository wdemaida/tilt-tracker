// Converts HEIC/HEIF photos to JPEG in the browser before upload, instead of on the server.
//
// Why: the server-side conversion (heic-convert, a pure-JS/WASM HEVC decoder) uses ~380MB RSS to
// decode even an ordinary 12MP iPhone photo — nearly the entire 512MB budget on a memory-constrained
// host. Doing it client-side moves that cost onto the user's own device (which has far more headroom)
// and off a process shared by every concurrent request. See project_upload_crash_fix /
// feedback_render_oom_diagnosis memory for the incident this was built to prevent.
//
// HEIC->JPEG conversion strips EXIF, so GPS/timestamp must be extracted from the *original* file
// before conversion — this mirrors what upload.ts already does server-side for non-HEIC uploads.
//
// To roll this back: delete this file, revert `handlePhoto` in AddScorePage.tsx to call
// `api.upload(file)` directly (no conversion, no opts), and (optionally) remove the `exifr`/
// `heic2any` dependencies and the `opts` parameter added to `api.ts`'s `upload()`. The backend
// (upload.ts) requires no changes to roll back — it already falls back to its own (slower, more
// memory-heavy but functional) HEIC handling whenever the latitude/longitude/exifDatetime fields
// this produces are absent from the request.

export interface HeicConvertResult {
  file: Blob;
  filename: string;
  latitude: number | null;
  longitude: number | null;
  exifDatetime: string | null;
}

export function isHeicFile(file: File): boolean {
  return file.type === 'image/heic' || file.type === 'image/heif' || file.name.toLowerCase().endsWith('.heic');
}

/** Returns null if conversion fails — caller should fall back to uploading the original file as-is. */
export async function convertHeicClientSide(file: File): Promise<HeicConvertResult | null> {
  try {
    const Exifr = (await import('exifr')).default;
    const [gps, tags] = await Promise.all([
      Exifr.gps(file).catch(() => null),
      Exifr.parse(file, { pick: ['DateTimeOriginal'] }).catch(() => null),
    ]);

    const heic2any = (await import('heic2any')).default;
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
    const blob = Array.isArray(converted) ? converted[0] : converted;

    return {
      file: blob,
      filename: file.name.replace(/\.(heic|heif)$/i, '.jpg'),
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      exifDatetime: tags?.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal.toISOString() : null,
    };
  } catch {
    return null;
  }
}
