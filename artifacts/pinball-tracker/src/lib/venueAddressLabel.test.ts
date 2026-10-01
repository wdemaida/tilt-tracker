// Run: npx tsx --test src/lib/venueAddressLabel.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingAddressLabel } from './venueAddressLabel.ts';

test("someone else's private venue: Address hidden", () => {
  assert.equal(missingAddressLabel({ isPrivate: true, canEdit: false }), 'hidden');
  assert.equal(missingAddressLabel({ isPrivate: true }), 'hidden');
});

test('owner or admin: the address really is missing, whatever the tier', () => {
  assert.equal(missingAddressLabel({ isPrivate: true, canEdit: true }), 'none_on_file');
  assert.equal(missingAddressLabel({ isPrivate: false, canEdit: true }), 'none_on_file');
});

test('a public venue seen by anyone else: nothing', () => {
  assert.equal(missingAddressLabel({ isPrivate: false, canEdit: false }), null);
  assert.equal(missingAddressLabel({}), null);
});
