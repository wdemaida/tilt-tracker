// Run: npx tsx --test src/lib/schema.test.ts   (from artifacts/api-server)
//
// Guards on lib/db/src/schema.ts that no DB can check for us. The dummy DATABASE_URL only satisfies
// @workspace/db's import-time check — nothing is dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const schema = await import('@workspace/db');
const { is } = await import('drizzle-orm');
const { PgTable, getTableConfig, pgTable, serial, timestamp } = await import('drizzle-orm/pg-core');

/** Every timestamp column in these tables that is NOT timestamptz, as "table.column". */
function naiveTimestamps(tables: unknown[]): string[] {
  const bad: string[] = [];
  for (const t of tables) {
    if (!is(t, PgTable)) continue;
    const cfg = getTableConfig(t);
    for (const c of cfg.columns) {
      if (c.getSQLType().startsWith('timestamp') && !(c as any).withTimezone) bad.push(`${cfg.name}.${c.name}`);
    }
  }
  return bad;
}

const tables = Object.values(schema).filter(t => is(t, PgTable));
const timestampCols = tables.flatMap(t => getTableConfig(t as any).columns.filter(c => c.getSQLType().startsWith('timestamp')));

test('every timestamp column is timestamptz (withTimezone: true)', () => {
  // A naive `timestamp` column stores digits with no zone: whoever reads or writes it decides what
  // they mean (postgres.js parses them in the process's local zone), which is how rows get shifted by
  // 4-5 hours. migrate26 converted all of them; a new one must be `timestamp(name, { withTimezone: true })`.
  assert.deepEqual(naiveTimestamps(tables), []);
  assert.ok(timestampCols.length >= 48, `found only ${timestampCols.length} timestamp columns — is the schema import right?`);
  for (const c of timestampCols) assert.equal(c.getSQLType(), 'timestamp with time zone');
});

test('the checker flags a naive timestamp column (so the test above cannot pass vacuously)', () => {
  const probe = pgTable('probe', { id: serial('id').primaryKey(), at: timestamp('at'), ok: timestamp('ok', { withTimezone: true }) });
  assert.deepEqual(naiveTimestamps([probe]), ['probe.at']);
});

// Timestamp columns added after migrate26, created as timestamptz by their own migration (so not in
// migrate26's historical list, which stays exactly what it converted).
const BORN_TIMESTAMPTZ = [
  'ai_usage.created_at', // migrate27
];

test("migrate26's column list plus later timestamptz columns is exactly the schema's timestamp columns", async () => {
  const { TIMESTAMP_COLUMNS } = await import('./timestamptzMigration.js');
  const fromSchema = tables.flatMap(t => {
    const cfg = getTableConfig(t as any);
    return cfg.columns.filter(c => c.getSQLType().startsWith('timestamp')).map(c => `${cfg.name}.${c.name}`);
  }).sort();
  const fromMigration = Object.entries(TIMESTAMP_COLUMNS).flatMap(([t, cols]) => cols.map(c => `${t}.${c}`));
  assert.equal(fromMigration.length, 48);
  assert.deepEqual(fromSchema, [...fromMigration, ...BORN_TIMESTAMPTZ].sort());
});

test('stat_history.period_date stays a calendar date', () => {
  const col = getTableConfig(schema.statHistory).columns.find(c => c.name === 'period_date')!;
  assert.equal(col.getSQLType(), 'date');
});

test('importing @workspace/db pins the process zone to UTC', () => {
  // lib/db/src/index.ts sets process.env.TZ = 'UTC' so a script on an Eastern laptop reads and
  // writes like Render does. A naive string then parses as UTC, not local time.
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(new Date('2026-09-30T12:00:00').toISOString(), '2026-09-30T12:00:00.000Z');
  assert.equal(new Date('2026-07-01T00:00:00Z').getTimezoneOffset(), 0);
});
