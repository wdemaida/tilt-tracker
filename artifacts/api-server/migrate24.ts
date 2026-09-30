// Group challenges + counter-offers as proposals (feature/group-challenges).
//
//  1. challenges.proposed_by_id → users(id) ON DELETE SET NULL (+ index). Set on a counter-offer: a
//     PROPOSAL row sent to the challenger. creator_id stays the challenger, countered_from_id is the
//     original, and its participants are the proposer (accepted) and the challenger (pending).
//  2. challenges.proposal_decided_at — when the challenger took it, or it was rejected / lapsed.
//  3. challenges.proposal_reminded_at — the daily sweep's one "you have an unanswered suggestion"
//     reminder to the challenger (24 h after it was made). Durable once-only marker.
//  4. Unique (countered_from_id, proposed_by_id) WHERE proposed_by_id IS NOT NULL: one proposal per
//     player per original.
//  5. The status CHECK adds 'proposed' (open), 'rejected' (the challenger kept hers, or it was
//     superseded / the original started) and 'lapsed' (the original was cancelled / expired / hit its
//     fixed start, or the proposal's own window passed). The response CHECK adds 'missed' (never
//     answered: the challenge started — or expired — without them).
//  6. challenges_proposal_check: a row in a proposal status must name its proposer. It deliberately
//     does NOT require countered_from_id, which is ON DELETE SET NULL.
//  7. challenge_participants_decline_reason_check (migrate22) widens to allow 'backed_out': an
//     accepted invitee who leaves a group before it starts is recorded response 'declined' with
//     decline_reason 'backed_out' — set only by the server's back-out path, never from a decline body.
//  8. Backfill: pending participants of expired challenges become 'missed'.
//
// Legacy counter rows (countered_from_id set, proposed_by_id null — created by the counterer under
// migrate22's model) are untouched and keep working as ordinary challenges.
//
// Additive (nullable columns, wider CHECKs) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate24.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/group-challenges. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate24.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} }); // re-runs print "already exists" notices

await sql.begin(async tx => {
  await tx`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS proposed_by_id integer REFERENCES users(id) ON DELETE SET NULL`;
  await tx`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS proposal_decided_at timestamp`;
  await tx`ALTER TABLE challenges ADD COLUMN IF NOT EXISTS proposal_reminded_at timestamp`;
  await tx`CREATE INDEX IF NOT EXISTS challenges_proposed_by_id_idx ON challenges (proposed_by_id)`;
  await tx`
    CREATE UNIQUE INDEX IF NOT EXISTS challenges_proposal_unique
      ON challenges (countered_from_id, proposed_by_id) WHERE proposed_by_id IS NOT NULL`;

  await tx`ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_status_check`;
  await tx`
    ALTER TABLE challenges ADD CONSTRAINT challenges_status_check
      CHECK (status IN ('pending', 'active', 'resolved', 'declined', 'cancelled', 'expired', 'countered', 'proposed', 'rejected', 'lapsed'))`;
  await tx`ALTER TABLE challenge_participants DROP CONSTRAINT IF EXISTS challenge_participants_response_check`;
  await tx`
    ALTER TABLE challenge_participants ADD CONSTRAINT challenge_participants_response_check
      CHECK (response IN ('pending', 'accepted', 'declined', 'countered', 'missed'))`;
  await tx`ALTER TABLE challenge_participants DROP CONSTRAINT IF EXISTS challenge_participants_decline_reason_check`;
  await tx`
    ALTER TABLE challenge_participants ADD CONSTRAINT challenge_participants_decline_reason_check
      CHECK (decline_reason IS NULL OR decline_reason IN ('cant_reach', 'no_thanks', 'backed_out'))`;
  await tx`ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_proposal_check`;
  await tx`
    ALTER TABLE challenges ADD CONSTRAINT challenges_proposal_check
      CHECK (status NOT IN ('proposed', 'rejected', 'lapsed') OR proposed_by_id IS NOT NULL)`;

  const missed = await tx`
    UPDATE challenge_participants cp SET response = 'missed'
    FROM challenges c
    WHERE c.id = cp.challenge_id AND c.status = 'expired' AND cp.response = 'pending'
    RETURNING cp.challenge_id`;
  console.log(`migrate24: backfilled ${missed.length} pending participant(s) of expired challenges → missed`);
});

const [counts] = await sql<Array<{ legacy: number; proposals: number }>>`
  SELECT (SELECT count(*)::int FROM challenges WHERE countered_from_id IS NOT NULL AND proposed_by_id IS NULL) AS legacy,
         (SELECT count(*)::int FROM challenges WHERE proposed_by_id IS NOT NULL) AS proposals`;
console.log(`migrate24: done — ${counts.legacy} legacy counter row(s), ${counts.proposals} proposal row(s)`);
await sql.end();
