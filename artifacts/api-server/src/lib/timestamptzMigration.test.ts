// Run: npx tsx --test src/lib/timestamptzMigration.test.ts   (from artifacts/api-server)
//
// migrate26's statements against an in-process PGlite (real Postgres, WASM) whose session zone is
// deliberately NOT UTC: the conversion must keep every value's UTC digits exactly, because it sets
// its own zone (SET LOCAL TIME ZONE 'UTC') and converts with an explicit AT TIME ZONE 'UTC'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { TIMESTAMP_COLUMNS, COLUMN_COUNT, alterToTimestamptz, MIGRATION_PRELUDE } from './timestamptzMigration.js';

const VALUES = ['2026-09-30 11:32:45.82', '2026-03-08 06:59:59', '2026-11-01 05:30:00.123456', '2026-01-15 00:00:00'];

async function naiveColumns(pg: PGlite, table: string, cols: string[]): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1
       AND column_name = ANY($2) AND data_type = 'timestamp without time zone'`, [table, cols]);
  return cols.filter(c => r.rows.some(x => x.column_name === c));
}

/** migrate26's loop, against PGlite. Returns the columns it converted. */
async function migrate(pg: PGlite): Promise<string[]> {
  const done: string[] = [];
  await pg.transaction(async tx => {
    for (const s of MIGRATION_PRELUDE) await tx.exec(s);
    for (const [table, cols] of Object.entries(TIMESTAMP_COLUMNS)) {
      const naive = await naiveColumns(tx as unknown as PGlite, table, cols);
      if (!naive.length) continue;
      await tx.exec(alterToTimestamptz(table, naive));
      done.push(...naive.map(c => `${table}.${c}`));
    }
  });
  return done;
}

test('the column list is the 48 from the audit, and period_date is not in it', () => {
  assert.equal(COLUMN_COUNT, 48);
  assert.equal(Object.keys(TIMESTAMP_COLUMNS).length, 25);
  assert.ok(!TIMESTAMP_COLUMNS.stat_history.includes('period_date'));
});

test('converting under a non-UTC session keeps every instant, and is idempotent', async () => {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'America/New_York'`);
  for (const [table, cols] of Object.entries(TIMESTAMP_COLUMNS)) {
    await pg.exec(`CREATE TABLE ${table} (id serial PRIMARY KEY, ${cols.map(c => `${c} timestamp`).join(', ')}${table === 'stat_history' ? ', period_date date' : ''})`);
    for (const v of [...VALUES, null]) {
      await pg.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '$1::timestamp').join(', ')})`, [v]);
    }
  }
  await pg.exec(`CREATE INDEX ON activity_events (created_at)`);
  await pg.exec(`ALTER TABLE badges ADD CONSTRAINT badges_window_check CHECK (available_from <= available_to)`);
  await pg.exec(`INSERT INTO stat_history (created_at, period_date) VALUES ('2026-09-30 04:00:00', '2026-09-30')`);

  const converted = await migrate(pg);
  assert.equal(converted.length, 48);

  // The session is still New York afterwards (SET LOCAL ended with the transaction)…
  assert.equal((await pg.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)).rows[0].tz, 'America/New_York');
  // …and every value reads back as the same UTC digits it had.
  for (const [table, cols] of Object.entries(TIMESTAMP_COLUMNS)) {
    for (const c of cols) {
      const r = await pg.query<{ t: string | null; type: string }>(
        `SELECT (${c} AT TIME ZONE 'UTC')::text AS t, pg_typeof(${c})::text AS type FROM ${table} WHERE id <= 5 ORDER BY id`);
      assert.deepEqual(r.rows.map(x => x.t), [...VALUES, null], `${table}.${c}`);
      assert.equal(r.rows[0].type, 'timestamp with time zone', `${table}.${c}`);
    }
  }
  // The instant, rendered in the (New York) session zone, is the UTC digits minus 4 h — i.e. the
  // value was NOT reinterpreted as a New York wall clock.
  const [row] = (await pg.query<{ t: string }>(`SELECT created_at::text AS t FROM scores WHERE id = 1`)).rows;
  assert.equal(row.t, '2026-09-30 07:32:45.82-04');
  const pd = (await pg.query<{ type: string; v: string }>(`SELECT pg_typeof(period_date)::text AS type, period_date::text AS v FROM stat_history WHERE period_date IS NOT NULL`)).rows[0];
  assert.deepEqual(pd, { type: 'date', v: '2026-09-30' });

  // Idempotent: a second run finds nothing to do.
  assert.deepEqual(await migrate(pg), []);
  const left = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'timestamp without time zone'`)).rows[0].n;
  assert.equal(left, 0);
  // The window CHECK survived the type change.
  await assert.rejects(pg.exec(`INSERT INTO badges (available_from, available_to) VALUES ('2026-02-01Z', '2026-01-01Z')`));
  await pg.close();
});

test('a partial earlier run is finished, not redone', async () => {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'Asia/Kolkata'`);
  for (const [table, cols] of Object.entries(TIMESTAMP_COLUMNS)) {
    await pg.exec(`CREATE TABLE ${table} (id serial PRIMARY KEY, ${cols.map(c => `${c} timestamp`).join(', ')})`);
  }
  await pg.exec(`INSERT INTO scores (played_at, created_at) VALUES ('2026-09-30 12:00:00', '2026-09-30 12:05:00')`);
  // Pretend scores.played_at was converted by hand already (correctly).
  await pg.exec(`BEGIN; SET LOCAL TIME ZONE 'UTC'; ALTER TABLE scores ALTER COLUMN played_at TYPE timestamptz USING played_at AT TIME ZONE 'UTC'; COMMIT;`);
  const converted = await migrate(pg);
  assert.equal(converted.length, 47);
  assert.ok(converted.includes('scores.created_at') && !converted.includes('scores.played_at'));
  const r = (await pg.query<{ p: string; c: string }>(`SELECT (played_at AT TIME ZONE 'UTC')::text AS p, (created_at AT TIME ZONE 'UTC')::text AS c FROM scores`)).rows[0];
  assert.deepEqual(r, { p: '2026-09-30 12:00:00', c: '2026-09-30 12:05:00' });
  await pg.close();
});

test('alterToTimestamptz refuses anything that is not a plain identifier', () => {
  assert.throws(() => alterToTimestamptz('scores; DROP TABLE users', ['played_at']));
  assert.throws(() => alterToTimestamptz('scores', ['played_at"']));
  assert.throws(() => alterToTimestamptz('scores', []));
  assert.equal(alterToTimestamptz('scores', ['played_at', 'created_at']),
    `ALTER TABLE scores ALTER COLUMN played_at TYPE timestamptz USING played_at AT TIME ZONE 'UTC', ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC'`);
});
