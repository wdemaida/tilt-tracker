// One-off machine-row cleanup after the canonical-name fix (src/lib/machineCanonical.ts, 2026-10-03).
//
//   1. Merges two zero-score duplicates into their catalog-spelled rows:
//        55 "Pokemon (Pro)"     → 219 "Pokémon (Pro)"
//        64 "Pokemon (Premium)" → 296 "Pokémon (Premium)"
//      moving every reference first (venue_machine_history / venue_inventory merged per unique
//      (venue, machine), user_challenge_machines per (user, machine)), then deleting the source row.
//   2. Deletes 798 "Test Machine XYZ" if nothing references it.
//   3. Re-enriches rows whose name EXACTLY matches a Pinball Map catalog name but lack image / OPDB id
//      (fills only null opdb_id / image_url / manufacturer / year — never overwrites).
//
// Left alone on purpose: 162, 163, 997 (Will's call), and the two scored AI-read rows 1674 "Jaws Pro
// Edition" and 1542 "No Good Gofers!" — those are fixed through the edit-score modal's per-score repair.
//
// NEVER calls Pinball Map: the catalog is read straight from the pm_catalog_cache row, at any age
// (no pmClient / pinballMap import). If that row is empty, step 3 is skipped.
//
// Every FK that references machines(id) is discovered from pg_constraint at run time, and badge rules
// (badges.rule->machine->machineId, a jsonb reference with no FK) are counted too. A merge or delete
// is refused when the source row has scores, challenges, badge-rule references or references from a
// table this script doesn't know how to move — those need a human.
//
// Dry run by default: prints the rows and their reference counts and what would change.
//
//   cd artifacts/api-server && npx tsx cleanup-machine-dupes.ts            # dry run
//   cd artifacts/api-server && npx tsx cleanup-machine-dupes.ts --apply    # execute (one transaction)

import 'dotenv/config';
import postgres from 'postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { resolveCanonicalName } from './src/lib/machineCanonical.js';
import { machineForeignKeys, machineRefCounts, mergeMachineDependents, type RunSql } from './src/lib/machineMerge.js';

const apply = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
console.log(`Database host: ${new URL(url).hostname}${apply ? '  — APPLYING CHANGES' : '  (dry run — no writes; pass --apply to execute)'}`);

const sql = postgres(url, { max: 1, onnotice: () => {} });
type Sql = typeof sql;
// The FK discovery, reference counts and per-venue merge SQL are shared with the admin machine merge
// (src/lib/machineMerge.ts). Its statements are drizzle SQL; this renders them for raw postgres.js.
const dialect = new PgDialect();
const runner = (db: Sql): RunSql => async (q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q);
  return [...(await db.unsafe(text, params as any[]))];
};

const MERGES = [
  { from: 55, fromName: 'Pokemon (Pro)', to: 219, toName: 'Pokémon (Pro)' },
  { from: 64, fromName: 'Pokemon (Premium)', to: 296, toName: 'Pokémon (Premium)' },
];
const DELETE_IF_UNREFERENCED = [{ id: 798, name: 'Test Machine XYZ' }];
const LEAVE_ALONE = new Set([162, 163, 997, 1542, 1674]);

// Tables whose machine references this script knows how to move during a merge.
const MOVABLE = new Set(['venue_machine_history.machine_id', 'venue_inventory.machine_id', 'user_challenge_machines.machine_id']);
// Known references that block a merge (they carry meaning a merge would silently change).
const BLOCKING = new Set(['scores.machine_id', 'challenges.machine_id']);

interface Fk { table: string; column: string }
const fks: Fk[] = await machineForeignKeys(runner(sql));
const fkKey = (f: Fk) => `${f.table}.${f.column}`;
console.log(`\nForeign keys to machines(id): ${fks.map(fkKey).join(', ') || '(none)'}`);
const unknownFks = fks.filter(f => !MOVABLE.has(fkKey(f)) && !BLOCKING.has(fkKey(f)));
if (unknownFks.length) console.log(`  !! not handled by this script: ${unknownFks.map(fkKey).join(', ')} — rows referenced there are refused`);

async function refCounts(db: Sql, id: number): Promise<Record<string, number>> {
  return machineRefCounts(runner(db), id, fks);
}
const fmtRefs = (refs: Record<string, number>) =>
  Object.entries(refs).map(([k, n]) => `${k}=${n}`).join('  ');

async function machineRow(db: Sql, id: number) {
  const [m] = await db`SELECT id, name, opdb_id, image_url, manufacturer, year FROM machines WHERE id = ${id}`;
  return m as { id: number; name: string; opdb_id: string | null; image_url: string | null; manufacturer: string | null; year: number | null } | undefined;
}
const describe = (m: { id: number; name: string; opdb_id: string | null; image_url: string | null; manufacturer: string | null; year: number | null }) =>
  `#${m.id} "${m.name}"  opdb=${m.opdb_id ?? '-'}  image=${m.image_url ? 'yes' : '-'}  ${m.manufacturer ?? '-'} ${m.year ?? '-'}`;

