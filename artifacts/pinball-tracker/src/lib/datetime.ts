// Conversions between a real instant and the *naive* wall-clock string an
// `<input type="datetime-local">` holds.
//
// The trap these exist to close: `new Date(iso).toISOString().slice(0, 16)` looks like the obvious
// way to fill one of these inputs, but `toISOString` renders **UTC**. Feeding that to an input the
// browser reads as local time shows every score shifted by the viewer's offset, and reading the
// value back out re-parses it as local — so the shift got written to the database on save. Score
// cards (which format in local time) and the edit modal disagreed by four or five hours because of
// it. Always route through the local getters instead.

const pad = (n: number) => String(n).padStart(2, '0');

/** Instant -> "YYYY-MM-DDTHH:mm" in the viewer's timezone, for a datetime-local input. */
export function toLocalInput(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A datetime-local value -> an ISO instant. A date-*time* string with no zone parses as local time
 * (unlike a date-only string, which parses as UTC), which is exactly what the input means.
 */
export function localInputToIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/**
 * The upload endpoint returns `playedAt` as a zone-less camera wall clock ("2026-09-10T22:01:00")
 * because EXIF records no timezone — see `toNaiveLocal` in the api-server's upload route. It already
 * *is* a local input value; it only needs trimming to minute precision. Parsing it through `Date`
 * first would be a round trip that reintroduces the bug above.
 */
export function naiveToLocalInput(value: string): string {
  return value.slice(0, 16);
}
