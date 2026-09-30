// timestamp → timestamptz, every column (fix/timestamptz). See src/lib/timestamptzMigration.ts for
// the column list and ~/.claude/plans/timezone-fix.md for the audit.
//
// All 48 `timestamp without time zone` columns held instants under a "naive UTC digits" convention.
// That convention held only as long as every reader and writer agreed the digits were UTC: postgres.js
// parses a naive value in the *process's* zone, so a raw-client script on an Eastern laptop shifted
// anything it read and wrote back by 4-5 hours, and a raw SQL string sent to the browser was shown in
// the viewer's zone. timestamptz stores the instant itself; every client reads it correctly.
//
// Each value is converted `AT TIME ZONE 'UTC'` under `SET LOCAL TIME ZONE 'UTC'`, so the instants are
// exactly what the digits meant, whatever the connection's zone. One transaction: any failure rolls
// everything back. `lock_timeout` makes it fail cleanly instead of queueing behind a long request
// (each ALTER takes ACCESS EXCLUSIVE and rewrites its table — milliseconds at TiltTrack's size).
// stat_history.period_date is a calendar date and stays `date`.
//
// Idempotent: a column already timestamptz is skipped; re-running prints "nothing to convert".
// Ends by asserting no naive timestamp column is left in the schema.
//
//   cd artifacts/api-server && npx tsx migrate26.ts

import 'dotenv/config';
import postgres from 'postgres';
import { TIMESTAMP_COLUMNS, COLUMN_COUNT, alterToTimestamptz, MIGRATION_PRELUDE } from './src/lib/timestamptzMigration.js';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on fix/timestamptz. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately, in its own commit, at ship time, when the migration
// is meant to hit production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate26.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

const converted: string[] = [];
await sql.begin(async tx => {
  for (const s of MIGRATION_PRELUDE) await tx.unsafe(s);
  for (const [table, cols] of Object.entries(TIMESTAMP_COLUMNS)) {
    const naive = (await tx`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ANY(${cols})
        AND data_type = 'timestamp without time zone'`).map(r => r.column_name as string);
    if (!naive.length) continue; // already converted
    // Keep the listed order so the statement is deterministic.
    await tx.unsafe(alterToTimestamptz(table, cols.filter(c => naive.includes(c))));
    converted.push(...cols.filter(c => naive.includes(c)).map(c => `${table}.${c}`));
  }
  const [{ left }] = await tx`
    SELECT count(*)::int AS left FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type = 'timestamp without time zone'`;
  if (left !== 0) throw new Error(`migrate26: ${left} naive timestamp column(s) remain — rolled back`);
  const [{ tz }] = await tx`
    SELECT count(*)::int AS tz FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type = 'timestamp with time zone'`;
  if (tz < COLUMN_COUNT) throw new Error(`migrate26: expected at least ${COLUMN_COUNT} timestamptz columns, found ${tz} — rolled back`);
});

const [{ pd }] = await sql`
  SELECT data_type AS pd FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'stat_history' AND column_name = 'period_date'`;
console.log(converted.length
  ? `migrate26: converted ${converted.length} column(s) to timestamptz: ${converted.join(', ')}`
  : 'migrate26: nothing to convert — every timestamp column is already timestamptz');
console.log(`migrate26 done (stat_history.period_date is ${pd})`);
await sql.end();
