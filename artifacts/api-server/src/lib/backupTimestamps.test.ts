// Run: npx tsx --test src/lib/backupTimestamps.test.ts   (from artifacts/api-server)
//
// The seed backup/restore timestamp rule, including against a real Postgres (PGlite) whose session
// zone is deliberately not UTC: an OLD (naive-format) backup value must restore to the same instant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { serializeBackupTimestamp, parseBackupTimestamp, isNaiveBackupTimestamp } from './backupTimestamps.js';

test('old naive backup values are written as explicit UTC; zoned values and Dates pass through', () => {
  assert.equal(serializeBackupTimestamp('2026-06-30 12:34:57'), '2026-06-30 12:34:57+00');
  assert.equal(serializeBackupTimestamp('2026-06-22 21:43:16.335991'), '2026-06-22 21:43:16.335991+00');
  assert.equal(serializeBackupTimestamp('2026-06-30T12:34'), '2026-06-30T12:34+00');
  assert.equal(serializeBackupTimestamp('2026-06-22 21:43:16.335991+00'), '2026-06-22 21:43:16.335991+00');
  assert.equal(serializeBackupTimestamp('2026-06-22 17:43:16-04'), '2026-06-22 17:43:16-04');
  assert.equal(serializeBackupTimestamp('2026-06-22T21:43:16.335Z'), '2026-06-22T21:43:16.335Z');
  assert.equal(serializeBackupTimestamp(new Date('2026-06-22T21:43:16.335Z')), '2026-06-22T21:43:16.335Z');
  assert.equal(serializeBackupTimestamp('-infinity'), '-infinity');
  assert.throws(() => serializeBackupTimestamp('yesterday'));
  assert.throws(() => serializeBackupTimestamp(new Date(Number.NaN)));
  assert.equal(parseBackupTimestamp('2026-06-22 21:43:16.335991+00'), '2026-06-22 21:43:16.335991+00');
  assert.ok(isNaiveBackupTimestamp('2026-06-22 21:43:16.335991'));
  assert.ok(!isNaiveBackupTimestamp('2026-06-22 21:43:16.335991+00'));
});

test('serializing ignores the process zone', () => {
  const before = process.env.TZ;
  try {
    for (const tz of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(serializeBackupTimestamp('2026-01-15 05:00:00'), '2026-01-15 05:00:00+00', tz);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('an old naive backup value restores to the same instant under a non-UTC session, microseconds included', async () => {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'America/New_York'`);
  await pg.exec(`CREATE TABLE scores (id int PRIMARY KEY, played_at timestamptz, created_at timestamptz)`);
  const old = [
    { id: 1, played_at: '2026-05-10 00:04:00', created_at: '2026-06-30 12:34:57.335991' }, // summer (EDT)
    { id: 2, played_at: '2026-01-15 05:00:00', created_at: '2026-02-01 23:59:59.999999' }, // winter (EST)
  ];
  for (const r of old) {
    await pg.query(`INSERT INTO scores VALUES ($1, $2, $3)`, [r.id, serializeBackupTimestamp(r.played_at), serializeBackupTimestamp(r.created_at)]);
  }
  const rows = (await pg.query<{ id: number; p: string; c: string }>(
    `SELECT id, (played_at AT TIME ZONE 'UTC')::text AS p, (created_at AT TIME ZONE 'UTC')::text AS c FROM scores ORDER BY id`)).rows;
  assert.deepEqual(rows, old.map(r => ({ id: r.id, p: r.played_at, c: r.created_at })));
  // Bound bare instead, the same value would be read as a New York wall clock — the drift this prevents.
  const [bare] = (await pg.query<{ h: number }>(`SELECT extract(epoch FROM ($1::timestamptz - $2::timestamptz)) / 3600 AS h`,
    ['2026-06-30 12:34:57', serializeBackupTimestamp('2026-06-30 12:34:57')])).rows;
  assert.equal(Number(bare.h), 4);
  // A new-format value (read as text under this New York session) round-trips exactly too.
  const [{ t }] = (await pg.query<{ t: string }>(`SELECT created_at::text AS t FROM scores WHERE id = 1`)).rows;
  assert.equal(t, '2026-06-30 08:34:57.335991-04');
  await pg.query(`UPDATE scores SET created_at = $1 WHERE id = 2`, [serializeBackupTimestamp(parseBackupTimestamp(t))]);
  const [{ same }] = (await pg.query<{ same: boolean }>(`SELECT (SELECT created_at FROM scores WHERE id = 1) = (SELECT created_at FROM scores WHERE id = 2) AS same`)).rows;
  assert.equal(same, true);
  await pg.close();
});
