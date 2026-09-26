import { sql, type SQL } from 'drizzle-orm';
import { db } from '@workspace/db';
import { ACTIVITY_TYPES, logActivity, type Executor } from './activity.js';
import { getSetting, setSetting } from './appSettings.js';

// Tiered retention for the admin activity log (`activity_events`, which is otherwise append-only and
// grows forever). Three tiers, each with an admin-editable age limit (/admin/config → Data retention,
// stored in app_settings under `activity_retention`; defaults below when nothing is stored):
//
//   high_volume  — 90 days    routine, noisy, one-row-per-occurrence events (sign-ins, every
//                              notification sent, the daily cron heartbeats)
//   standard     — 365 days   everything a user did (scores, photos, friends, pods, challenges,
//                              venue repairs, Pinball Map connect/post, profile setup) — AND any type
//                              not listed here (the safe default for a new type)
//   admin        — forever    every admin/moderation action plus the account-lifecycle records
//                                                        (user.signed_up, user.clerk_deleted)
//
// Every tier takes the same values (Will, 2026-09-26):
//   -1        keep forever — never purged
//    0        off — events of the tier are NOT RECORDED (logActivity skips them, via the settings
//             cache below) and any existing ones are deleted by the next purge run
//   1–36500   keep that many days
//
// THE MAPPING LIVES IN ONE PLACE: TIER_BY_TYPE below (+ the `admin.` prefix rule for admin types
// nobody remembered to list). Every catalogued type in ACTIVITY_TYPES must be listed explicitly —
// activityRetention.test.ts fails otherwise, so adding an event type forces a retention decision.
//
// The purge runs from the daily challenge sweep (POST /api/cron/challenge-sweep → runDailyHousekeeping)
// and deletes in batches of BATCH_SIZE rows per statement (each a short, index-driven DELETE), capped
// at MAX_BATCHES per tier per run — a backlog bigger than that is finished on the next days' runs.

export type RetentionTier = 'high_volume' | 'standard' | 'admin';
export const RETENTION_TIERS: readonly RetentionTier[] = ['high_volume', 'standard', 'admin'];

export const TIER_BY_TYPE: Readonly<Record<string, RetentionTier>> = {
  // auth
  'user.signed_in': 'high_volume',
  'user.signed_up': 'admin',
  'user.clerk_deleted': 'admin',
  'user.first_setup': 'standard',
  // scores & photos
  'score.created': 'standard',
  'score.edited': 'standard',
  'score.deleted': 'standard',
  'score.repair_machine': 'standard',
  'photo.uploaded': 'standard',
  'photo.replaced': 'standard',
  // venues
  'venue.repair_here': 'standard',
  'venue.repair_here_attach': 'standard',
  'venue.repair_place': 'standard',
  'venue.repair_pm_link': 'standard',
  'venue.resync_applied': 'standard',
  'venue.merged': 'standard',
  // friends & pods
  'friend.request_sent': 'standard',
  'friend.request_resent': 'standard',
  'friend.request_accepted': 'standard',
  'friend.request_declined': 'standard',
  'friend.request_cancelled': 'standard',
  'friend.removed': 'standard',
  'pod.created': 'standard',
  'pod.updated': 'standard',
  'pod.deleted': 'standard',
  'pod.member_added': 'standard',
  'pod.member_removed': 'standard',
  // challenges
  'challenge.created': 'standard',
  'challenge.accepted': 'standard',
  'challenge.declined': 'standard',
  'challenge.cancelled': 'standard',
  'challenge.forfeited': 'standard',
  'challenge.resolved': 'standard',
  'challenge.expired': 'standard',
  // notifications — one row per notification raised; the most numerous type after sign-ins
  'notification.sent': 'high_volume',
  // Pinball Map
  'pm.connected': 'standard',
  'pm.score_posted': 'standard',
  'pm.score_post_failed': 'standard',
  // admin / moderation — kept forever by default
  'admin.user_updated': 'admin',
  'admin.user_disabled': 'admin',
  'admin.user_enabled': 'admin',
  'admin.score_deleted': 'admin',
  'admin.photo_deleted': 'admin',
  'admin.thumbnail_deleted': 'admin',
  'admin.challenge_voided': 'admin',
  'admin.friendship_removed': 'admin',
  'admin.notification_deleted': 'admin',
  'admin.notifications_cleared': 'admin',
  'admin.venue_deleted': 'admin',
  'admin.machine_updated': 'admin',
  'admin.machine_deleted': 'admin',
  'admin.settings_changed': 'admin',
  'admin.photo_orphans_run': 'admin',
  // system heartbeats — daily, routine. The overview's "last ran" only needs the newest one, and
  // 90 days of run history (incl. this purge's own system.activity_retention results) is plenty.
  'system.stat_snapshot': 'high_volume',
  'system.challenge_sweep': 'high_volume',
  'system.activity_retention': 'high_volume',
  'system.photo_orphans': 'high_volume',
};

