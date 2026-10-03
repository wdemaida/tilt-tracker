// Run: npx tsx --test src/lib/statTiles.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAT_TILES, statTileInfo, whoLabel, type StatTileId } from './statTiles.ts';

const ids = Object.keys(STAT_TILES) as StatTileId[];
const pod = { id: 7, name: 'Pod X', color: 'blue' };

test('every tile has a label, a full name and a description', () => {
  assert.equal(ids.length, 10);
  for (const id of ids) {
    const t = STAT_TILES[id];
    assert.ok(t.label.trim(), `${id} label`);
    assert.ok(t.name.trim(), `${id} name`);
    assert.ok(t.description.trim().endsWith('.'), `${id} description`);
  }
});

test('the scores-per-day tile is "Scores Logged", not "Overall … Submitted"', () => {
  assert.equal(STAT_TILES.scoresPerDay.label, 'Scores Logged / Day');
  assert.equal(STAT_TILES.scoresPerDay.name, 'Scores Logged per Day');
});

test('{who} is filled from the Compare scope', () => {
  assert.equal(statTileInfo('plays', { kind: 'mine' }, null).description,
    'Every score logged by you, all time. Each score is one play.');
  assert.match(statTileInfo('plays', { kind: 'pod', podId: 7, others: false }, pod).description, /by you \+ Pod X,/);
  assert.match(statTileInfo('plays', { kind: 'friends', others: true }, null).description, /you \+ your friends \+ everyone else/);
  assert.match(statTileInfo('plays', { kind: 'all' }, null).description, /by all players,/);
  for (const id of ids) {
    assert.ok(!statTileInfo(id, { kind: 'mine' }, null).description.includes('{who}'), id);
  }
});

test('site-wide tiles read the same in every scope', () => {
  for (const id of ['venues', 'machinesInSystem'] as const) {
    assert.equal(statTileInfo(id, { kind: 'mine' }, null).description, statTileInfo(id, { kind: 'all' }, null).description);
  }
});

test('whoLabel', () => {
  assert.equal(whoLabel({ kind: 'mine' }, null), 'you');
  assert.equal(whoLabel({ kind: 'pod', podId: 7, others: true }, null), 'you + your pod + everyone else');
  assert.equal(whoLabel({ kind: 'all' }, null), 'all players');
});
