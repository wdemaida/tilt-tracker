// One-off data backfill: attach a HERE place id to venues that never got one.
//
// 30 of these came from the 2026-06-30 seed script, which pulled venues straight from Pinball Map
// and skipped HERE entirely. A null here_id isn't a broken venue — machine matching reads Pinball
// Map, not HERE — but here_id is the conflict target that stops `POST /api/scores` creating a
// duplicate venue row, so filling it in is worth doing once.
//
// Safe to re-run: it only touches venues where here_id IS NULL, and only auto-attaches on a
// confident match. Anything ambiguous is printed for a human instead of guessed at.
//
//   cd artifacts/api-server && npx tsx backfillHere.ts          # dry run, changes nothing
//   cd artifacts/api-server && npx tsx backfillHere.ts --apply  # writes
import 'dotenv/config';
import { db, venues } from '@workspace/db';
import { eq, isNull } from 'drizzle-orm';
import { findVenueByName } from './src/lib/hereApi.js';

const APPLY = process.argv.includes('--apply');

// Same rules the /repair/here route uses, kept deliberately strict: a wrong here_id is a unique
// column collision waiting to happen and is annoying to unpick.
const AUTO_ATTACH_MAX_DISTANCE_M = 100;
// A lone candidate is allowed to be further away than a contested one (a large site like an
// amusement park legitimately geocodes a few hundred metres from the arcade inside it), but not
// arbitrarily far — without a ceiling, "only one result" would auto-attach a match from the next town.
const AUTO_ATTACH_ABSOLUTE_MAX_M = 500;

function namesOverlap(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.includes(y) || y.includes(x);
}

const rows = await db
  .select({ id: venues.id, name: venues.name, address: venues.address, latitude: venues.latitude, longitude: venues.longitude })
  .from(venues)
  .where(isNull(venues.hereId));

console.log(`${rows.length} venues without a HERE id${APPLY ? '' : '  (dry run — pass --apply to write)'}\n`);

const attached: string[] = [];
const review: string[] = [];
const missed: string[] = [];

for (const v of rows) {
  if (v.latitude == null || v.longitude == null) {
    missed.push(`${v.name} — no coordinates to search from`);
    continue;
  }

  const candidates = await findVenueByName(v.name, v.latitude, v.longitude);
  const best = candidates[0];

  if (!best?.hereId) {
    missed.push(`${v.name} — HERE returned nothing nearby`);
    continue;
  }

  const confident = namesOverlap(best.name, v.name)
    && best.distance < AUTO_ATTACH_ABSOLUTE_MAX_M
    && (candidates.length === 1 || best.distance < AUTO_ATTACH_MAX_DISTANCE_M);

  if (!confident) {
    review.push(`${v.name}  →  ${best.name} (${best.distance}m, ${candidates.length} candidates)`);
    continue;
  }

  // here_id is unique across venues — never steal one already claimed by another row.
  const [clash] = await db.select({ id: venues.id, name: venues.name }).from(venues).where(eq(venues.hereId, best.hereId)).limit(1);
  if (clash && clash.id !== v.id) {
    review.push(`${v.name}  →  ${best.name} — but "${clash.name}" already holds that HERE id`);
    continue;
  }

  if (APPLY) {
    await db.update(venues)
      .set({
        hereId: best.hereId,
        ...(best.venueLat != null && { latitude: best.venueLat }),
        ...(best.venueLng != null && { longitude: best.venueLng }),
      })
      .where(eq(venues.id, v.id));
  }
  attached.push(`${v.name}  →  ${best.name} (${best.distance}m)`);
}

console.log(`ATTACHED (${attached.length})${APPLY ? '' : ' — would attach'}`);
attached.forEach(l => console.log(`  ✓ ${l}`));

console.log(`\nNEEDS REVIEW (${review.length}) — ambiguous, left alone; use the venue page's repair panel`);
review.forEach(l => console.log(`  ? ${l}`));

console.log(`\nNO MATCH (${missed.length}) — left null, which is fine`);
missed.forEach(l => console.log(`  · ${l}`));

process.exit(0);
