// Run: npx tsx --test src/lib/machineCanonical.test.ts   (from artifacts/api-server)
//
// The shared "which machine is this name?" rule, against the recorded Pinball Map catalog and two
// real venue rosters from the Portland area fixture (Happy Fortune #1125, Special When Lit #23289).
// Pure — no DB, no PM (fixtures are read from disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { machineNameParts, machineNameKey, resolveCanonicalName } from './machineCanonical.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURES = '../../fixtures/pm/';

interface CatalogEntry { id: number; name: string }
const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(here(`${FIXTURES}machines.json_no_details=1__6a82c096.json`), 'utf8'),
).body.machines;

const area = JSON.parse(readFileSync(here(
  `${FIXTURES}locations_closest_by_lat_lon.json_lat=45.5_lon=-122.7_max_distance=55_no_details=1_send_all_within_distance=true__041f3eff.json`,
), 'utf8')).body.locations as Array<{ id: number; name: string; machine_ids: number[] }>;
const byId = new Map(catalog.map(m => [m.id, m]));
function roster(pmLocationId: number): CatalogEntry[] {
  const loc = area.find(l => l.id === pmLocationId);
  assert.ok(loc, `fixture has location ${pmLocationId}`);
  return loc.machine_ids.map(id => byId.get(id)!).filter(Boolean);
}
const happyFortune = roster(1125); // Cactus Canyon (Remake Special), JAWS (Pro), The Munsters (Premium)
const specialWhenLit = roster(23289); // 44 machines incl. No Good Gofers, Indiana Jones + IJ: The Pinball Adventure

const resolve = (raw: string, opts: Parameters<typeof resolveCanonicalName<CatalogEntry>>[1]) =>
  resolveCanonicalName(raw, opts);

test('fixtures loaded', () => {
  assert.ok(catalog.length > 2000);
  assert.deepEqual(happyFortune.map(m => m.name).sort(), ['Cactus Canyon (Remake Special)', 'JAWS (Pro)', 'The Munsters (Premium)']);
  assert.ok(specialWhenLit.some(m => m.name === 'No Good Gofers'));
});

test('machineNameParts: edition parenthesized or bare, base folded', () => {
  assert.deepEqual(machineNameParts('JAWS (Pro)'), { base: 'jaws', edition: 'pro' });
  assert.deepEqual(machineNameParts('Jaws Pro Edition'), { base: 'jaws', edition: 'pro' });
  assert.deepEqual(machineNameParts('Jaws Premium'), { base: 'jaws', edition: 'premium' });
  assert.deepEqual(machineNameParts('Godzilla Limited Edition'), { base: 'godzilla', edition: 'le' });
  assert.deepEqual(machineNameParts('Godzilla (LE)'), { base: 'godzilla', edition: 'le' });
  assert.deepEqual(machineNameParts("Foo Collector's Edition"), { base: 'foo', edition: 'ce' });
  assert.deepEqual(machineNameParts('Attack From Mars (Remake) (Special Edition)'), { base: 'attack from mars remake', edition: 'se' });
  assert.deepEqual(machineNameParts('Monster Bash (Remake LE)'), { base: 'monster bash remake', edition: 'le' });
  assert.deepEqual(machineNameParts('Pokémon (Home Edition)'), { base: 'pokemon home edition', edition: '' });
  assert.deepEqual(machineNameParts('JAWS (50th Anniversary)'), { base: 'jaws 50th anniversary', edition: '' });
  assert.deepEqual(machineNameParts('The Munsters'), { base: 'munsters', edition: '' });
  assert.deepEqual(machineNameParts('Rock & Roll'), machineNameParts('Rock and Roll'));
  assert.deepEqual(machineNameParts('No Good Gofers!'), { base: 'no good gofers', edition: '' });
  // A title that is only an edition word stays a title.
  assert.deepEqual(machineNameParts('Pro'), { base: 'pro', edition: '' });
  assert.deepEqual(machineNameParts('The'), { base: 'the', edition: '' });
  assert.equal(machineNameKey('Pokemon (Pro)'), machineNameKey('Pokémon (Pro)'));
  assert.notEqual(machineNameKey('JAWS (Pro)'), machineNameKey('JAWS (Premium)'));
});

test('"Jaws Pro Edition" → "JAWS (Pro)" with the Happy Fortune roster, and with the catalog only', () => {
  const r = resolve('Jaws Pro Edition', { roster: happyFortune, catalog });
  assert.equal(r?.name, 'JAWS (Pro)');
  assert.equal(r?.source, 'roster');
  assert.equal(r?.confidence, 'normalized');

  const c = resolve('Jaws Pro Edition', { catalog });
  assert.equal(c?.name, 'JAWS (Pro)');
  assert.equal(c?.source, 'catalog');
  assert.equal(c?.entry.id, catalog.find(m => m.name === 'JAWS (Pro)')!.id);
});

test('plain "Jaws" — unique on the Happy Fortune roster, ambiguous in the catalog', () => {
  assert.equal(resolve('Jaws', { roster: happyFortune })?.name, 'JAWS (Pro)');
  assert.equal(resolve('Jaws', { catalog }), null); // Pro / Premium / LE / 50th
  // A named edition the venue doesn't have is not that venue's machine.
  assert.equal(resolve('Jaws Premium', { roster: happyFortune }), null);
  assert.equal(resolve('Jaws Premium', { roster: happyFortune, catalog })?.name, 'JAWS (Premium)');
});

test('"No Good Gofers!" → "No Good Gofers" (roster and catalog)', () => {
  assert.equal(resolve('No Good Gofers!', { roster: specialWhenLit })?.name, 'No Good Gofers');
  assert.equal(resolve('No Good Gofers!', { catalog })?.name, 'No Good Gofers');
});

