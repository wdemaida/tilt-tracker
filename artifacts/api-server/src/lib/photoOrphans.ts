import { inArray, isNotNull } from 'drizzle-orm';
import { db, scores } from '@workspace/db';
import { getPhotoStore, findOrphans, scoreIdFromKey, PHOTO_KEY_PREFIX, ORPHAN_MIN_AGE_MS, type PhotoStore } from './photoStore.js';
import { getSetting, setSetting } from './appSettings.js';
import { logActivity } from './activity.js';

// Full-size photo orphan sweep: R2 objects under `scores/` that no `scores.photo_key` references and
// that are older than 24h. Orphans come from uploads that were PUT but never confirmed (tab closed
// mid-upload), confirm checks that failed and whose delete also failed, and best-effort deletes that
// failed after a score/photo was deleted or replaced. The 24h floor keeps an in-flight upload (PUT
// done, confirm pending) from ever being swept.
//
// Callers:
//   - the daily challenge sweep → runDailyHousekeeping() → runScheduledOrphanSweep(): a real run at
//     most once a week (ORPHAN_RUN_INTERVAL_MS since the last *deleting* run, stored in app_settings
//     under `photo_orphans_last_run`), logged as `system.photo_orphans`;
//   - the admin "Run now (dry run)" / "Run now" buttons (/admin/config) → POST
//     /api/admin/photo-orphans/run, logged as `admin.photo_orphans_run`;
//   - the CLI, cleanup-photo-orphans.ts (dry run unless --delete).
//
// Safety: deletes are capped per run (MAX_DELETES_PER_RUN), and each batch of candidates is
// re-checked against the DB right before it's deleted — a confirm that landed between the listing
// and the delete keeps its object. A dev DB with the prod bucket (or vice versa) is refused, since
// every object would look orphaned.

export const PHOTO_ORPHANS_SETTING_KEY = 'photo_orphans_last_run';
export const ORPHAN_RUN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Slack so a daily cron that fires a little earlier than last week's still counts as "a week". */
export const ORPHAN_RUN_SLACK_MS = 12 * 60 * 60 * 1000;
export const MAX_DELETES_PER_RUN = 1_000;
/** ListObjectsV2 pages (1,000 keys each) per run — 100k objects. */
export const MAX_LIST_PAGES = 100;
export const RECHECK_BATCH = 100;
const DELETE_CONCURRENCY = 8;
const SAMPLE_SIZE = 25;

const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const DEV_BUCKET = 'tilttrack-photos-dev';

/**
 * Why this DB + bucket pair must not be swept, or null when they're the same environment. Pure.
 * (Only the two combinations we can recognise: dev DB with a non-dev bucket, and vice versa.)
 */
export function envMismatch(databaseUrl: string | undefined, bucket: string | undefined): string | null {
  let host = '';
  try { host = new URL(databaseUrl ?? '').hostname; } catch { /* unparseable = not dev */ }
  const isDevDb = host.startsWith(DEV_ENDPOINT);
  const isDevBucket = bucket === DEV_BUCKET;
  if (isDevDb === isDevBucket) return null;
  return `database is ${isDevDb ? 'dev' : 'not dev'} but bucket is ${isDevBucket ? 'dev' : 'not dev'} — every object would look orphaned`;
}

/** Whether the weekly sweep is due, given when the last deleting run happened. Pure. */
export function orphanSweepDue(lastDeleteRunAt: string | Date | null | undefined, now: number): boolean {
  if (!lastDeleteRunAt) return true;
  const last = +new Date(lastDeleteRunAt);
  if (Number.isNaN(last)) return true;
  return now - last >= ORPHAN_RUN_INTERVAL_MS - ORPHAN_RUN_SLACK_MS;
}

export interface OrphanSweepDeps {
  store: PhotoStore;
  /** Every photo_key currently on a score. */
  referencedKeys: () => Promise<Set<string>>;
  /** Which of these keys are referenced right now (the pre-delete re-check). */
  referencedAmong: (keys: string[]) => Promise<Set<string>>;
}

export interface OrphanSweepOptions {
  dryRun: boolean;
  now?: number;
  /** Tests inject 0 (R2 objects can't be backdated); production always uses the 24h default. */
  minAgeMs?: number;
  maxDeletes?: number;
  maxPages?: number;
  /** Narrow the listing (tests: one score's prefix). Must start with `scores/`. */
  prefix?: string;
  /** How many orphan keys to return in `sample` (default 25; the CLI asks for all). */
  sampleSize?: number;
}

