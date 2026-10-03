// Run: npx tsx --test src/lib/venueState.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseState } from './venueState';

test('parseState reads the state abbreviation from the address the server sent', () => {
  assert.equal(parseState('213 W Institute Pl, Chicago, IL 60610-0704, United States'), 'IL');
  assert.equal(parseState('1 Main St, Boston, MA 02110'), 'MA');
  assert.equal(parseState('Somerville, MA'), 'MA'); // a city_state-tier home
  assert.equal(parseState('Portland, OR'), 'OR');
});

test('parseState: nothing to read → null (hidden-tier homes never match a state)', () => {
  assert.equal(parseState(null), null);
  assert.equal(parseState(undefined), null);
  assert.equal(parseState(''), null);
  assert.equal(parseState('Special when lit'), null);
  assert.equal(parseState('12 High St, Salisbury, United Kingdom'), null);
});
