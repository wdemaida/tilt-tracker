// What a browser may tell us about a failed full-size photo upload (POST /api/scores/:id/photo/failed,
// logged as `photo.failed`). The client reports every failure — including the PUT to R2, which the
// server never sees otherwise — so an upload that silently never lands leaves a trace. Everything
// here is the client's word: whitelisted fields, capped strings, finite numbers, nothing else.

export const PHOTO_FAILURE_STAGES = ['encode', 'upload_url', 'put', 'confirm'] as const;
export type PhotoFailureStage = (typeof PHOTO_FAILURE_STAGES)[number];

export interface PhotoFailurePayload {
  stage: PhotoFailureStage;
  reason: string;
  detail: string | null;
  fileType: string | null;
  fileSize: number | null;
  originalWidth: number | null;
  originalHeight: number | null;
  heicFailed: boolean | null;
  /** The client's navigator.userAgent — the request's own header goes in the row's user_agent. */
  clientUserAgent: string | null;
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

const int = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : null;

/** The payload to log, or null when the body isn't a failure report at all. Pure — unit-tested. */
export function parsePhotoFailure(body: unknown): PhotoFailurePayload | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const stage = PHOTO_FAILURE_STAGES.find(s => s === b.stage);
  if (!stage) return null;
  const reason = typeof b.reason === 'string' ? b.reason.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40) : '';
  return {
    stage,
    reason: reason || 'unknown',
    detail: str(b.detail, 300),
    fileType: str(b.fileType, 100),
    fileSize: int(b.fileSize, 10 * 1024 ** 3),
    originalWidth: int(b.originalWidth, 100_000),
    originalHeight: int(b.originalHeight, 100_000),
    heicFailed: typeof b.heicFailed === 'boolean' ? b.heicFailed : null,
    clientUserAgent: str(b.userAgent, 300),
  };
}
