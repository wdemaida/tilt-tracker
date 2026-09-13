// Repairs `scores.played_at` rows written before the EXIF timezone fix.
//
// The bug: `extractExifDatetime()` handed exifr's Date straight to `toISOString()`. exifr builds that
// Date by reading the camera's zone-less wall clock in the *host's* timezone, and Render runs in UTC,
// so a photo taken at 10:01pm in Chicago was stored as 22:01Z — the wall clock relabelled as UTC.
// Every affected card then rendered (offset) hours early. Scores that fell back to the form's default
// timestamp were stored correctly, so one sitting shows two clusters hours apart. That split is what
// this script keys on.
//
// Deliberately NOT automatic across the whole table. For a score uploaded days after it was played,
// a stored wall clock and a stored instant are indistinguishable, and guessing would corrupt rows
// that are currently right. It only touches scores uploaded close to when they were played, at one
// venue, inside one window — a set that can be eyeballed in full before committing.
//
//   npx tsx backfill-played-at.ts                 # dry run, prints the proposed change
//   npx tsx backfill-played-at.ts --apply
//
// Options: --venue <id> --since <iso> --until <iso> --shift <hours> --min-gap <h> --max-gap <h>

import 'dotenv/config';
import postgres from 'postgres';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APPLY = args.includes('--apply');
// Defaults describe the 2026-09-10 Headquarters (Chicago) session that surfaced the bug: CDT is
// UTC-5, so the stored wall clock is five hours behind the instant it should have been.
const VENUE_ID = Number(flag('venue', '46'));
// `played_at` / `created_at` are `timestamp WITHOUT time zone`, so these bounds are naive too — no
// `Z`, because there is no zone in the column to compare against.
const SINCE = flag('since', '2026-09-10T00:00:00');
const UNTIL = flag('until', '2026-09-12T00:00:00');
const SHIFT_HOURS = Number(flag('shift', '5'));
// A broken row's played_at sits ~one UTC offset behind its upload; a correct one is minutes behind.
const MIN_GAP_HOURS = Number(flag('min-gap', '3'));
const MAX_GAP_HOURS = Number(flag('max-gap', '7'));

const sql = postgres(process.env.DATABASE_URL!);

// postgres.js hands back a `timestamp without time zone` as a Date built in *this* machine's zone,
// so the stored wall clock is only readable through the local getters. `toISOString()` here would
// re-apply the dev box's offset and print times that don't match the column — the same confusion
// that hid this bug in the first place.
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const candidates = await sql<Array<{
  id: number; played_at: Date; created_at: Date; machine: string; gap: number;
}>>`
  SELECT s.id, s.played_at, s.created_at, m.name AS machine,
         EXTRACT(EPOCH FROM (s.created_at - s.played_at)) / 3600 AS gap
  FROM scores s
  JOIN machines m ON m.id = s.machine_id
  WHERE s.venue_id = ${VENUE_ID}
    AND s.created_at >= ${SINCE}
    AND s.created_at <  ${UNTIL}
    AND EXTRACT(EPOCH FROM (s.created_at - s.played_at)) / 3600
        BETWEEN ${MIN_GAP_HOURS} AND ${MAX_GAP_HOURS}
  ORDER BY s.created_at`;

// Everything in the window that the filter leaves alone — printed so the skipped rows get looked at
// too, rather than being invisible.
const untouched = await sql<Array<{ id: number; played_at: Date; created_at: Date; machine: string }>>`
  SELECT s.id, s.played_at, s.created_at, m.name AS machine
  FROM scores s
  JOIN machines m ON m.id = s.machine_id
  WHERE s.venue_id = ${VENUE_ID}
    AND s.created_at >= ${SINCE}
    AND s.created_at <  ${UNTIL}
    AND s.id <> ALL(${candidates.map(c => c.id)}::int[])
  ORDER BY s.created_at`;

console.log(`venue ${VENUE_ID}, uploads in [${SINCE}, ${UNTIL})`);
console.log(`shifting played_at by +${SHIFT_HOURS}h where it trails created_at by ${MIN_GAP_HOURS}-${MAX_GAP_HOURS}h\n`);

console.log(`${candidates.length} score(s) to change:`);
for (const c of candidates) {
  const next = new Date(c.played_at.getTime() + SHIFT_HOURS * 3600_000);
  console.log(
    `  #${String(c.id).padEnd(4)} ${c.machine.slice(0, 24).padEnd(24)} ` +
    `${fmt(c.played_at)} -> ${fmt(next)}   (uploaded ${fmt(c.created_at)})`
  );
}

console.log(`\n${untouched.length} score(s) left alone:`);
for (const u of untouched) {
  console.log(
    `  #${String(u.id).padEnd(4)} ${u.machine.slice(0, 24).padEnd(24)} ` +
    `${fmt(u.played_at)}                         (uploaded ${fmt(u.created_at)})`
  );
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to commit.');
} else if (candidates.length === 0) {
  console.log('\nNothing to do.');
} else {
  await sql`
    UPDATE scores
    SET played_at = played_at + ${`${SHIFT_HOURS} hours`}::interval
    WHERE id = ANY(${candidates.map(c => c.id)}::int[])`;
  console.log(`\nUpdated ${candidates.length} score(s).`);
}

await sql.end();
