// Run: npx tsx --test src/lib/machineSearch.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, searchIndex, normalizeForSearch, editDistance } from './machineSearch.js';

const FIXTURE = [
  'Theatre of Magic',
  'The Addams Family',
  'Godzilla (Pro)',
  'Godzilla (Premium)',
  'Godzilla (LE)',
  'Twilight Zone',
  'Twilight Zone (Home Edition)',
  'AC/DC (Pro)',
  'Jack*Bot',
  'Space Station',
  'Star Wars (Pro)',
  'Star Wars (Data East)',
  'Star Trek (Premium)',
  'Stars',
  'Stargate',
  'Scared Stiff',
  'Stay Puft',
  'Pokémon (Pro)',
  "Bram Stoker's Dracula",
  'Attack from Mars',
].map((name, i) => ({ id: i + 1, name }));

const index = buildSearchIndex(FIXTURE);
const names = (q: string, limit = 10) => searchIndex(index, q, limit).map(m => m.name);

test('normalizeForSearch folds case, diacritics, punctuation, leading "the" — keeps editions', () => {
  assert.equal(normalizeForSearch('The Addams Family'), 'addams family');
  assert.equal(normalizeForSearch('Pokémon (Pro)'), 'pokemon pro');
  assert.equal(normalizeForSearch('AC/DC  (LE)'), 'ac dc le');
  assert.equal(normalizeForSearch("Bram Stoker's Dracula"), 'bram stokers dracula');
  assert.equal(normalizeForSearch('the'), 'the');
});

test('editDistance counts a transposition as one edit and bails past max', () => {
  assert.equal(editDistance('theater', 'theatre', 2), 1); // er↔re is one transposition
  assert.equal(editDistance('ab', 'ba', 1), 1);
  assert.equal(editDistance('adams', 'addams', 1), 1);
  assert.equal(editDistance('kitten', 'sitting', 1), 2); // > max → max + 1
});

test('"theater" finds Theatre of Magic', () => {
  assert.equal(names('theater')[0], 'Theatre of Magic');
  assert.equal(names('theater of magic')[0], 'Theatre of Magic');
  assert.equal(names('theate')[0], 'Theatre of Magic'); // mid-typing
});

test('"addams familly" and "adams family" find The Addams Family', () => {
  assert.equal(names('addams familly')[0], 'The Addams Family');
  assert.equal(names('adams family')[0], 'The Addams Family');
  assert.equal(names('the addams family')[0], 'The Addams Family');
});

test('"godzilla pro" finds Godzilla (Pro) first; "godzilla" lists every edition', () => {
  assert.equal(names('godzilla pro')[0], 'Godzilla (Pro)');
  assert.deepEqual(names('godzilla').sort(), ['Godzilla (LE)', 'Godzilla (Premium)', 'Godzilla (Pro)']);
});

test('exact "Twilight Zone" ranks above its longer variant', () => {
  assert.deepEqual(names('Twilight Zone'), ['Twilight Zone', 'Twilight Zone (Home Edition)']);
  assert.equal(names('twilight zone')[0], 'Twilight Zone');
});

test('short tokens are prefix-only', () => {
  assert.deepEqual(names('ac'), ['AC/DC (Pro)']); // not Jack*Bot, not Space/Attack
  assert.deepEqual(names('dc'), ['AC/DC (Pro)']);
  assert.deepEqual(names('tee'), []);
});

test('"star" puts every real prefix match above any fuzzy hit', () => {
  const r = names('star');
  // "stay" is one edit from "star", so Stay Puft is a legitimate fuzzy hit — but it must rank below
  // every prefix match, which in the live catalog (dozens of Star* titles) pushes it past the limit.
  assert.deepEqual(r, ['Star Trek (Premium)', 'Star Wars (Data East)', 'Star Wars (Pro)', 'Stargate', 'Stars', 'Stay Puft']);
  assert.ok(!r.includes('Scared Stiff')); // first letter matches but it's >1 edit away
  assert.ok(!r.includes('Space Station'));
  assert.equal(names('star', 5).includes('Stay Puft'), false);
  assert.equal(names('stars')[0], 'Stars');
});

test('diacritics and apostrophes', () => {
  assert.equal(names('pokemon')[0], 'Pokémon (Pro)');
  assert.equal(names('stokers dracula')[0], "Bram Stoker's Dracula");
});

test('mid-word substring still works as a last-resort tier', () => {
  assert.deepEqual(names('zilla').length, 3);
});

test('limit is honoured and returns catalog objects untouched', () => {
  assert.equal(names('star', 2).length, 2);
  const [hit] = searchIndex(index, 'theater', 1);
  assert.strictEqual(hit, FIXTURE[0]);
});

test('empty / punctuation-only query returns nothing', () => {
  assert.deepEqual(names(''), []);
  assert.deepEqual(names('  !! '), []);
});
