// Timestamp handling for the seed backup / restore tooling (artifacts/api-server/seedData/, which is
// gitignored dev scratch — its db.ts imports this so the rule is tracked and unit-tested). Pure.
//
// The tooling moves timestamps as opaque Postgres TEXT, never through a JS Date: a Date loses the
// microseconds (so verifyRestore's byte-for-byte check would fail) and, for a zone-less value,
// depends on the process's zone.
//
//   - Reading (oid 1114 and 1184): keep Postgres's text. For timestamptz that's "2026-06-30
//     12:34:57.123456+00" — the offset travels with it, so a backup is exact whatever zone wrote it.
//   - Writing: a value WITH an offset goes as-is. A zone-less value can only come from a backup taken
//     before migrate26, when every column held naive UTC digits — so it's written with an explicit
//     "+00". That's the conversion: explicit, not left to the session's or the process's zone. (Binding
//     it bare to a timestamptz parameter would let postgres.js / Postgres pick a zone: on an Eastern
//     laptop, postgres.js's default serializer does new Date("2026-06-30 12:34:57") — local — and every
//     restored row lands 4-5 hours late.)

const ZONED = /(?:[Zz]|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)$/;
const NAIVE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/;

/** Postgres text as read from the DB — returned unchanged (see above). */
export function parseBackupTimestamp(text: string): string {
  return text;
}

/** A value about to be bound to a timestamp / timestamptz parameter, as the text Postgres will parse. */
export function serializeBackupTimestamp(x: unknown): string {
  if (x instanceof Date) {
    if (Number.isNaN(+x)) throw new Error('serializeBackupTimestamp: invalid Date');
    return x.toISOString();
  }
  const s = String(x).trim();
  if (s === 'infinity' || s === '-infinity') return s;
  if (NAIVE.test(s)) return `${s}+00`; // a pre-migrate26 backup: naive UTC digits
  if (ZONED.test(s) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return s;
  throw new Error(`serializeBackupTimestamp: not a timestamp: ${JSON.stringify(s).slice(0, 60)}`);
}

/** True for a value in the pre-migrate26 (naive) backup format. */
export function isNaiveBackupTimestamp(x: unknown): boolean {
  return typeof x === 'string' && NAIVE.test(x.trim());
}
