// Pinball Map etiquette (fix/pm-etiquette): the machine catalog moves from per-process memory into
// the DB so every process and restart shares one copy, refreshed at most once a day.
//
//  1. pm_catalog_cache — key text PK ('machines'), data jsonb (null until the first successful
//     fetch), fetched_at timestamp, last_error text, last_error_at timestamp (negative cache for a
//     failed refresh). See src/lib/pinballMap.ts.
//
// Numbered 16 because feature/challenges already uses migrate15 — the branches must not collide.
// Purely additive (new table only) and idempotent (IF NOT EXISTS) — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate16.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`
  CREATE TABLE IF NOT EXISTS pm_catalog_cache (
    key text PRIMARY KEY,
    data jsonb,
    fetched_at timestamp,
    last_error text,
    last_error_at timestamp
  )`;

console.log('migrate16: pm_catalog_cache ready');
await sql.end();
