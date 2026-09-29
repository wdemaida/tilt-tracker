// Challenge recommendations + counter-offers (feature/challenge-recs).
//
//  1. user_challenge_machines — (user_id, machine_id) PK, position, created_at. "Challenge me on": up
//     to 3 exact machines a user wants to be challenged on (the max is enforced by the API, not here).
//  2. user_challenge_venues — (user_id, venue_id) PK, source ('auto' = seeded from the user's own
//     history | 'added' = picked by hand), created_at. "Challenge locations": venues the user can get
//     to. Their machines are only ever read from TiltTrack's own tables and the cached Pinball Map
//     rosters (pm_location_cache) — never a live Pinball Map call.
//  3. users.challenge_venues_seeded_at — seeding from history runs once; after that a removed venue
//     stays removed and new candidates only show up as suggestions.
//  4. challenges.countered_from_id → challenges(id) ON DELETE SET NULL (+ index): a counter-offer
//     points at the challenge it answered. That one ends with status 'countered'.
//  5. challenge_participants.decline_reason ('cant_reach' | 'no_thanks' | null), CHECK named
//     challenge_participants_decline_reason_check. A counter stores 'cant_reach' too.
//  6. The status / response CHECKs widen to allow 'countered'. migrate15 created them inline without
//     names, so they're found in pg_constraint by definition, dropped, and re-added with names
//     (challenges_status_check, challenge_participants_response_check).
//
// Purely additive (new tables, nullable columns, wider CHECKs) and idempotent — safe to re-run, and
// safe to run before the code that uses it ships.
//
//   cd artifacts/api-server && npx tsx migrate22.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/challenge-recs. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate22.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} }); // re-runs print "already exists" notices

await sql`
  CREATE TABLE IF NOT EXISTS user_challenge_machines (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    machine_id integer NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    position integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT user_challenge_machines_pkey PRIMARY KEY (user_id, machine_id)
  )`;
await sql`
  CREATE TABLE IF NOT EXISTS user_challenge_venues (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id integer NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    source text NOT NULL DEFAULT 'added' CHECK (source IN ('auto', 'added')),
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT user_challenge_venues_pkey PRIMARY KEY (user_id, venue_id)
  )`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_venues_seeded_at timestamp`;

await sql`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS countered_from_id integer REFERENCES challenges(id) ON DELETE SET NULL`;
await sql`CREATE INDEX IF NOT EXISTS challenges_countered_from_id_idx ON challenges (countered_from_id)`;
await sql`ALTER TABLE challenge_participants ADD COLUMN IF NOT EXISTS decline_reason text`;

await sql.begin(async tx => {
  // Every CHECK on challenges.status / challenge_participants.response, whatever it's called.
  const stale = await tx<Array<{ table: string; name: string }>>`
    SELECT rel.relname AS table, con.conname AS name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE con.contype = 'c'
      AND ((rel.relname = 'challenges' AND pg_get_constraintdef(con.oid) ~ '\\mstatus\\M' AND pg_get_constraintdef(con.oid) LIKE '%''expired''%')
        OR (rel.relname = 'challenge_participants' AND pg_get_constraintdef(con.oid) ~ '\\mresponse\\M' AND pg_get_constraintdef(con.oid) LIKE '%''declined''%'))`;
  for (const c of stale) await tx.unsafe(`ALTER TABLE "${c.table}" DROP CONSTRAINT "${c.name.replace(/"/g, '""')}"`);
  await tx`
    ALTER TABLE challenges ADD CONSTRAINT challenges_status_check
      CHECK (status IN ('pending', 'active', 'resolved', 'declined', 'cancelled', 'expired', 'countered'))`;
  await tx`
    ALTER TABLE challenge_participants ADD CONSTRAINT challenge_participants_response_check
      CHECK (response IN ('pending', 'accepted', 'declined', 'countered'))`;
  await tx`ALTER TABLE challenge_participants DROP CONSTRAINT IF EXISTS challenge_participants_decline_reason_check`;
  await tx`
    ALTER TABLE challenge_participants ADD CONSTRAINT challenge_participants_decline_reason_check
      CHECK (decline_reason IS NULL OR decline_reason IN ('cant_reach', 'no_thanks'))`;
  console.log(`migrate22: replaced ${stale.length} status/response CHECK(s): ${stale.map(c => `${c.table}.${c.name}`).join(', ') || 'none'}`);
});

const [counts] = await sql<Array<{ m: number; v: number }>>`
  SELECT (SELECT count(*)::int FROM user_challenge_machines) AS m,
         (SELECT count(*)::int FROM user_challenge_venues) AS v`;
console.log(`migrate22: done — user_challenge_machines ${counts.m}, user_challenge_venues ${counts.v} rows`);
await sql.end();
