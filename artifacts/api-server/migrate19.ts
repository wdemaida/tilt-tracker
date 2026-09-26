// Admin area (feature/admin).
//
//  activity_events            — append-only event log (see lib/activity.ts). bigserial id doubles as
//                               the keyset cursor; created_at for date-range filters; svix_id UNIQUE
//                               makes Clerk webhook retries idempotent (NULLs never collide).
//  users.disabled_at/_reason/_by_id
//                             — admin "disable account": requireAppUser answers 403
//                               account_disabled while set; the user is also banned in Clerk.
//  challenges.admin_cancelled_at/_by_id/admin_cancel_reason
//                             — admin void: status becomes 'cancelled' (records only count
//                               'resolved'), outcomes cleared, score locks released.
//
// Purely additive (IF NOT EXISTS everywhere) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate19.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/admin. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate19.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} }); // re-runs print "already exists" notices

await sql`
  CREATE TABLE IF NOT EXISTS activity_events (
    id              bigserial PRIMARY KEY,
    created_at      timestamp NOT NULL DEFAULT now(),
    actor_user_id   integer REFERENCES users(id) ON DELETE SET NULL,
    type            text NOT NULL,
    subject_user_id integer REFERENCES users(id) ON DELETE SET NULL,
    target_type     text,
    target_id       text,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip              text,
    user_agent      text,
    svix_id         text,
    CONSTRAINT activity_events_svix_id_key UNIQUE (svix_id)
  )`;
await sql`CREATE INDEX IF NOT EXISTS activity_events_created_at_idx ON activity_events (created_at)`;
await sql`CREATE INDEX IF NOT EXISTS activity_events_actor_idx ON activity_events (actor_user_id, id)`;
await sql`CREATE INDEX IF NOT EXISTS activity_events_subject_idx ON activity_events (subject_user_id, id)`;
await sql`CREATE INDEX IF NOT EXISTS activity_events_type_idx ON activity_events (type, id)`;
await sql`CREATE INDEX IF NOT EXISTS activity_events_target_idx ON activity_events (target_type, target_id, id)`;

await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamp`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason text`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by_id integer`;

await sql`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS admin_cancelled_at timestamp`;
await sql`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS admin_cancelled_by_id integer`;
await sql`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS admin_cancel_reason text`;

console.log('migrate19: activity_events, users.disabled_*, challenges.admin_cancel* ready');
await sql.end();