/** Unlisted types starting with this are still treated as admin actions (kept longest). */
export const ADMIN_PREFIX = 'admin.';
export const DEFAULT_TIER: RetentionTier = 'standard';

/** The tier an event type is retained under. Pure — unit-tested. */
export function tierOf(type: string): RetentionTier {
  const t = TIER_BY_TYPE[type];
  if (t) return t;
  if (type.startsWith(ADMIN_PREFIX)) return 'admin';
  return DEFAULT_TIER;
}

/** Types explicitly mapped to a tier. */
export function typesInTier(tier: RetentionTier): string[] {
  return Object.entries(TIER_BY_TYPE).filter(([, t]) => t === tier).map(([type]) => type).sort();
}

/** Catalogued types (ACTIVITY_TYPES) that have no explicit tier — should always be empty. */
export function unmappedCatalogTypes(): string[] {
  return Object.values(ACTIVITY_TYPES).flat().filter(t => !(t in TIER_BY_TYPE));
}

// ── settings ─────────────────────────────────────────────────────────────────

/** Per tier: -1 = keep forever, 0 = don't record (and purge what exists), 1–36500 = days to keep. */
export interface RetentionSettings {
  highVolumeDays: number;
  standardDays: number;
  adminDays: number;
}

/** The two special values every tier accepts besides a day count. */
export const KEEP_FOREVER = -1;
export const DONT_RECORD = 0;

export const RETENTION_SETTING_KEY = 'activity_retention';
export const DEFAULT_RETENTION: Readonly<RetentionSettings> = { highVolumeDays: 90, standardDays: 365, adminDays: KEEP_FOREVER };

// The admin UI reads this (GET /api/admin/settings/retention → limits) to describe each field.
const TIER_LIMIT = { min: 1, max: 36500, forever: KEEP_FOREVER, off: DONT_RECORD } as const;
export const RETENTION_LIMITS = {
  highVolumeDays: TIER_LIMIT,
  standardDays: TIER_LIMIT,
  adminDays: TIER_LIMIT,
} as const;

type FieldKey = keyof RetentionSettings;
const FIELDS: FieldKey[] = ['highVolumeDays', 'standardDays', 'adminDays'];
const FIELD_OF_TIER: Record<RetentionTier, FieldKey> = { high_volume: 'highVolumeDays', standard: 'standardDays', admin: 'adminDays' };

function fieldError(field: FieldKey, v: unknown): string | null {
  const lim = RETENTION_LIMITS[field];
  if (typeof v !== 'number' || !Number.isInteger(v)) return `${field} must be a whole number of days`;
  if (v === lim.forever || v === lim.off) return null;
  if (v < lim.min || v > lim.max) {
    return `${field} must be ${lim.forever} (keep forever), ${lim.off} (don't record) or between ${lim.min} and ${lim.max} days`;
  }
  return null;
}

export type RetentionValidation =
  | { ok: true; value: RetentionSettings }
  | { ok: false; errors: Partial<Record<FieldKey, string>> };

/**
 * Validates a PUT body: all three fields, integers, within RETENTION_LIMITS. Numeric strings are
 * NOT accepted (the admin UI sends numbers). Pure — unit-tested.
 */
export function validateRetentionSettings(input: unknown): RetentionValidation {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const f of FIELDS) {
    if (!(f in src)) { errors[f] = `${f} is required`; continue; }
    const e = fieldError(f, src[f]);
    if (e) errors[f] = e;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { highVolumeDays: src.highVolumeDays as number, standardDays: src.standardDays as number, adminDays: src.adminDays as number } };
}

