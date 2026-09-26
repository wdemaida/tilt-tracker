// Full-size score photos on Cloudflare R2 (S3-compatible, private bucket).
//
// The browser never talks to R2 with our credentials: the server signs a 5-minute PUT URL for one
// key, the browser uploads the (already GPS-free, re-encoded) JPEG straight to R2, then asks the
// server to confirm. Confirm HEADs the object and only then records the key on the score; anything
// that fails the checks is deleted. Viewing signs a ~10-minute GET URL after the same visibility
// filter score listings use (see routes/scorePhotos.ts).
//
// Optional by design: without the four R2_* env vars the store is disabled — uploads and thumbnails
// work exactly as before, the photo routes answer 503 `photos_disabled`, and one warning is logged
// at startup (logPhotoStoreStatus).
//
// Key format: scores/{scoreId}/{uuid}.jpg. The score id in the key is what lets confirm prove a key
// belongs to the score it's being attached to, and lets the orphan sweep (cleanup-photo-orphans.ts)
// map objects back to rows.

import { randomUUID } from 'node:crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sql } from 'drizzle-orm';
import { scores } from '@workspace/db';

/**
 * `hasFullPhoto` for score selects. Lists expose only this boolean — never the key. Deliberately not
 * gated on R2 being configured: the viewer handles a 503 like any other failed load.
 */
export const hasFullPhotoSql = sql<boolean>`(${scores.photoKey} IS NOT NULL)`.mapWith(Boolean);

/**
 * `hasThumbnail` for list selects that don't carry the thumbnail itself (user/machine/venue/challenge
 * rows): the viewer fetches it on open from GET /api/scores/:id/photo, so a thumbnail-only score can
 * still be enlarged without every list shipping data URLs.
 */
export const hasThumbnailSql = sql<boolean>`(${scores.photoThumbnail} IS NOT NULL)`.mapWith(Boolean);

/** Strips the private photo columns from a full score row before it's sent to a client. */
export function publicScoreRow<T extends { photoKey?: string | null; photoBytes?: number | null }>(row: T) {
  const { photoKey, photoBytes: _bytes, ...rest } = row;
  return { ...rest, hasFullPhoto: photoKey != null };
}

export const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** Long edge the client caps a full-size photo at; dimensions above this are refused as bogus. */
export const PHOTO_MAX_EDGE = 4096;
export const PHOTO_CONTENT_TYPE = 'image/jpeg';
export const UPLOAD_URL_TTL_S = 5 * 60;
export const VIEW_URL_TTL_S = 10 * 60;
export const PHOTO_KEY_PREFIX = 'scores/';

