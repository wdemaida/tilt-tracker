import { eq, sql } from 'drizzle-orm';
import { db, appSettings } from '@workspace/db';
import type { Executor } from './activity.js';

// Server-side app settings (`app_settings`, migrate21): a small key/value store for things an admin
// edits in /admin/config, plus bits of job state (e.g. when the photo orphan sweep last ran).
//
// Defaults always live in the code that owns a setting — an empty table (or a missing / malformed
// row) means "use the defaults". Readers therefore never fail: a DB error reading a setting falls
// back to the default and is logged. Writers go through setSetting(), which upserts.
//
// Keys in use:
//   activity_retention      — activityRetention.ts (RetentionSettings)
//   photo_orphans_last_run  — photoOrphans.ts (OrphanRunRecord)

export interface StoredSetting<T> { value: T; updatedAt: Date; updatedById: number | null }

/** The stored row for a key, or null when there isn't one. Throws on DB errors. */
export async function getSetting<T = unknown>(key: string, ex: Executor = db): Promise<StoredSetting<T> | null> {
  const [row] = await ex.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row ? { value: row.value as T, updatedAt: row.updatedAt, updatedById: row.updatedById ?? null } : null;
}

/** Upserts a setting. `updatedById` null = written by the system (a job). */
export async function setSetting(key: string, value: unknown, updatedById: number | null, ex: Executor = db): Promise<void> {
  await ex.insert(appSettings)
    .values({ key, value, updatedById, updatedAt: sql`now()` as any })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedById, updatedAt: sql`now()` as any } });
}