export interface OrphanSweepResult {
  dryRun: boolean;
  bucket: string;
  prefix: string;
  minAgeHours: number;
  /** Objects listed under the prefix. */
  listed: number;
  /** Distinct keys referenced by scores when the run started. */
  referenced: number;
  /** Orphans found (a dry run counts all of them; a real run stops listing at the delete cap). */
  orphans: number;
  orphanBytes: number;
  deleted: number;
  failed: number;
  /** Candidates that turned out to be referenced at the re-check (a confirm raced the sweep). */
  skippedReferenced: number;
  /** Stopped at maxDeletes or maxPages; the rest waits for the next run. */
  capped: boolean;
  /**
   * First few orphan keys, for the CLI / tests. PRIVATE — photo keys never leave the server; the
   * admin route strips this (see publicOrphanResult).
   */
  sample: string[];
  ms: number;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * Lists, selects and (unless dryRun) deletes orphans. All I/O is through `deps`, so it's unit-tested
 * against a fake store and fake reference lookups.
 */
export async function sweepPhotoOrphans(deps: OrphanSweepDeps, opts: OrphanSweepOptions): Promise<OrphanSweepResult> {
  const started = Date.now();
  const now = opts.now ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const maxDeletes = opts.maxDeletes ?? MAX_DELETES_PER_RUN;
  const maxPages = opts.maxPages ?? MAX_LIST_PAGES;
  const prefix = opts.prefix ?? PHOTO_KEY_PREFIX;
  if (!prefix.startsWith(PHOTO_KEY_PREFIX)) throw new Error(`orphan sweep prefix must start with ${PHOTO_KEY_PREFIX}`);

  const referenced = await deps.referencedKeys();
  const candidates: Array<{ key: string; size: number }> = [];
  let listed = 0;
  let pages = 0;
  let capped = false;
  let next: string | undefined;
  do {
    if (pages >= maxPages) { capped = true; break; }
    const page = await deps.store.list(prefix, next);
    pages++;
    listed += page.objects.length;
    const orphanKeys = new Set(findOrphans(page.objects, referenced, now, minAgeMs));
    for (const o of page.objects) if (orphanKeys.has(o.key)) candidates.push({ key: o.key, size: o.size });
    next = page.next;
    if (!opts.dryRun && candidates.length >= maxDeletes) {
      if (candidates.length > maxDeletes || next) capped = true;
      break;
    }
  } while (next);

  const toProcess = opts.dryRun ? candidates : candidates.slice(0, maxDeletes);
  let deleted = 0;
  let failed = 0;
  let skippedReferenced = 0;
  if (!opts.dryRun) {
    for (let i = 0; i < toProcess.length; i += RECHECK_BATCH) {
      const batch = toProcess.slice(i, i + RECHECK_BATCH).map(c => c.key);
      const nowReferenced = await deps.referencedAmong(batch);
      const doomed = batch.filter(k => !nowReferenced.has(k));
      skippedReferenced += batch.length - doomed.length;
      await pool(doomed, DELETE_CONCURRENCY, async key => {
        try {
          await deps.store.delete(key);
          deleted++;
        } catch (err: any) {
          failed++;
          console.error(`[photo-orphans] failed to delete ${key}: ${err?.name ?? ''} ${err?.message ?? err}`);
        }
      });
    }
  }

  return {
    dryRun: opts.dryRun,
    bucket: deps.store.bucket,
    prefix,
    minAgeHours: Math.round((minAgeMs / 3_600_000) * 100) / 100,
    listed,
    referenced: referenced.size,
    orphans: toProcess.length,
    orphanBytes: toProcess.reduce((n, c) => n + c.size, 0),
    deleted,
    failed,
    skippedReferenced,
    capped,
    sample: toProcess.slice(0, opts.sampleSize ?? SAMPLE_SIZE).map(c => c.key),
    ms: Date.now() - started,
  };
}

/** A result safe to send to the admin UI: keys replaced by the score ids they belong to. */
export function publicOrphanResult(r: OrphanSweepResult) {
  const { sample, ...rest } = r;
  return { ...rest, sampleScoreIds: sample.map(k => scoreIdFromKey(k)).filter((n): n is number => n != null) };
}

/** The DB-backed reference lookups. */
export const dbReferenceLookups = {
  async referencedKeys(): Promise<Set<string>> {
    const rows = await db.select({ key: scores.photoKey }).from(scores).where(isNotNull(scores.photoKey));
    return new Set(rows.map(r => r.key!));
  },
  async referencedAmong(keys: string[]): Promise<Set<string>> {
    if (!keys.length) return new Set();
    const rows = await db.select({ key: scores.photoKey }).from(scores).where(inArray(scores.photoKey, keys));
    return new Set(rows.map(r => r.key!));
  },
};

// ── last-run record ──────────────────────────────────────────────────────────

export interface OrphanRunRecord extends Omit<OrphanSweepResult, 'sample'> {
  at: string;
  trigger: 'cron' | 'admin' | 'cli';
  actorUserId: number | null;
}

export interface OrphanRunState {
  lastRun: OrphanRunRecord | null;
  /** The last run that actually deleted (not a dry run) — what the weekly schedule counts from. */
  lastDeleteRunAt: string | null;
}

export async function loadOrphanRunState(): Promise<OrphanRunState> {
  try {
    const row = await getSetting<Partial<OrphanRunState>>(PHOTO_ORPHANS_SETTING_KEY);
    return { lastRun: row?.value?.lastRun ?? null, lastDeleteRunAt: row?.value?.lastDeleteRunAt ?? null };
  } catch (err: any) {
    console.error('[photo-orphans] failed to read last-run state:', err?.message ?? err);
    return { lastRun: null, lastDeleteRunAt: null };
  }
}

async function recordRun(result: OrphanSweepResult, trigger: OrphanRunRecord['trigger'], actorUserId: number | null): Promise<void> {
  const prev = await loadOrphanRunState();
  const { sample: _sample, ...rest } = result;
  const at = new Date().toISOString();
  const state: OrphanRunState = {
    lastRun: { ...rest, at, trigger, actorUserId },
    lastDeleteRunAt: result.dryRun ? prev.lastDeleteRunAt : at,
  };
  try {
    await setSetting(PHOTO_ORPHANS_SETTING_KEY, state, null);
  } catch (err: any) {
    console.error('[photo-orphans] failed to record run:', err?.message ?? err);
  }
}

export type OrphanRunOutcome =
  | { ran: true; result: OrphanSweepResult }
  | { ran: false; reason: 'r2_not_configured' | 'env_mismatch' | 'not_due'; detail?: string; lastDeleteRunAt?: string | null };

/**
 * One run against the configured store with the DB lookups, recorded in app_settings. Refuses when
 * R2 isn't configured or the DB and bucket are different environments.
 */
export async function runPhotoOrphanSweep(opts: OrphanSweepOptions & {
  trigger: OrphanRunRecord['trigger'];
  actorUserId?: number | null;
  store?: PhotoStore | null;
  deps?: Partial<OrphanSweepDeps>;
}): Promise<OrphanRunOutcome> {
  const store = opts.store === undefined ? getPhotoStore() : opts.store;
  if (!store) return { ran: false, reason: 'r2_not_configured' };
  const mismatch = envMismatch(process.env.DATABASE_URL, store.bucket);
  if (mismatch) return { ran: false, reason: 'env_mismatch', detail: mismatch };
  const result = await sweepPhotoOrphans({ store, ...dbReferenceLookups, ...opts.deps }, opts);
  await recordRun(result, opts.trigger, opts.actorUserId ?? null);
  return { ran: true, result };
}

/** The weekly job, called daily: runs (and deletes) only when a week has passed since the last deleting run. */
export async function runScheduledOrphanSweep(now = Date.now()): Promise<OrphanRunOutcome> {
  if (!getPhotoStore()) return { ran: false, reason: 'r2_not_configured' };
  const state = await loadOrphanRunState();
  if (!orphanSweepDue(state.lastDeleteRunAt, now)) return { ran: false, reason: 'not_due', lastDeleteRunAt: state.lastDeleteRunAt };
  const outcome = await runPhotoOrphanSweep({ dryRun: false, now, trigger: 'cron' });
  if (outcome.ran) {
    const { sample: _sample, ...payload } = outcome.result;
    await logActivity({ type: 'system.photo_orphans', payload: { ...payload } });
  } else {
    console.warn(`[photo-orphans] scheduled sweep skipped: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`);
  }
  return outcome;
}
