// Server-side app settings + activity-log retention (feature/retention).
//
//  app_settings                 — small key/value store for admin-editable settings (key text PK,
//                                 value jsonb, updated_at, updated_by_id). Defaults live in code, so an
//                                 empty table = every default. Keys today:
//                                   activity_retention       {highVolumeDays, standardDays, adminDays}
//                                   photo_orphans_last_run   {at, listed, orphans, deleted, ...}
//                                 Generic on purpose: the global theme colours (localStorage-only
//                                 today) could move here later.
//  activity_events_type_created_idx (type, created_at)
//                               — lets the retention purge's high-volume tier (type = ANY(...) AND
//                                 created_at < cutoff) range-scan per type. The other tiers use the
//                                 existing activity_events_created_at_idx from migrate19.
//
// Purely additive (IF NOT EXISTS everywhere) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate21.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/retention. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate21.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} }); // re-runs print "already exists" notices

await sql`
  CREATE TABLE IF NOT EXISTS app_settings (
    key            text PRIMARY KEY,
    value          jsonb NOT NULL,
    updated_at     timestamp NOT NULL DEFAULT now(),
    updated_by_id  integer REFERENCES users(id) ON DELETE SET NULL
  )`;
await sql`CREATE INDEX IF NOT EXISTS activity_events_type_created_idx ON activity_events (type, created_at)`;

console.log('migrate21: app_settings, activity_events_type_created_idx ready');
await sql.end();