/**
 * Settings from whatever is stored, field by field: a missing or out-of-range stored field falls
 * back to its default (never trust a hand-edited row to mean "delete everything"). Pure.
 */
export function normalizeRetention(stored: unknown): RetentionSettings {
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_RETENTION };
  for (const f of FIELDS) if (f in src && fieldError(f, src[f]) === null) out[f] = src[f] as number;
  return out;
}

export interface RetentionSettingsView {
  settings: RetentionSettings;
  defaults: RetentionSettings;
  isDefault: boolean;
  updatedAt: Date | null;
  updatedById: number | null;
}

/** Current settings (defaults when nothing is stored or the read fails). Never throws. */
export async function loadRetentionSettings(): Promise<RetentionSettingsView> {
  try {
    const row = await getSetting(RETENTION_SETTING_KEY);
    return {
      settings: normalizeRetention(row?.value),
      defaults: { ...DEFAULT_RETENTION },
      isDefault: !row,
      updatedAt: row?.updatedAt ?? null,
      updatedById: row?.updatedById ?? null,
    };
  } catch (err: any) {
    console.error('[retention] failed to read settings, using defaults:', err?.message ?? err);
    return { settings: { ...DEFAULT_RETENTION }, defaults: { ...DEFAULT_RETENTION }, isDefault: true, updatedAt: null, updatedById: null };
  }
}

export async function saveRetentionSettings(value: RetentionSettings, byUserId: number, ex?: Executor): Promise<void> {
  await setSetting(RETENTION_SETTING_KEY, value, byUserId, ex);
}

/**
 * Age limit for a tier's events: null = keep forever (-1, skip the tier), 0 = delete every row of the
 * tier (cutoff = now), N = older than N days. Pure.
 */
export function retentionDays(settings: RetentionSettings, tier: RetentionTier): number | null {
  const d = settings[FIELD_OF_TIER[tier]];
  return d < 0 ? null : d;
}

/** Whether events of a tier are written at all (false when the tier is set to 0). Pure. */
export function isTierRecorded(settings: RetentionSettings, tier: RetentionTier): boolean {
  return settings[FIELD_OF_TIER[tier]] !== DONT_RECORD;
}

/** What a run would do, per tier, in order (days as retentionDays). Pure — unit-tested. */
export function planRetention(settings: RetentionSettings): Array<{ tier: RetentionTier; days: number | null }> {
  return RETENTION_TIERS.map(tier => ({ tier, days: retentionDays(settings, tier) }));
}

// ── settings cache (for logActivity's "is this tier recorded?" check) ─────────
//
// logActivity() asks isTypeRecorded() before every insert, so the settings come from an in-process
// cache: refreshed at most once per SETTINGS_CACHE_TTL_MS (concurrent misses share one read), and
// primed by the PUT route so a change applies on this instance immediately. Another instance (there's
// one on Render today) picks it up within the TTL. A failed read keeps the last known settings (or
// the defaults, which record everything) for a few seconds, then retries — never throws.

export const SETTINGS_CACHE_TTL_MS = 60_000;
const SETTINGS_ERROR_TTL_MS = 5_000;

type RetentionLoader = () => Promise<RetentionSettings>;
const dbLoader: RetentionLoader = async () => normalizeRetention((await getSetting(RETENTION_SETTING_KEY))?.value);
let loader: RetentionLoader = dbLoader;
let cached: { settings: RetentionSettings; expires: number } | null = null;
let inflight: Promise<RetentionSettings> | null = null;
let generation = 0;

/** Tests: replace the settings read (null = the real DB read). Also clears the cache. */
export function setRetentionLoaderForTests(fn: RetentionLoader | null): void {
  loader = fn ?? dbLoader;
  cached = null;
  inflight = null;
  generation++;
}

/** Put freshly saved settings in the cache (the PUT route calls this after its transaction commits). */
export function primeRetentionCache(settings: RetentionSettings): void {
  generation++;
  inflight = null;
  cached = { settings: { ...settings }, expires: Date.now() + SETTINGS_CACHE_TTL_MS };
}