// ---- Plan (reads only) --------------------------------------------------------------------------

interface MergePlan { from: number; to: number; ok: boolean; why?: string }
const mergePlans: MergePlan[] = [];
console.log('\n== 1. Merges ==');
for (const m of MERGES) {
  const from = await machineRow(sql, m.from);
  const to = await machineRow(sql, m.to);
  console.log(`\n${m.from} → ${m.to}`);
  console.log(`  from: ${from ? describe(from) : '(missing)'}`);
  console.log(`  to:   ${to ? describe(to) : '(missing)'}`);
  if (!from || !to) { mergePlans.push({ ...m, ok: false, why: 'a row is missing (already merged?)' }); console.log('  SKIP: a row is missing (already merged?)'); continue; }
  if (from.name !== m.fromName || to.name !== m.toName) {
    mergePlans.push({ ...m, ok: false, why: 'names differ from the expected ones' });
    console.log(`  SKIP: expected "${m.fromName}" → "${m.toName}" — wrong database?`);
    continue;
  }
  const refs = await refCounts(sql, m.from);
  console.log(`  from refs: ${fmtRefs(refs)}`);
  console.log(`  to refs:   ${fmtRefs(await refCounts(sql, m.to))}`);
  const blockers = Object.entries(refs).filter(([k, n]) => n > 0 && !MOVABLE.has(k));
  if (blockers.length) {
    mergePlans.push({ ...m, ok: false, why: `references a merge must not move: ${blockers.map(([k, n]) => `${k}=${n}`).join(', ')}` });
    console.log(`  SKIP: ${mergePlans.at(-1)!.why}`);
    continue;
  }
  const hist = await sql`
    SELECT h.venue_id, h.first_seen_at, h.last_seen_at, h.removed_at,
           t.id AS target_row
      FROM venue_machine_history h
      LEFT JOIN venue_machine_history t ON t.venue_id = h.venue_id AND t.machine_id = ${m.to}
     WHERE h.machine_id = ${m.from}`;
  for (const h of hist) console.log(`  venue_machine_history venue ${h.venue_id}: ${h.target_row ? `merge into row ${h.target_row}` : 'move'}`);
  const inv = await sql`
    SELECT i.venue_id, t.id AS target_row
      FROM venue_inventory i
      LEFT JOIN venue_inventory t ON t.venue_id = i.venue_id AND t.machine_id = ${m.to}
     WHERE i.machine_id = ${m.from}`;
  for (const i of inv) console.log(`  venue_inventory venue ${i.venue_id}: ${i.target_row ? `merge into row ${i.target_row}` : 'move'}`);
  const ucm = await sql`
    SELECT u.user_id, EXISTS (SELECT 1 FROM user_challenge_machines t WHERE t.user_id = u.user_id AND t.machine_id = ${m.to}) AS has_target
      FROM user_challenge_machines u WHERE u.machine_id = ${m.from}`;
  for (const u of ucm) console.log(`  user_challenge_machines user ${u.user_id}: ${u.has_target ? 'drop (already picks the target)' : 'move'}`);
  console.log(`  then delete machine #${m.from}`);
  mergePlans.push({ ...m, ok: true });
}

console.log('\n== 2. Delete if unreferenced ==');
const deletePlans: number[] = [];
for (const d of DELETE_IF_UNREFERENCED) {
  const row = await machineRow(sql, d.id);
  if (!row) { console.log(`#${d.id}: (missing — already deleted?)`); continue; }
  const refs = await refCounts(sql, d.id);
  const total = Object.values(refs).reduce((a, b) => a + b, 0);
  console.log(`${describe(row)}\n  refs: ${fmtRefs(refs)}`);
  if (row.name !== d.name) { console.log(`  SKIP: expected "${d.name}" — wrong database?`); continue; }
  if (total > 0) { console.log('  SKIP: still referenced'); continue; }
  console.log('  will delete');
  deletePlans.push(d.id);
}

