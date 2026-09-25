// End-to-end check of the venue merge against the Neon DEV branch. Never run against production:
// it aborts unless DATABASE_URL points at the dev endpoint.
//
//   cd artifacts/api-server
//   npx tsx test-venue-merge.ts
//
// Creates throwaway venues / scores / history / inventory rows (names start "zz-merge-test"), merges
// one into an existing venue ("Pop's Pinball - Deep Cuts" on the dev branch, left byte-identical),
// checks the permission and privacy refusals, and deletes everything it created — also on failure.
import 'dotenv/config';
import assert from 'node:assert/strict';

const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL ?? 'postgres://none@invalid/x').hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`ABORT: DATABASE_URL is not the dev branch (${DEV_ENDPOINT}) — refusing to run.`);
  process.exit(1);
}

const { db, venues, scores, users, machines, venueMachineHistory, venueInventory } = await import('@workspace/db');
const { eq, inArray, asc } = await import('drizzle-orm');
const { canRepairVenue } = await import('./src/lib/venueRepair.js');
const { applyVenueMerge, buildMergePreview, MergeRefusedError, MergeStaleError } = await import('./src/lib/venueMerge.js');

const tag = `zz-merge-test ${Date.now()}`;
const createdVenues: number[] = [];
const createdScores: number[] = [];

async function venue(values: Partial<typeof venues.$inferInsert>) {
  const [row] = await db.insert(venues).values({ ...values, name: `${tag} ${values.name ?? 'venue'}` }).returning();
  createdVenues.push(row.id);
  return row;
}
async function score(userId: number, venueId: number, machineId: number, venueName: string) {
  const [row] = await db.insert(scores).values({
    userId, venueId, machineId, venueName, score: 123450, playedAt: new Date('2026-09-01T20:00:00Z'),
  }).returning();
  createdScores.push(row.id);
  return row;
}
async function expectRefused(p: Promise<unknown>, blocker: string) {
  await assert.rejects(p, (e: any) => e instanceof MergeRefusedError && e.blocker === blocker, `expected refusal ${blocker}`);
}
const d = (s: string) => new Date(s);
const iso = (v: Date | null) => (v ? v.toISOString() : null);

let passed = 0;
function ok(msg: string) { passed++; console.log(`  ok  ${msg}`); }