/** Current settings via the cache. Never throws. */
export async function cachedRetentionSettings(): Promise<RetentionSettings> {
  if (cached && Date.now() < cached.expires) return cached.settings;
  if (!inflight) {
    const gen = generation;
    const fallback = cached?.settings ?? { ...DEFAULT_RETENTION };
    const p: Promise<RetentionSettings> = loader().then(
      s => {
        if (gen === generation) cached = { settings: s, expires: Date.now() + SETTINGS_CACHE_TTL_MS };
        return s;
      },
      (err: any) => {
        console.warn('[retention] settings read failed, recording with last known settings:', err?.message ?? err);
        if (gen === generation) cached = { settings: fallback, expires: Date.now() + SETTINGS_ERROR_TTL_MS };
        return fallback;
      },
    ).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
  }
  return inflight;
}

/** Whether an event of this type should be written (its tier isn't set to 0). Never throws. */
export async function isTypeRecorded(type: string): Promise<boolean> {
  return isTierRecorded(await cachedRetentionSettings(), tierOf(type));
}

// ── batching ─────────────────────────────────────────────────────────────────

export const BATCH_SIZE = 5_000;
/** Per tier per run: 200 × 5,000 = 1M rows; anything left over goes on the next run. */
export const MAX_BATCHES = 200;

export interface BatchResult { deleted: number; batches: number; capped: boolean }

/**
 * Runs `deleteBatch(limit)` until a batch comes back short (nothing left) or `maxBatches` is hit.
 * `deleteBatch` returns how many rows it deleted. Pure control flow — unit-tested with a fake.
 */
export async function runBatches(
  deleteBatch: (limit: number) => Promise<number>,
  batchSize = BATCH_SIZE,
  maxBatches = MAX_BATCHES,
): Promise<BatchResult> {
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const n = await deleteBatch(batchSize);
    batches++;
    deleted += n;
    if (n < batchSize) return { deleted, batches, capped: false };
  }
  return { deleted, batches, capped: true };
}

// ── SQL ──────────────────────────────────────────────────────────────────────

/**
 * A WHERE fragment matching a tier's events, built from the same map tierOf() reads, so SQL and JS
 * can't disagree: high_volume = the listed types; admin = the listed types or the `admin.` prefix;
 * standard = everything else (including unknown types).
 */
export function tierSql(tier: RetentionTier): SQL {
  const high = typesInTier('high_volume');
  const admin = typesInTier('admin');
  const inHigh = sql`type = ANY(${sqlTextArray(high)})`;
  const inAdmin = sql`(type = ANY(${sqlTextArray(admin)}) OR type LIKE ${`${ADMIN_PREFIX}%`})`;
  if (tier === 'high_volume') return inHigh;
  if (tier === 'admin') return sql`(${inAdmin} AND NOT ${inHigh})`;
  return sql`(NOT ${inHigh} AND NOT ${inAdmin})`;
}

