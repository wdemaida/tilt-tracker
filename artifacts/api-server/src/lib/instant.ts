// Instants in and out of the API. Pure — no imports.
//
// Every timestamp column is timestamptz (migrate26). What can still go wrong is a timestamp *string*
// with no offset: `new Date("2026-09-30T12:00:00")` means local time in whatever zone the process
// (or the browser) happens to run in. So:
//   - in:  a client-supplied instant must say its offset — `parseInstant` refuses one that doesn't;
//   - out: a timestamp from raw SQL (drizzle hands those back as Postgres text) is turned into an
//          ISO string with an explicit offset before it goes to a browser — `dbTimestampToIso`.

/** ISO 8601 date-time with a required `Z` or `±hh:mm` / `±hhmm` / `±hh` offset. Seconds and fraction optional. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*([Zz]|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A client-supplied instant, or `'invalid'`. Requires an explicit offset — a naive date-time ("the
 * clock said 18:01", with no zone) or a bare date is refused rather than guessed at, because every
 * guess (UTC? the server's zone? the viewer's?) is wrong for someone. The frontend always sends
 * `toISOString()` output (…Z). Numbers (epoch ms) are accepted where the caller allows them.
 */
export function parseInstant(v: unknown, opts: { allowEpochMs?: boolean } = {}): Date | 'invalid' {
  if (opts.allowEpochMs && typeof v === 'number') {
    const d = new Date(v);
    return Number.isFinite(v) && !Number.isNaN(+d) ? d : 'invalid';
  }
  if (typeof v !== 'string') return 'invalid';
  const m = INSTANT.exec(v.trim());
  if (!m) return 'invalid';
  const [, y, mo, d, h, mi, s = '00', frac = '', off] = m;
  // Range-check the fields ourselves: Date.parse rolls "02-30" over to March 2nd.
  const Y = +y, M = +mo, D = +d, H = +h, MI = +mi, S = +s;
  if (M < 1 || M > 12 || D < 1 || D > daysIn(Y, M) || H > 23 || MI > 59 || S > 59) return 'invalid';
  const ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  let offMin = 0;
  if (off !== 'Z' && off !== 'z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = +digits.slice(0, 2), om = digits.length > 2 ? +digits.slice(2) : 0;
    if (oh > 14 || om > 59) return 'invalid';
    offMin = sign * (oh * 60 + om);
  }
  const t = Date.UTC(Y, M - 1, D, H, MI, S, ms) - offMin * 60_000;
  const out = new Date(t);
  return Number.isNaN(+out) ? 'invalid' : out;
}

function daysIn(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * A timestamp from a raw query as an ISO string (…Z), or null. Drizzle returns raw-SQL timestamps as
 * Postgres text: `2026-09-26 12:34:56.789+00` for timestamptz, `2026-09-26 12:34:56.789` for a naive
 * value (the pre-migrate26 columns, which held UTC digits — so a naive value is read as UTC). Dates
 * pass through. Anything unparseable is returned unchanged.
 */
export function dbTimestampToIso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(+v) ? null : v.toISOString();
  const s = String(v).trim();
  const zoned = parseInstant(s);
  if (zoned !== 'invalid') return zoned.toISOString();
  const naive = parseInstant(`${s}Z`);
  return naive !== 'invalid' ? naive.toISOString() : s;
}