test('"Pokemon (Pro)" → "Pokémon (Pro)"; plain "Pokemon" stays unmatched', () => {
  assert.equal(resolve('Pokemon (Pro)', { catalog })?.name, 'Pokémon (Pro)');
  assert.equal(resolve('Pokemon (Premium)', { catalog })?.name, 'Pokémon (Premium)');
  assert.equal(resolve('Pokemon Pro', { catalog })?.name, 'Pokémon (Pro)');
  assert.equal(resolve('Pokemon', { catalog }), null);
});

test('"The Munsters" (no edition) stays unmatched against the catalog — a human picks the edition', () => {
  assert.equal(resolve('The Munsters', { catalog }), null);
  assert.equal(resolve('Munsters', { catalog }), null);
  // …but the venue has exactly one.
  assert.equal(resolve('The Munsters', { roster: happyFortune, catalog })?.name, 'The Munsters (Premium)');
  assert.equal(resolve('Munsters Premium', { catalog })?.name, 'The Munsters (Premium)');
});

test('exact tier first: "Big Buck Hunter Pro" is a title, not Big Buck Hunter + Pro', () => {
  const r = resolve('Big Buck Hunter Pro', { catalog });
  assert.equal(r?.name, 'Big Buck Hunter Pro');
  assert.equal(r?.confidence, 'exact');
  assert.equal(resolve('big buck hunter pro', { catalog })?.confidence, 'exact');
  assert.equal(resolve('Big Buck Hunter Pro!', { catalog })?.name, 'Big Buck Hunter Pro');
});

test('Attack From Mars vs its remakes', () => {
  assert.equal(resolve('Attack From Mars', { catalog })?.name, 'Attack From Mars');
  assert.equal(resolve('attack from mars', { catalog })?.confidence, 'exact');
  assert.equal(resolve('Attack from Mars Remake', { catalog })?.name, 'Attack From Mars (Remake)');
  assert.equal(resolve('Attack From Mars Remake Special Edition', { catalog })?.name, 'Attack From Mars (Remake) (Special Edition)');
  assert.equal(resolve('Attack From Mars Remake LE', { catalog })?.name, 'Attack From Mars (Remake LE)');
  // The catalog never prefix-matches ("Attack" alone is a real 1980 Playmatic title).
  assert.equal(resolve('Attack From', { catalog }), null);
  assert.equal(resolve('Attack', { catalog })?.name, 'Attack');
  // A venue with only the remake: the roster's unique whole-word prefix wins over the catalog's original.
  const remakeOnly = catalog.filter(m => m.name === 'Attack From Mars (Remake)');
  const r = resolve('Attack From Mars', { roster: remakeOnly, catalog });
  assert.equal(r?.name, 'Attack From Mars (Remake)');
  assert.equal(r?.confidence, 'fuzzy');
});

test('roster prefix tier: unique whole words only', () => {
  // Both "Indiana Jones" and "Indiana Jones: The Pinball Adventure" are at Special When Lit.
  assert.equal(resolve('Indiana Jones', { roster: specialWhenLit })?.confidence, 'exact');
  assert.equal(resolve('Indiana Jones The Pinball Adventure', { roster: specialWhenLit })?.name, 'Indiana Jones: The Pinball Adventure');
  assert.equal(resolve('Indiana', { roster: specialWhenLit }), null);
  assert.equal(resolve('Black Knight', { roster: specialWhenLit })?.name, 'Black Knight: Sword of Rage (Pro)');
  assert.equal(resolve('Black Kni', { roster: specialWhenLit }), null); // not a whole word
  assert.equal(resolve('Cactus Canyon', { roster: happyFortune })?.name, 'Cactus Canyon (Remake Special)');
});

test('nothing to match → null; entries come back untouched', () => {
  assert.equal(resolve('', { catalog }), null);
  assert.equal(resolve('   ', { catalog }), null);
  assert.equal(resolve('Totally Made Up Machine', { catalog, roster: happyFortune }), null);
  assert.equal(resolve('Jaws', {}), null);
  const r = resolve('jaws (pro)', { catalog });
  assert.equal(r?.entry, catalog.find(m => m.name === 'JAWS (Pro)'));
});

test('duplicate catalog titles count as one name', () => {
  // "Poker Face" is listed twice (Keeney 1963, Gottlieb 1953).
  assert.equal(catalog.filter(m => m.name === 'Poker Face').length, 2);
  assert.equal(resolve('Poker Face!', { catalog })?.name, 'Poker Face');
});

test('the frontend copy is byte-identical (artifacts/pinball-tracker/src/lib/machineCanonical.ts)', () => {
  const server = readFileSync(here('./machineCanonical.ts'));
  const client = readFileSync(here('../../../pinball-tracker/src/lib/machineCanonical.ts'));
  assert.ok(server.equals(client), 'copy api-server/src/lib/machineCanonical.ts over the frontend file');
});

test('venue repair ranks with the same rule (rankRosterForName / normalizeMachineName)', async () => {
  process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';
  const { rankRosterForName, normalizeMachineName } = await import('./venueRepair.js');
  const xrefs = happyFortune.map((m, i) => ({ id: i + 1, machine: { id: m.id, name: m.name } })) as any;
  const ranked = rankRosterForName('Jaws Pro Edition', xrefs);
  assert.equal(ranked[0].pmName, 'JAWS (Pro)');
  assert.equal(ranked[0].confidence, 'normalized');
  assert.ok(ranked.slice(1).every(r => r.confidence === 'unmatched'));
  assert.equal(rankRosterForName('Jaws Premium', xrefs)[0].confidence, 'unmatched');
  assert.equal(normalizeMachineName, machineNameKey);
});
