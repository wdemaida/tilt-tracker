// Run: npx tsx --test src/lib/instant.test.ts   (from artifacts/api-server) — pure, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstant, dbTimestampToIso } from './instant.js';

const iso = (v: unknown, o?: { allowEpochMs?: boolean }) => {
  const d = parseInstant(v, o);
  return d === 'invalid' ? d : d.toISOString();
};

test('parseInstant accepts an explicit Z or numeric offset', () => {
  assert.equal(iso('2026-09-30T12:34:56.789Z'), '2026-09-30T12:34:56.789Z');
  assert.equal(iso('2026-09-30T12:34Z'), '2026-09-30T12:34:00.000Z');
  assert.equal(iso('2026-09-30T18:04:56+05:30'), '2026-09-30T12:34:56.000Z');
  assert.equal(iso('2026-09-30T08:34:56-04'), '2026-09-30T12:34:56.000Z');
  assert.equal(iso('2026-09-30T08:34:56-0400'), '2026-09-30T12:34:56.000Z');
  assert.equal(iso('2026-09-30 12:34:56.822630+00'), '2026-09-30T12:34:56.822Z', 'Postgres timestamptz text');
  assert.equal(iso(' 2026-09-30T12:34:56z '), '2026-09-30T12:34:56.000Z');
});

test('parseInstant refuses zone-less and malformed values', () => {
  for (const v of [
    '2026-09-30T12:34:56', '2026-09-30 12:34', '2026-09-30', '2026-09-30T24:00:00Z', '2026-02-30T12:00:00Z',
    '2026-13-01T00:00:00Z', '2026-09-30T12:60:00Z', '2026-09-30T12:00:00+15:00', 'Sep 30 2026 12:00 GMT', '',
    '1727699696000', null, undefined, {}, 1727699696000,
  ]) assert.equal(parseInstant(v as any), 'invalid', String(v));
});

test('parseInstant takes epoch milliseconds only when allowed', () => {
  assert.equal(iso(Date.UTC(2026, 8, 30), { allowEpochMs: true }), '2026-09-30T00:00:00.000Z');
  assert.equal(parseInstant(Number.NaN, { allowEpochMs: true }), 'invalid');
  assert.equal(parseInstant(Infinity, { allowEpochMs: true }), 'invalid');
});

test('parseInstant does not depend on the process zone', () => {
  // A zone-less string would; one with an offset never does. (lib/db pins TZ=UTC anyway.)
  const before = process.env.TZ;
  try {
    for (const tz of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
      process.env.TZ = tz;
      assert.equal(iso('2026-03-08T07:30:00Z'), '2026-03-08T07:30:00.000Z', tz);
      assert.equal(iso('2026-11-01T01:30:00-04:00'), '2026-11-01T05:30:00.000Z', tz);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('dbTimestampToIso: timestamptz text, legacy naive-UTC text and Dates all become ISO Z', () => {
  assert.equal(dbTimestampToIso('2026-09-26 12:34:56.789+00'), '2026-09-26T12:34:56.789Z');
  assert.equal(dbTimestampToIso('2026-09-26 08:34:56-04'), '2026-09-26T12:34:56.000Z');
  assert.equal(dbTimestampToIso('2026-09-26 12:34:56.789'), '2026-09-26T12:34:56.789Z');
  assert.equal(dbTimestampToIso('2026-09-26 12:34:56'), '2026-09-26T12:34:56.000Z');
  assert.equal(dbTimestampToIso('2026-09-26T12:34:56Z'), '2026-09-26T12:34:56.000Z');
  assert.equal(dbTimestampToIso(new Date('2026-01-01T00:00:00Z')), '2026-01-01T00:00:00.000Z');
  assert.equal(dbTimestampToIso(null), null);
  assert.equal(dbTimestampToIso(undefined), null);
  assert.equal(dbTimestampToIso('not a time'), 'not a time');
});
