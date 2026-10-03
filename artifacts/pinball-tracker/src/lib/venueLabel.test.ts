// Run: ../api-server/node_modules/.bin/tsx --test src/lib/venueLabel.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { venueLabel, venueOwnerLabel } from './venueLabel';

test('someone else\'s private venue carries their handle', () => {
  assert.equal(venueLabel('HOME', 'collasta', 'helmhead'), 'HOME (@collasta)');
  assert.deepEqual(venueOwnerLabel('collasta', 'helmhead'), { kind: 'handle', username: 'collasta' });
  // Signed out: still the handle (the server only sends it when the owner shows their activity).
  assert.equal(venueLabel('HOME', 'collasta', null), 'HOME (@collasta)');
});

test('your own home reads "(you)", case-insensitively', () => {
  assert.equal(venueLabel('HOME', 'Helmhead', 'helmhead'), 'HOME (you)');
  assert.deepEqual(venueOwnerLabel('helmhead', 'helmhead'), { kind: 'you' });
});

test('no owner sent (public venue, or the owner hides its activity) → just the name', () => {
  assert.equal(venueLabel('Pop’s', null, 'helmhead'), 'Pop’s');
  assert.equal(venueLabel('HOME', undefined, undefined), 'HOME');
  assert.equal(venueOwnerLabel('', 'x'), null);
});
