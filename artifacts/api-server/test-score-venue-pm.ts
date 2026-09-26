// Checks the Add Score "Places pick → Pinball Map roster" path against live HERE / Pinball Map and
// the Neon DEV branch. Never run against production: it aborts unless DATABASE_URL points at the
// dev endpoint.
//
//   cd artifacts/api-server
//   PM_LIVE_TESTS=1 npx tsx test-score-venue-pm.ts
//
// Makes ~2 live Pinball Map calls per run (closest_by_lat_lon + a roster on a cold cache), so it
// does nothing unless PM_LIVE_TESTS=1 — the standing rule: test scripts never hit PM live by
// default. With it set, PM_MODE defaults to `live` (still subject to the dev on-disk cache and the
// daily budget in pmClient.ts).
//
// 1. Live: HERE Autosuggest finds Wedgehead (Portland, OR); matchPmLocation (the rule shared with
//    the nearby suggestions) resolves it against Pinball Map's nearby list; the roster is read
//    through pmRosterCache (which may write that roster to the dev branch's pm_location_cache).
// 2. Dev DB: resolveScoreVenue (POST /api/scores' venue step) stores the resolved id on a new venue,
//    never replaces an existing link, and never links a private venue. Uses throwaway venues named
//    "zz-pm-test …" with fake HERE ids, deleted at the end — also on failure. Real venues (including
//    any real "Wedgehead") are never touched.
import 'dotenv/config';
import assert from 'node:assert/strict';

const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL ?? 'postgres://none@invalid/x').hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`ABORT: DATABASE_URL is not the dev branch (${DEV_ENDPOINT}) — refusing to run.`);
  process.exit(1);
}
if (process.env.PM_LIVE_TESTS !== '1') {
  console.log('SKIPPED: this script calls Pinball Map (and HERE) live — re-run with PM_LIVE_TESTS=1 to do that deliberately.');
  process.exit(0);
}
process.env.PM_MODE ??= 'live';

const { db, venues, users } = await import('@workspace/db');
const { eq, inArray, asc } = await import('drizzle-orm');
const { autosuggestPlaces } = await import('./src/lib/hereApi.js');
const { findNearestPmLocations } = await import('./src/lib/pinballmapApi.js');
const { matchPmLocation } = await import('./src/lib/pmMatch.js');
const { getVenueRoster } = await import('./src/lib/pmRosterCache.js');
const { resolveScoreVenue } = await import('./src/lib/scoreVenue.js');

// ── 1. Live lookup ─────────────────────────────────────────────────────────────────────────────
const places = await autosuggestPlaces('wedgehead', { lat: 45.52, lng: -122.68 });
const place = places.find(p => p.name.toLowerCase().includes('wedgehead'));
assert.ok(place && place.lat != null && place.lng != null, 'HERE found Wedgehead with coordinates');
console.log(`HERE: ${place.name} — ${place.address} (${place.lat}, ${place.lng})`);

const pmNear = await findNearestPmLocations(place.lat!, place.lng!);
const match = matchPmLocation({ name: place.name, lat: place.lat, lng: place.lng }, pmNear);
assert.ok(match, 'Wedgehead matched a Pinball Map location');
const roster = await getVenueRoster(match.id);
assert.ok(roster.xrefs.length > 0, 'roster is non-empty');
console.log(`Pinball Map: #${match.id} ${match.name} — ${roster.xrefs.length} machines (fromCache=${roster.fromCache})`);
console.log(`  e.g. ${roster.xrefs.slice(0, 5).map(x => x.machine.name).join(', ')}`);

// ── 2. Persistence on save ───────────────────────────────────────────────────────────────────────
const tag = `zz-pm-test ${Date.now()}`;
const created: number[] = [];
const [someUser] = await db.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1);
assert.ok(someUser, 'dev DB has a user');
const appUser = { id: someUser.id, role: 'user' };
const read = async (id: number) => (await db.select().from(venues).where(eq(venues.id, id)).limit(1))[0];

try {
  // a) A Places pick: new venue, linked from day one.
  const hereId = `zz-test-here-${Date.now()}`;
  const a = await resolveScoreVenue({
    venueName: `${tag} Wedgehead`, venueHereId: hereId, venueLat: place.lat, venueLng: place.lng,
    venueAddress: place.address, venueTimezone: place.timezone, venuePinballMapId: match.id,
  }, appUser);
  assert.ok(a.venueId);
  created.push(a.venueId!);
  assert.equal((await read(a.venueId!)).pinballMapId, match.id, 'new venue stores the resolved PM id');

  // b) Same HERE place again with a different id: conflict-matched, existing link kept.
  const b = await resolveScoreVenue({ venueName: `${tag} Wedgehead`, venueHereId: hereId, venuePinballMapId: 999999 }, appUser);
  assert.equal(b.venueId, a.venueId, 'same HERE id → same venue');
  assert.equal((await read(a.venueId!)).pinballMapId, match.id, 'upsert does not replace an existing link');

  // c) Existing unlinked public venue by id: backfilled. Linked: left alone.
  const [unlinked] = await db.insert(venues).values({ name: `${tag} unlinked` }).returning();
  created.push(unlinked.id);
  await resolveScoreVenue({ venueId: unlinked.id, venueName: unlinked.name, venuePinballMapId: match.id }, appUser);
  assert.equal((await read(unlinked.id)).pinballMapId, match.id, 'unlinked venue backfilled');
  await resolveScoreVenue({ venueId: unlinked.id, venueName: unlinked.name, venuePinballMapId: 999999 }, appUser);
  assert.equal((await read(unlinked.id)).pinballMapId, match.id, 'backfill does not replace an existing link');

  // d) Private venues never get a link — by id, or as the (own, legacy) holder of a HERE id.
  const [home] = await db.insert(venues).values({ name: `${tag} home`, isResidence: true, ownerId: appUser.id }).returning();
  created.push(home.id);
  await resolveScoreVenue({ venueId: home.id, venueName: home.name, venuePinballMapId: match.id }, appUser);
  assert.equal((await read(home.id)).pinballMapId, null, 'residence by id stays unlinked');
  const legacyHere = `zz-test-here-legacy-${Date.now()}`;
  const [legacy] = await db.insert(venues).values({
    name: `${tag} legacy home`, privacyTier: 'hidden', ownerId: appUser.id, hereId: legacyHere,
  }).returning();
  created.push(legacy.id);
  const d = await resolveScoreVenue({ venueName: `${tag} legacy home`, venueHereId: legacyHere, venuePinballMapId: match.id }, appUser);
  assert.equal(d.venueId, legacy.id, "owner's own legacy holder is conflict-matched");
  assert.equal((await read(legacy.id)).pinballMapId, null, 'private holder stays unlinked');

  // e) Junk ids are ignored.
  const e = await resolveScoreVenue({ venueName: `${tag} junk`, venuePinballMapId: 'abc' }, appUser);
  created.push(e.venueId!);
  assert.equal((await read(e.venueId!)).pinballMapId, null, 'non-numeric PM id ignored');

  console.log('Persistence: all checks passed');
} catch (err) {
  console.error('FAILED:', err);
  process.exitCode = 1;
} finally {
  if (created.length) await db.delete(venues).where(inArray(venues.id, created));
  const left = await db.select({ id: venues.id }).from(venues).where(inArray(venues.id, created.length ? created : [-1]));
  console.log(`Cleanup: deleted ${created.length} throwaway venues, ${left.length} left`);
}
process.exit(process.exitCode ?? 0);
