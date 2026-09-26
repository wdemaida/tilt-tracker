// Friends + the notifications inbox (feature/friends, phase 1).
//
//  1. friendships — id, requester_id → users (cascade), addressee_id → users (cascade),
//     status ('pending' | 'accepted' | 'declined'), decline_count int default 0, created_at,
//     responded_at. ONE row per unordered pair: unique index on (least(ids), greatest(ids)).
//  2. notifications — id, user_id → users (cascade), kind text, payload jsonb, created_at,
//     read_at (null = unread). Indexed on (user_id, read_at) for the bell's unread count.
//
// Purely additive (new tables only) and idempotent (IF NOT EXISTS throughout) — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate14.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS friendships (
    id serial PRIMARY KEY,
    requester_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined')),
    decline_count integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now(),
    responded_at timestamp,
    CONSTRAINT friendships_not_self CHECK (requester_id <> addressee_id)
  )`;
await sql`CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_idx ON friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id))`;
await sql`CREATE INDEX IF NOT EXISTS friendships_requester_id_idx ON friendships (requester_id)`;
await sql`CREATE INDEX IF NOT EXISTS friendships_addressee_id_idx ON friendships (addressee_id)`;

await sql`
  CREATE TABLE IF NOT EXISTS notifications (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    read_at timestamp
  )`;
await sql`CREATE INDEX IF NOT EXISTS notifications_user_id_read_at_idx ON notifications (user_id, read_at)`;

const [{ friendships, notifications }] = await sql<Array<{ friendships: number; notifications: number }>>`
  SELECT (SELECT count(*)::int FROM friendships) AS friendships, (SELECT count(*)::int FROM notifications) AS notifications`;
console.log(`done — friendships has ${friendships} rows, notifications has ${notifications} rows`);

await sql.end();