const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** The R2 config from env, or null when any variable is missing (feature disabled). */
export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const v = R2_VARS.map(k => env[k]?.trim());
  if (v.some(x => !x)) return null;
  const [accountId, accessKeyId, secretAccessKey, bucket] = v as string[];
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function missingR2Vars(env: NodeJS.ProcessEnv = process.env): string[] {
  return R2_VARS.filter(k => !env[k]?.trim());
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY_RE = new RegExp(`^scores/([1-9][0-9]{0,9})/${UUID_RE}\\.jpg$`);

export function newPhotoKey(scoreId: number, uuid: string = randomUUID()): string {
  if (!Number.isSafeInteger(scoreId) || scoreId <= 0) throw new Error(`bad score id ${scoreId}`);
  return `${PHOTO_KEY_PREFIX}${scoreId}/${uuid.toLowerCase()}.jpg`;
}

/** The score id a well-formed key belongs to, or null for anything we didn't mint. */
export function scoreIdFromKey(key: unknown): number | null {
  if (typeof key !== 'string') return null;
  const m = KEY_RE.exec(key);
  return m ? Number(m[1]) : null;
}

export function keyBelongsToScore(key: unknown, scoreId: number): key is string {
  return scoreIdFromKey(key) === scoreId;
}

export type HeadCheck =
  | { ok: true; bytes: number }
  | { ok: false; code: 'photo_too_large' | 'photo_empty' | 'photo_wrong_type'; error: string };

/** Validates what HeadObject reported for an upload. */
export function checkUploadedHead(head: { contentLength?: number | null; contentType?: string | null }): HeadCheck {
  const bytes = Number(head.contentLength ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, code: 'photo_empty', error: 'The uploaded photo is empty' };
  if (bytes > PHOTO_MAX_BYTES) {
    return { ok: false, code: 'photo_too_large', error: `The photo is over ${PHOTO_MAX_BYTES / 1024 / 1024}MB` };
  }
  const type = (head.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type !== PHOTO_CONTENT_TYPE) return { ok: false, code: 'photo_wrong_type', error: 'The photo must be a JPEG' };
  return { ok: true, bytes };
}

/** A client-reported pixel dimension, or null if it isn't a plausible one. Layout hint only. */
export function sanitizeDimension(n: unknown): number | null {
  const v = Number(n);
  return Number.isInteger(v) && v > 0 && v <= PHOTO_MAX_EDGE ? v : null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface HeadResult { contentLength: number | null; contentType: string | null }

export interface PhotoStore {
  readonly bucket: string;
  presignPut(key: string): Promise<string>;
  presignGet(key: string): Promise<string>;
  /** null when the object doesn't exist. */
  head(key: string): Promise<HeadResult | null>;
  delete(key: string): Promise<void>;
  /** One page of keys under a prefix, with last-modified times. */
  list(prefix: string, continuationToken?: string): Promise<{ objects: Array<{ key: string; lastModified: Date | null; size: number }>; next?: string }>;
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // https://<account>.r2.cloudflarestorage.com/<bucket>/<key> — path style keeps every URL on the
    // one account host the bucket's CORS rules and TLS certificate are known to cover.
    forcePathStyle: true,
    // SDK >= 3.729 adds CRC32 flexible checksums to every request by default; a presigned PUT then
    // demands a checksum header the browser never sends, and R2 rejects it. Cloudflare's documented
    // fix is to only checksum when an operation requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function isNotFound(err: any): boolean {
  return err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

export function createPhotoStore(config: R2Config, client: S3Client = createR2Client(config)): PhotoStore {
  const Bucket = config.bucket;
  return {
    bucket: Bucket,
    // content-type is signed, so R2 refuses a PUT that doesn't send exactly `image/jpeg`.
    presignPut: key => getSignedUrl(client, new PutObjectCommand({ Bucket, Key: key, ContentType: PHOTO_CONTENT_TYPE }), {
      expiresIn: UPLOAD_URL_TTL_S,
      signableHeaders: new Set(['content-type']),
    }),
    presignGet: key => getSignedUrl(client, new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentType: PHOTO_CONTENT_TYPE,
      // The URL itself expires; let the browser keep the bytes for as long as the URL is valid.
      ResponseCacheControl: `private, max-age=${VIEW_URL_TTL_S}`,
    }), { expiresIn: VIEW_URL_TTL_S }),
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { contentLength: out.ContentLength ?? null, contentType: out.ContentType ?? null };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async list(prefix, continuationToken) {
      const out = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      return {
        objects: (out.Contents ?? []).filter(o => o.Key).map(o => ({ key: o.Key!, lastModified: o.LastModified ?? null, size: o.Size ?? 0 })),
        next: out.IsTruncated ? out.NextContinuationToken : undefined,
      };
    },
  };
}

let cached: PhotoStore | null | undefined;

/** The process-wide store, or null when R2 isn't configured. */
export function getPhotoStore(): PhotoStore | null {
  if (cached === undefined) {
    const config = readR2Config();
    cached = config ? createPhotoStore(config) : null;
  }
  return cached;
}

/** Tests only: swap in a fake store (or null to simulate "not configured"). */
export function setPhotoStoreForTests(store: PhotoStore | null | undefined): void {
  cached = store;
}

/** One line at startup; never prints values. */
export function logPhotoStoreStatus(): void {
  const missing = missingR2Vars();
  if (missing.length) {
    console.warn(`[photos] Full-size photos disabled — missing ${missing.join(', ')}. Uploads and thumbnails are unaffected.`);
  } else {
    console.log(`[photos] Full-size photos enabled (R2 bucket ${process.env.R2_BUCKET}).`);
  }
}

/** Deletes an object, logging instead of throwing — for cleanup after the row is already gone. */
export async function deletePhotoBestEffort(key: string | null | undefined, context: string, store = getPhotoStore()): Promise<void> {
  if (!key) return;
  if (!store) {
    console.warn(`[photos] ${context}: can't delete ${key} — R2 not configured (the orphan sweep will find it)`);
    return;
  }
  try {
    await store.delete(key);
  } catch (err: any) {
    console.error(`[photos] ${context}: failed to delete ${key}: ${err?.name ?? ''} ${err?.message ?? err}`);
  }
}

/** Objects older than this and referenced by no score are orphans (see cleanup-photo-orphans.ts). */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The orphans among listed objects: not referenced by any score and older than `minAgeMs` (so an
 * upload between its PUT and its confirm is never swept). An object without a last-modified time is
 * kept — we can't prove it's old.
 */
export function findOrphans(
  objects: Array<{ key: string; lastModified: Date | null }>,
  referenced: ReadonlySet<string>,
  now: number,
  minAgeMs = ORPHAN_MIN_AGE_MS,
): string[] {
  return objects
    .filter(o => !referenced.has(o.key) && o.lastModified != null && now - o.lastModified.getTime() > minAgeMs)
    .map(o => o.key);
}

// ---------------------------------------------------------------------------
// Confirm (the one piece with branching worth testing end to end against a fake store)
// ---------------------------------------------------------------------------

export type ConfirmCheck =
  | { ok: true; bytes: number }
  | { ok: false; status: number; code: string; error: string };

/**
 * Checks an upload the browser says it finished: the key must be one we minted for this score, the
 * object must exist, and it must pass checkUploadedHead. A present-but-invalid object is deleted.
 * Does not touch the database.
 */
export async function verifyUpload(store: PhotoStore, scoreId: number, key: unknown): Promise<ConfirmCheck> {
  if (!keyBelongsToScore(key, scoreId)) {
    return { ok: false, status: 400, code: 'photo_key_invalid', error: "That photo key doesn't belong to this score" };
  }
  const head = await store.head(key);
  if (!head) return { ok: false, status: 404, code: 'photo_not_uploaded', error: 'The photo upload was not found — try again' };
  const check = checkUploadedHead(head);
  if (!check.ok) {
    await deletePhotoBestEffort(key, `confirm score ${scoreId} (${check.code})`, store);
    return { ok: false, status: 400, code: check.code, error: check.error };
  }
  return { ok: true, bytes: check.bytes };
}
