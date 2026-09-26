// Challenges core (feature/challenges, phase 2).
//
//  1. challenges — one row per challenge. creator_id → users (cascade), type
//     ('high_score' | 'race' | 'most_improved' | 'average'), machine_id → machines, match_mode
//     ('game' | 'exact'), match_group (the OPDB group id captured at creation for 'game' mode; null
//     = exact machine only), venue_id → venues (nullable venue lock), target_score (race),
//     min_plays (average, 3–10), starts_at (null = "starts when accepted"), ends_at, status
//     ('pending' | 'active' | 'resolved' | 'declined' | 'cancelled' | 'expired'), void, visibility
//     (reserved, 'participants'), created_at, resolved_at.
//  2. challenge_participants — (challenge_id, user_id) PK. response ('pending' | 'accepted' |
//     'declined'), outcome ('win' | 'loss' | 'tie' | 'forfeit' | 'no_show'), baseline_score
//     (most_improved, frozen at acceptance), result_value, rank, responded_at,
//     ending_soon_notified_at (the daily sweep's "24h left" notice is sent once per participant).
//  3. challenge_scores — (challenge_id, score_id) PK: the scores that counted. The score edit and
//     delete routes refuse any score with a row here; score_id has no ON DELETE action, so the
//     database refuses too.
//
// Purely additive (new tables only) and idempotent (IF NOT EXISTS throughout) — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate15.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while Challenges is still on feature/challenges. Production is
// a different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate15.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS challenges (
    id serial PRIMARY KEY,
    creator_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('high_score', 'race', 'most_improved', 'average')),
    machine_id integer NOT NULL REFERENCES machines(id),
    match_mode text NOT NULL DEFAULT 'game' CHECK (match_mode IN ('game', 'exact')),
    match_group text,
    venue_id integer REFERENCES venues(id),
    target_score bigint CHECK (target_score IS NULL OR target_score > 0),
    min_plays integer CHECK (min_plays IS NULL OR min_plays BETWEEN 3 AND 10),
    starts_at timestamp,
    ends_at timestamp NOT NULL,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'resolved', 'declined', 'cancelled', 'expired')),
    void boolean NOT NULL DEFAULT false,
    visibility text NOT NULL DEFAULT 'participants',
    created_at timestamp NOT NULL DEFAULT now(),
    resolved_at timestamp,
    CONSTRAINT challenges_race_target CHECK (type <> 'race' OR target_score IS NOT NULL),
    CONSTRAINT challenges_average_min_plays CHECK (type <> 'average' OR min_plays IS NOT NULL)
  )`;
await sql`CREATE INDEX IF NOT EXISTS challenges_status_ends_at_idx ON challenges (status, ends_at)`;
await sql`CREATE INDEX IF NOT EXISTS challenges_creator_id_idx ON challenges (creator_id)`;

await sql`
  CREATE TABLE IF NOT EXISTS challenge_participants (
    challenge_id integer NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    response text NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'accepted', 'declined')),
    outcome text CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'tie', 'forfeit', 'no_show')),
    baseline_score bigint,
    result_value numeric,
    rank integer,
    responded_at timestamp,
    ending_soon_notified_at timestamp,
    CONSTRAINT challenge_participants_pkey PRIMARY KEY (challenge_id, user_id)
  )`;
await sql`CREATE INDEX IF NOT EXISTS challenge_participants_user_id_idx ON challenge_participants (user_id)`;

await sql`
  CREATE TABLE IF NOT EXISTS challenge_scores (
    challenge_id integer NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    score_id integer NOT NULL REFERENCES scores(id),
    created_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT challenge_scores_pkey PRIMARY KEY (challenge_id, score_id)
  )`;
await sql`CREATE INDEX IF NOT EXISTS challenge_scores_score_id_idx ON challenge_scores (score_id)`;

const [counts] = await sql<Array<{ c: number; p: number; s: number }>>`
  SELECT (SELECT count(*)::int FROM challenges) AS c,
         (SELECT count(*)::int FROM challenge_participants) AS p,
         (SELECT count(*)::int FROM challenge_scores) AS s`;
console.log(`done — challenges ${counts.c}, challenge_participants ${counts.p}, challenge_scores ${counts.s} rows`);

await sql.end();