function sqlTextArray(values: string[]): SQL {
  // A text[] literal param; `ANY(ARRAY[]::text[])` for an empty list.
  if (!values.length) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map(v => sql`${v}`), sql`, `)}]::text[]`;
}

/** created_at is a naive UTC column; the cutoff is computed in UTC on the DB clock. */
function cutoffSql(days: number): SQL {
  return sql`((now() AT TIME ZONE 'UTC') - make_interval(days => ${days}))`;
}

async function deleteTierBatch(tier: RetentionTier, days: number, limit: number, scope?: SQL): Promise<number> {
  const rows = await db.execute(sql`
    WITH doomed AS (
      SELECT id FROM activity_events
      WHERE ${tierSql(tier)} AND created_at < ${cutoffSql(days)}${scope ? sql` AND (${scope})` : sql``}
      ORDER BY created_at
      LIMIT ${limit}
    )
    DELETE FROM activity_events a USING doomed d WHERE a.id = d.id
    RETURNING a.id`);
  return (rows as unknown as unknown[]).length;
}

// ── run + status ─────────────────────────────────────────────────────────────

export interface RetentionRunResult {
  settings: RetentionSettings;
  deleted: Record<RetentionTier, number>;
  total: number;
  capped: boolean;
  ms: number;
  errors: string[];
}

/**
 * Purges every tier past its age limit (a tier set to 0 loses every row; -1 is skipped) and logs one
 * `system.activity_retention` event (after the purge, so the record of this run isn't among what it
 * deletes — and not at all when the high-volume tier is 0). A failing tier is recorded in
 * `errors` and the others still run. `deleteBatch` is injectable for tests.
 */
export async function runActivityRetention(opts: {
  settings?: RetentionSettings;
  batchSize?: number;
  maxBatches?: number;
  log?: boolean;
  /** Tests only (test-retention.ts): an extra WHERE condition, so a "delete everything" tier can be
   *  exercised on the dev branch without wiping its genuine events. */
  scope?: SQL;
} = {}): Promise<RetentionRunResult> {
  const started = Date.now();
  const settings = opts.settings ?? (await loadRetentionSettings()).settings;
  const deleted: Record<RetentionTier, number> = { high_volume: 0, standard: 0, admin: 0 };
  const errors: string[] = [];
  let capped = false;
  for (const { tier, days } of planRetention(settings)) {
    if (days == null) continue;
    try {
      const r = await runBatches(limit => deleteTierBatch(tier, days, limit, opts.scope), opts.batchSize ?? BATCH_SIZE, opts.maxBatches ?? MAX_BATCHES);
      deleted[tier] = r.deleted;
      capped ||= r.capped;
    } catch (err: any) {
      errors.push(`${tier}: ${err?.message ?? String(err)}`);
      console.error(`[retention] ${tier} purge failed:`, err);
    }
  }
  const result: RetentionRunResult = {
    settings, deleted, total: deleted.high_volume + deleted.standard + deleted.admin, capped, ms: Date.now() - started, errors,
  };
  if (opts.log !== false) {
    await logActivity({ type: 'system.activity_retention', payload: { ...result } });
  }
  return result;
}

export interface TierStatus {
  tier: RetentionTier;
  /** As retentionDays: null = kept forever, 0 = not recorded (all rows go next run), N = days. */
  days: number | null;
  rows: number;
  oldest: string | null;
  /** Rows the next run would delete with the current settings. */
  eligible: number;
}

/** Row counts, oldest event and would-delete estimate per tier (one aggregate query). */
export async function retentionStatus(settings: RetentionSettings): Promise<TierStatus[]> {
  // Keep-forever tiers get a cutoff of -infinity, so nothing counts as eligible; a tier set to 0 gets
  // cutoff = now, so every row counts.
  const cut = (tier: RetentionTier) => {
    const d = retentionDays(settings, tier);
    return d == null ? sql`'-infinity'::timestamp` : cutoffSql(d);
  };
  const rows = await db.execute(sql`
    SELECT tier, count(*)::int AS rows, min(created_at) AS oldest,
           count(*) FILTER (WHERE
             (tier = 'high_volume' AND created_at < ${cut('high_volume')}) OR
             (tier = 'standard' AND created_at < ${cut('standard')}) OR
             (tier = 'admin' AND created_at < ${cut('admin')}))::int AS eligible
    FROM (
      SELECT created_at,
             CASE WHEN ${tierSql('high_volume')} THEN 'high_volume'
                  WHEN ${tierSql('admin')} THEN 'admin'
                  ELSE 'standard' END AS tier
      FROM activity_events
    ) t
    GROUP BY tier`) as unknown as Array<{ tier: RetentionTier; rows: number; oldest: string | Date | null; eligible: number }>;
  return RETENTION_TIERS.map(tier => {
    const r = rows.find(x => x.tier === tier);
    return { tier, days: retentionDays(settings, tier), rows: r?.rows ?? 0, oldest: naiveUtcToIso(r?.oldest), eligible: r?.eligible ?? 0 };
  });
}

/**
 * A naive-UTC timestamp from a raw query (drizzle hands raw `timestamp` values back as strings like
 * `2026-09-26 12:34:56.789`) as an ISO string with a Z, so browsers don't read it as local time.
 */
export function naiveUtcToIso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (/\d:\d\d(:\d\d(\.\d+)?)?\s*(z|[+-]\d\d(:?\d\d)?)$/i.test(s)) return new Date(s).toISOString();
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(+d) ? s : d.toISOString();
}