try {
  const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).orderBy(asc(users.id)).limit(1);
  const plain = await db.select().from(users).where(eq(users.role, 'user')).orderBy(asc(users.id)).limit(2);
  assert.ok(admin && plain.length === 2, 'dev DB needs an admin and two ordinary users');
  const [u1, u2] = plain;
  const ms = await db.select({ id: machines.id }).from(machines).orderBy(asc(machines.id)).limit(3);
  assert.equal(ms.length, 3, 'dev DB needs three machines');
  const [m1, m2, m3] = ms.map(m => m.id);

  // --- A. Throwaway source → an existing venue --------------------------------------------------
  console.log('A. merge into an existing venue');
  const [existing] = await db.select().from(venues).where(eq(venues.name, "Pop's Pinball - Deep Cuts")).limit(1);
  assert.ok(existing, 'dev DB should have "Pop\'s Pinball - Deep Cuts"');
  assert.ok(existing.hereId && !existing.isResidence && existing.privacyTier === 'full', 'target must be a public, HERE-linked venue');
  const existingBefore = JSON.stringify(existing);
  const existingScoresBefore = (await db.select({ id: scores.id }).from(scores).where(eq(scores.venueId, existing.id))).length;
  const existingHistBefore = JSON.stringify(await db.select().from(venueMachineHistory).where(eq(venueMachineHistory.venueId, existing.id)).orderBy(asc(venueMachineHistory.id)));

  const srcA = await venue({ name: "Deep Cuts -- Pop's II", createdById: u1.id });
  const sA = await score(u1.id, srcA.id, m1, srcA.name);

  assert.equal(canRepairVenue(srcA, u1), true);
  assert.equal(canRepairVenue(srcA, u2), false);
  ok('only the creator (or an admin/owner) may repair — and so merge — the source');

  const preview = await buildMergePreview(srcA, existing, u1);
  assert.equal(preview.blocker, null);
  assert.equal(preview.counts.scoreCount, 1);
  assert.deepEqual(preview.adopts, [], 'the existing venue must not be modified beyond gaining the score');
  ok('preview: 1 score, mergeable, nothing adopted');

  const intruder = await score(u2.id, srcA.id, m1, srcA.name);
  await expectRefused(applyVenueMerge(srcA.id, existing.id, u1), 'others_scores');
  assert.equal((await db.select().from(venues).where(eq(venues.id, srcA.id))).length, 1);
  ok('a non-admin creator is refused while another player has a score there (nothing written)');
  await db.delete(scores).where(eq(scores.id, intruder.id));

  await assert.rejects(applyVenueMerge(srcA.id, existing.id, u1, 5), (e: any) => e instanceof MergeStaleError && e.scoreCount === 1);
  ok('a stale preview (expected 5 scores, now 1) is refused');

  const resA = await applyVenueMerge(srcA.id, existing.id, u1, 1);
  assert.equal(resA.scoresMoved, 1);
  const [movedA] = await db.select().from(scores).where(eq(scores.id, sA.id));
  assert.equal(movedA.venueId, existing.id);
  assert.equal(movedA.venueName, existing.name);
  assert.equal((await db.select().from(venues).where(eq(venues.id, srcA.id))).length, 0);
  for (const t of [scores, venueMachineHistory, venueInventory] as const) {
    assert.equal((await db.select({ id: t.id }).from(t).where(eq(t.venueId, srcA.id))).length, 0);
  }
  const [existingAfter] = await db.select().from(venues).where(eq(venues.id, existing.id));
  assert.equal(JSON.stringify(existingAfter), existingBefore, 'existing venue row unchanged');
  ok('score moved (venue_id + venue_name), source deleted, no references left, target row untouched');

  await db.delete(scores).where(eq(scores.id, sA.id));
  assert.equal((await db.select({ id: scores.id }).from(scores).where(eq(scores.venueId, existing.id))).length, existingScoresBefore);
  assert.equal(JSON.stringify(await db.select().from(venueMachineHistory).where(eq(venueMachineHistory.venueId, existing.id)).orderBy(asc(venueMachineHistory.id))), existingHistBefore);
  ok('existing venue back to its original scores and history');

  // --- B. History / inventory reconciliation and gap-filling (admin, throwaway target) ----------
  console.log('B. per-machine reconciliation');
  const tgtB = await venue({ name: 'target B', pinballMapId: 999_999_001 });
  const srcB = await venue({
    name: 'source B', createdById: u1.id, hereId: `${tag}-here`, pinballMapId: 999_999_002, pmMachineCount: 7,
    address: '1 Test St, Medford, MA', latitude: 42.4, longitude: -71.1, city: 'Medford', state: 'MA', timezone: 'America/New_York',
  });
  await score(u1.id, srcB.id, m1, srcB.name);
  await score(u2.id, srcB.id, m2, srcB.name);
  await db.insert(venueMachineHistory).values([
    { venueId: srcB.id, machineId: m1, firstSeenAt: d('2026-01-01'), lastSeenAt: d('2026-03-01'), removedAt: null },
    { venueId: tgtB.id, machineId: m1, firstSeenAt: d('2026-02-01'), lastSeenAt: d('2026-02-15'), removedAt: d('2026-02-20') },
    { venueId: srcB.id, machineId: m2, firstSeenAt: d('2026-01-10'), lastSeenAt: d('2026-03-01'), removedAt: null },
  ]);
  await db.insert(venueInventory).values([
    { venueId: srcB.id, machineId: m1, addedAt: d('2026-01-05'), addedById: u1.id },
    { venueId: tgtB.id, machineId: m1, addedAt: d('2025-12-01'), addedById: u2.id, removedAt: d('2026-02-10'), removedById: u2.id },
    { venueId: srcB.id, machineId: m3, addedAt: d('2026-01-07'), addedById: u1.id },
  ]);

  await expectRefused(applyVenueMerge(srcB.id, tgtB.id, u1), 'others_scores');
  const resB = await applyVenueMerge(srcB.id, tgtB.id, admin, 2);
  assert.equal(resB.scoresMoved, 2);
  assert.equal(resB.historyMerged, 1);
  assert.equal(resB.historyMoved, 1);
  assert.equal(resB.inventoryMerged, 1);
  assert.equal(resB.inventoryMoved, 1);
  assert.deepEqual(resB.adopted, ['HERE link', 'address']);
  ok('admin merges other players’ scores too; counts reported');

  const histB = await db.select().from(venueMachineHistory).where(eq(venueMachineHistory.venueId, tgtB.id));
  const h1 = histB.find(h => h.machineId === m1)!;
  const h2 = histB.find(h => h.machineId === m2)!;
  assert.equal(histB.length, 2);
  assert.equal(iso(h1.firstSeenAt), d('2026-01-01').toISOString());
  assert.equal(iso(h1.lastSeenAt), d('2026-03-01').toISOString());
  assert.equal(iso(h1.removedAt), d('2026-02-20').toISOString(), 'target’s removedAt stands');
  assert.equal(iso(h2.removedAt), d('2026-03-01').toISOString(), 'source-only current row closed at last sighting (different PM listing)');
  ok('history: overlap widened with target’s removedAt kept; source-only row moved and closed');

  const invB = await db.select().from(venueInventory).where(eq(venueInventory.venueId, tgtB.id));
  const i1 = invB.find(i => i.machineId === m1)!;
  assert.equal(invB.length, 2);
  assert.equal(i1.removedAt, null, 'the current stint wins');
  assert.equal(iso(i1.addedAt), d('2026-01-05').toISOString());
  assert.equal(i1.addedById, u1.id);
  assert.equal(i1.removedById, null);
  assert.ok(invB.some(i => i.machineId === m3 && i.removedAt == null));
  ok('inventory: current stint kept for the overlap, source-only row moved');

  const [tgtBAfter] = await db.select().from(venues).where(eq(venues.id, tgtB.id));
  assert.equal(tgtBAfter.hereId, `${tag}-here`);
  assert.equal(tgtBAfter.address, '1 Test St, Medford, MA');
  assert.equal(tgtBAfter.pinballMapId, 999_999_001, 'target keeps its own Pinball Map link');
  assert.equal((await db.select().from(venues).where(eq(venues.id, srcB.id))).length, 0);
  ok('target filled its gaps (HERE id, address) but kept its own PM link; source gone');

  // --- C. Privacy refusals, and a private → private merge by the owner --------------------------
  console.log('C. privacy rules');
  const pubC = await venue({ name: 'public C', createdById: u1.id });
  const home1 = await venue({ name: 'home 1', ownerId: u1.id, createdById: u1.id, isResidence: true, privacyTier: 'hidden' });
  const home2 = await venue({ name: 'home 2', ownerId: u1.id, createdById: u1.id, isResidence: true, privacyTier: 'city_state' });
  const home3 = await venue({ name: 'home 3 (other user)', ownerId: u2.id, createdById: u2.id, isResidence: true, privacyTier: 'hidden' });

  await expectRefused(applyVenueMerge(pubC.id, home1.id, u1), 'public_into_private');
  await expectRefused(applyVenueMerge(pubC.id, home1.id, admin), 'public_into_private');
  ok('public → private refused (owner and admin)');
  await expectRefused(applyVenueMerge(home1.id, pubC.id, u1), 'private_into_public');
  await expectRefused(applyVenueMerge(home1.id, pubC.id, admin), 'private_into_public');
  ok('private → public refused (owner and admin)');
  await expectRefused(applyVenueMerge(pubC.id, home3.id, u1), 'target_not_visible');
  await expectRefused(applyVenueMerge(home1.id, home3.id, admin), 'private_owner_mismatch');
  ok('someone else’s home is not a target; homes of two different owners never merge');
  await expectRefused(applyVenueMerge(pubC.id, pubC.id, admin), 'same_venue');
  ok('self-merge refused');

  await score(u1.id, home1.id, m1, home1.name);
  await db.insert(venueInventory).values({ venueId: home1.id, machineId: m2, addedAt: d('2026-04-01'), addedById: u1.id });
  const resC = await applyVenueMerge(home1.id, home2.id, u1, 1);
  assert.equal(resC.scoresMoved, 1);
  assert.equal(resC.inventoryMoved, 1);
  assert.deepEqual(resC.adopted, []);
  assert.equal((await db.select().from(venues).where(eq(venues.id, home1.id))).length, 0);
  ok('owner merges their own two homes; nothing adopted onto a private venue');

  console.log(`\nAll ${passed} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
} finally {
  // Everything created here, whichever venue it ended up on.
  if (createdScores.length) await db.delete(scores).where(inArray(scores.id, createdScores));
  if (createdVenues.length) {
    await db.delete(scores).where(inArray(scores.venueId, createdVenues));
    await db.delete(venueMachineHistory).where(inArray(venueMachineHistory.venueId, createdVenues));
    await db.delete(venueInventory).where(inArray(venueInventory.venueId, createdVenues));
    await db.delete(venues).where(inArray(venues.id, createdVenues));
  }
  const leftovers = await db.select({ id: venues.id }).from(venues).where(inArray(venues.id, createdVenues.length ? createdVenues : [-1]));
  console.log(`cleanup: ${leftovers.length === 0 ? 'clean' : `LEFTOVER venues ${leftovers.map(v => v.id)}`}`);
  process.exit(process.exitCode ?? 0);
}
