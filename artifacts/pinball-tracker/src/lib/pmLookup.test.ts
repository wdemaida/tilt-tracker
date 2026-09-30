// Run: npx tsx --test src/lib/pmLookup.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pmLookupFor } from './pmLookup.ts';

const place = { name: 'Land Ho!', venueLat: 41.78809, venueLng: -69.99126 };

test('a pick that carries a Pinball Map id uses it — no pm-match', () => {
  assert.equal(pmLookupFor({ ...place, pinballMapId: 5388 }), null);
  assert.equal(pmLookupFor({ venueId: 7, name: 'Linked', pinballMapId: 20676 }), null);
});

test('a nearby HERE place with no id still gets one pm-match at its own coordinates', () => {
  // What the photo-GPS and "Use my current location" paths hand over for a place > 1 mile out.
  assert.deepEqual(pmLookupFor({ ...place, pinballMapId: undefined }), { lat: 41.78809, lng: -69.99126, name: 'Land Ho!' });
  assert.deepEqual(pmLookupFor({ ...place, pinballMapId: null }), { lat: 41.78809, lng: -69.99126, name: 'Land Ho!' });
});

test('a search place with no id gets the same pm-match', () => {
  assert.deepEqual(pmLookupFor(place), { lat: 41.78809, lng: -69.99126, name: 'Land Ho!' });
});

test('a TiltTrack venue with no link is matched by id (nearby or search)', () => {
  assert.deepEqual(pmLookupFor({ venueId: 12, name: 'Unlinked', venueLat: 1, venueLng: 2 }), { venueId: 12 });
});

test('private venues are skipped', () => {
  assert.equal(pmLookupFor({ venueId: 3, name: 'Home', isPrivate: true }), null);
  assert.equal(pmLookupFor({ ...place, isPrivate: true }), null);
});

test('nothing to match on → no lookup', () => {
  assert.equal(pmLookupFor(null), null);
  assert.equal(pmLookupFor(undefined), null);
  assert.equal(pmLookupFor({ name: 'Typed only' }), null);
  assert.equal(pmLookupFor({ venueLat: 1, venueLng: 2 }), null);
  assert.equal(pmLookupFor({ name: 'Half', venueLat: 1 }), null);
});
