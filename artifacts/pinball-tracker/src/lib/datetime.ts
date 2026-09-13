// Conversions between a real instant and the *naive* wall-clock string an
// `<input type="datetime-local">` holds.
//
// The trap these exist to close: `new Date(iso).toISOString().slice(0, 16)` looks like the obvious
// way to fill one of these inputs, but `toISOString` renders **UTC**. Feeding that to an input the
// browser reads as local time shows every score shifted by the viewer's offset, and reading the
// value back out re-parses it as local — so the shift got written to the database on save. Score
// cards and the edit modal disagreed by four or five hours because of it.
//
// A score's wall clock belongs to its **venue**, not to whoever is looking at it. Everything here
// therefore takes an optional IANA zone (`venues.timezone`) and falls back to the viewer's own zone
// only when the venue is unknown — a score with no venue, or one whose venue's zone is redacted for
// privacy. See `formatScoreTime` in `scoreTime.ts` for the display side.

import { TZDate } from '@date-fns/tz';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * How far `tz` is from UTC at a given instant, in milliseconds.
 *
 * Derived from `Intl` rather than stored, because the offset depends on the instant — a zone's
 * offset changes at every DST transition, which is exactly why `venues.timezone` holds a zone
 * *name* and never a fixed offset.
 */
function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);

  const f = Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>;
  // `hour` comes back as "24" at midnight under hour12:false in some engines.
  const hour = Number(f.hour) % 24;
  const asIfUtc = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), hour, Number(f.minute), Number(f.second));
  return asIfUtc - at.getTime();
}

/** Instant -> "YYYY-MM-DDTHH:mm" as the clock reads in `tz` (or the viewer's zone when omitted). */
export function toLocalInput(value: string | Date, tz?: string | null): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';

  if (tz) {
    const z = new TZDate(d.getTime(), tz);
    return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}` +
      `T${pad(z.getHours())}:${pad(z.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A datetime-local value -> an ISO instant, reading the wall clock in `tz` (or the viewer's zone).
 *
 * Without a zone: a date-*time* string with no offset parses as local time (unlike a date-only
 * string, which parses as UTC), which is what the input means.
 *
 * With one: guess that the digits are UTC, then correct by the zone's offset. The second pass
 * matters only across a DST boundary, where the offset at the guessed instant differs from the
 * offset at the real one — an hour's error one weekend a year if it were skipped.
 */
export function localInputToIso(value: string, tz?: string | null): string {
  if (!tz) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }

  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return value;

  const asIfUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let ts = asIfUtc - zoneOffsetMs(new Date(asIfUtc), tz);
  ts = asIfUtc - zoneOffsetMs(new Date(ts), tz);
  return new Date(ts).toISOString();
}

/**
 * The upload endpoint returns `playedAt` as a zone-less camera wall clock ("2026-09-10T18:01:00")
 * because EXIF records no timezone — see `toNaiveLocal` in the api-server's upload route. It already
 * *is* an input value; it only needs trimming to minute precision. Parsing it through `Date` first
 * would be a round trip that reintroduces the bug above.
 *
 * Which zone those digits belong to is decided later, on submit, by passing the venue's zone to
 * `localInputToIso` — that is what makes uploading a Chicago photo from home store the right instant.
 */
export function naiveToLocalInput(value: string): string {
  return value.slice(0, 16);
}
