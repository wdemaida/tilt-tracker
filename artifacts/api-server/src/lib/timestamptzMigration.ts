// migrate26's column list and SQL, kept here (no DB, no imports) so the unit test can run the exact
// statements against PGlite. See migrate26.ts.

/** Every `timestamp without time zone` column the schema had before migrate26 — 48 in 25 tables (every table). */
export const TIMESTAMP_COLUMNS: Record<string, string[]> = {
  users: ['created_at', 'disabled_at', 'challenge_venues_seeded_at'],
  machines: ['created_at'],
  venues: ['created_at'],
  scores: ['played_at', 'created_at', 'played_at_corrected_at'],
  venue_machine_history: ['first_seen_at', 'last_seen_at', 'removed_at'],
  venue_inventory: ['added_at', 'removed_at'],
  pm_location_cache: ['fetched_at'],
  pm_catalog_cache: ['fetched_at', 'last_error_at'],
  stats: ['created_at'],
  stat_history: ['created_at'], // NOT period_date — that's a real calendar date and stays `date`
  pods: ['created_at', 'updated_at'],
  pod_members: ['added_at'],
  friendships: ['created_at', 'responded_at'],
  notifications: ['created_at', 'read_at'],
  challenges: ['starts_at', 'ends_at', 'created_at', 'resolved_at', 'admin_cancelled_at', 'proposal_decided_at', 'proposal_reminded_at'],
  challenge_participants: ['responded_at', 'ending_soon_notified_at'],
  challenge_scores: ['created_at'],
  user_challenge_machines: ['created_at'],
  user_challenge_venues: ['created_at'],
  activity_events: ['created_at'],
  app_settings: ['updated_at'],
  badge_series: ['created_at', 'updated_at'],
  badges: ['available_from', 'available_to', 'activated_at', 'created_at', 'updated_at'],
  user_badges: ['earned_at'],
  user_metric_marks: ['at'],
};

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * One ALTER TABLE converting the given naive columns of `table` to timestamptz. The stored digits
 * are UTC (the app's convention), so each value is read `AT TIME ZONE 'UTC'` — explicit, so the
 * result never depends on the session's TimeZone. `DEFAULT now()` needs no change (now() is already
 * timestamptz); indexes and CHECKs on the columns are rebuilt by Postgres.
 */
export function alterToTimestamptz(table: string, cols: string[]): string {
  for (const n of [table, ...cols]) if (!IDENT.test(n)) throw new Error(`bad identifier: ${n}`);
  if (!cols.length) throw new Error(`no columns for ${table}`);
  return `ALTER TABLE ${table} ` + cols.map(c => `ALTER COLUMN ${c} TYPE timestamptz USING ${c} AT TIME ZONE 'UTC'`).join(', ');
}

/** The session settings the conversion runs under (inside its transaction). */
export const MIGRATION_PRELUDE = [`SET LOCAL lock_timeout = '5s'`, `SET LOCAL TIME ZONE 'UTC'`];

export const COLUMN_COUNT = Object.values(TIMESTAMP_COLUMNS).reduce((n, c) => n + c.length, 0);
