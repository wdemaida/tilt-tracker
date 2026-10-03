// Run: ../api-server/node_modules/.bin/tsx --test src/lib/scoreSearch.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatchesSearch } from './scoreSearch';

const pops = { machineName: 'Godzilla (Premium)', venueName: "Pop's Arcade", venueOwnerUsername: null, username: 'helmhead', displayName: 'Will D' };
const home = { machineName: 'Medieval Madness', venueName: 'HOME', venueOwnerUsername: 'collasta', username: 'collasta', displayName: 'Colla Sta' };

test('matches machine, venue, username and display name, case-insensitively', () => {
  assert.ok(scoreMatchesSearch(pops, 'godzilla', 'x'));
  assert.ok(scoreMatchesSearch(pops, "POP'S", 'x'));
  assert.ok(scoreMatchesSearch(pops, 'Helmhead', 'x'));
  assert.ok(scoreMatchesSearch(pops, '@helm', 'x'));
  assert.ok(scoreMatchesSearch(pops, 'will d', 'x'));
  assert.ok(!scoreMatchesSearch(pops, 'medieval', 'x'));
});

test('every word must match somewhere (machine + venue together)', () => {
  assert.ok(scoreMatchesSearch(pops, 'godzilla arcade', 'x'));
  assert.ok(!scoreMatchesSearch(pops, 'godzilla madness', 'x'));
});

test('empty / whitespace query matches everything', () => {
  assert.ok(scoreMatchesSearch(pops, '', 'x'));
  assert.ok(scoreMatchesSearch(pops, '   ', 'x'));
});

test('a private venue matches by the label the card shows, including the owner handle', () => {
  assert.ok(scoreMatchesSearch(home, 'home (@collasta)', 'stranger'));
  assert.ok(scoreMatchesSearch(home, 'home (you)', 'collasta'));
});

test('privacy: an owner handle the server withheld is not searchable through the venue', () => {
  // Owner's "Show my machines/scores publicly" is off → the server sends no venueOwnerUsername; the
  // venue reads plain "HOME" and the owner's handle must not match through it.
  const hiddenOwner = { ...home, username: 'someoneelse', displayName: null, venueOwnerUsername: null };
  assert.ok(!scoreMatchesSearch(hiddenOwner, '@collasta', 'stranger'));
  assert.ok(!scoreMatchesSearch(hiddenOwner, 'collasta', 'stranger'));
  assert.ok(scoreMatchesSearch(hiddenOwner, 'home', 'stranger'));
});

test('privacy: only displayed fields are searched — other row fields never match', () => {
  const withExtras = { ...pops, venueAddress: '12 Secret Lane', latitude: 41.5, authorId: 7 } as typeof pops;
  assert.ok(!scoreMatchesSearch(withExtras, 'secret lane', 'x'));
  assert.ok(!scoreMatchesSearch(withExtras, '41.5', 'x'));
});