console.log('\n== 3. Re-enrich exact catalog names missing image / OPDB id ==');
interface CatalogEntry { name: string; opdb_id: string | null; opdb_img: string | null; manufacturer: string | null; year: number | null }
const [cacheRow] = await sql`SELECT data, fetched_at FROM pm_catalog_cache WHERE key = 'machines'`;
const catalog: CatalogEntry[] | null = Array.isArray(cacheRow?.data) && cacheRow.data.length ? cacheRow.data : null;
interface Enrich { id: number; name: string; set: Partial<Record<'opdb_id' | 'image_url' | 'manufacturer' | 'year', string | number>> }
const enrichPlans: Enrich[] = [];
if (!catalog) {
  console.log('No stored catalog (pm_catalog_cache is empty) — skipped. This script never fetches it.');
} else {
  console.log(`Stored catalog: ${catalog.length} machines, fetched ${cacheRow.fetched_at?.toISOString?.() ?? cacheRow.fetched_at}`);
  const byName = new Map<string, CatalogEntry[]>();
  for (const c of catalog) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const skipIds = new Set([...LEAVE_ALONE, ...MERGES.map(m => m.from), ...deletePlans]);
  const rows = await sql`
    SELECT id, name, opdb_id, image_url, manufacturer, year FROM machines
     WHERE image_url IS NULL OR opdb_id IS NULL ORDER BY id`;
  const notExact: string[] = [];
  for (const r of rows) {
    if (skipIds.has(r.id)) continue;
    const hits = byName.get(r.name);
    if (!hits) {
      const canon = resolveCanonicalName(r.name, { catalog });
      notExact.push(`  #${r.id} "${r.name}"${canon ? ` — resolves to catalog "${canon.name}" (${canon.confidence}); rename/repair by hand` : ' — no catalog match'}`);
      continue;
    }
    // A title listed twice with different OPDB ids ("Poker Face" ×2) — which one is a guess.
    if (new Set(hits.map(h => h.opdb_id)).size > 1) {
      notExact.push(`  #${r.id} "${r.name}" — listed ${hits.length}× in the catalog with different OPDB ids; left alone`);
      continue;
    }
    const pm = hits[0];
    const set: Enrich['set'] = {};
    if (r.opdb_id == null && pm.opdb_id) set.opdb_id = pm.opdb_id;
    if (r.image_url == null && pm.opdb_img) set.image_url = pm.opdb_img;
    if (r.manufacturer == null && pm.manufacturer) set.manufacturer = pm.manufacturer;
    if (r.year == null && pm.year != null) set.year = pm.year;
    if (Object.keys(set).length === 0) {
      notExact.push(`  #${r.id} "${r.name}" — exact catalog name, but the catalog has nothing to add`);
      continue;
    }
    console.log(`  #${r.id} "${r.name}": ${Object.entries(set).map(([k, v]) => `${k}=${k === 'image_url' ? 'yes' : v}`).join('  ')}`);
    enrichPlans.push({ id: r.id, name: r.name, set });
  }
  if (!enrichPlans.length) console.log('  (nothing to enrich)');
  if (notExact.length) console.log(`\nMissing image/OPDB but not enriched (${notExact.length}):\n${notExact.join('\n')}`);
}
console.log(`\nLeft alone: ${[...LEAVE_ALONE].map(id => `#${id}`).join(', ')}`);

const plannedMerges = mergePlans.filter(p => p.ok);
console.log(`\nPlan: ${plannedMerges.length} merge(s), ${deletePlans.length} delete(s), ${enrichPlans.length} re-enrichment(s).`);

if (!apply) {
  console.log('Dry run — nothing written. Re-run with --apply to execute.');
  await sql.end();
  process.exit(0);
}

// ---- Apply (one transaction; every guard re-checked under row locks) ----------------------------

await sql.begin(async tx => {
  for (const m of plannedMerges) {
    const locked = await tx`SELECT id, name FROM machines WHERE id IN (${m.from}, ${m.to}) ORDER BY id FOR UPDATE`;
    if (locked.length !== 2) throw new Error(`merge ${m.from} → ${m.to}: a row disappeared`);
    const refs = await refCounts(tx as unknown as Sql, m.from);
    const blockers = Object.entries(refs).filter(([k, n]) => n > 0 && !MOVABLE.has(k));
    if (blockers.length) throw new Error(`merge ${m.from} → ${m.to}: now referenced by ${blockers.map(([k, n]) => `${k}=${n}`).join(', ')}`);

    // venue_machine_history / venue_inventory merged per (venue, machine), user_challenge_machines per
    // (user, machine) — the same statements the admin machine merge runs (machineMerge.ts).
    await mergeMachineDependents(runner(tx as unknown as Sql), m.from, m.to);

    const left = await refCounts(tx as unknown as Sql, m.from);
    if (Object.values(left).some(n => n > 0)) throw new Error(`merge ${m.from} → ${m.to}: references remain (${fmtRefs(left)})`);
    await tx`DELETE FROM machines WHERE id = ${m.from}`;
    console.log(`merged #${m.from} → #${m.to}`);
  }

  for (const id of deletePlans) {
    await tx`SELECT id FROM machines WHERE id = ${id} FOR UPDATE`;
    const refs = await refCounts(tx as unknown as Sql, id);
    if (Object.values(refs).some(n => n > 0)) { console.log(`#${id} is referenced now — not deleted (${fmtRefs(refs)})`); continue; }
    await tx`DELETE FROM machines WHERE id = ${id}`;
    console.log(`deleted #${id}`);
  }

  for (const e of enrichPlans) {
    await tx`
      UPDATE machines SET
        opdb_id      = COALESCE(opdb_id, ${e.set.opdb_id ?? null}),
        image_url    = COALESCE(image_url, ${e.set.image_url ?? null}),
        manufacturer = COALESCE(manufacturer, ${e.set.manufacturer ?? null}),
        year         = COALESCE(year, ${e.set.year ?? null}::int)
       WHERE id = ${e.id} AND name = ${e.name}`;
    console.log(`enriched #${e.id} "${e.name}"`);
  }
});

console.log('Done.');
await sql.end();
