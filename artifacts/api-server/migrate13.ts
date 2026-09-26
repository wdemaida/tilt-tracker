// Pods — private groupings of other users, owned by one user (feature/pods, step 2).
//
//  1. pods — id, owner_id → users (cascade), name, color (#rrggbb, lowercase), created_at, updated_at.
//     Name is unique per owner, case-insensitive: unique index on (owner_id, lower(name)).
//  2. pod_members — (pod_id → pods cascade, user_id → users cascade, added_at), primary key
//     (pod_id, user_id). Indexed on user_id for "which of my pods is this user in" lookups.
//
// Purely additive (new tables only) and idempotent (IF NOT EXISTS throughout) — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate13.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS pods (
    id serial PRIMARY KEY,
    owner_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    color varchar(7) NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS pods_owner_id_idx ON pods (owner_id)`;
await sql`CREATE UNIQUE INDEX IF NOT EXISTS pods_owner_lower_name_idx ON pods (owner_id, lower(name))`;

await sql`
  CREATE TABLE IF NOT EXISTS pod_members (
    pod_id integer NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at timestamp NOT NULL DEFAULT now(),
    CONSTRAINT pod_members_pkey PRIMARY KEY (pod_id, user_id)
  )`;
await sql`CREATE INDEX IF NOT EXISTS pod_members_user_id_idx ON pod_members (user_id)`;

const [{ pods, members }] = await sql<Array<{ pods: number; members: number }>>`
  SELECT (SELECT count(*)::int FROM pods) AS pods, (SELECT count(*)::int FROM pod_members) AS members`;
console.log(`done — pods has ${pods} rows, pod_members has ${members} rows`);

await sql.end();
