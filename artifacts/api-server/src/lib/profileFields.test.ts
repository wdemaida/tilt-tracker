// Run: npx tsx --test src/lib/profileFields.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplayName, normalizeUsername, avatarFromClerk, clerkInstant, DISPLAY_NAME_MAX } from './profileFields.js';

const ok = (raw: unknown) => {
  const r = normalizeDisplayName(raw);
  assert.ok(r.ok, `expected ${JSON.stringify(raw)} to be accepted`);
  return r.value;
};
const code = (raw: unknown) => {
  const r = normalizeDisplayName(raw);
  assert.ok(!r.ok, `expected ${JSON.stringify(raw)} to be refused`);
  return r.code;
};

test('display name: trims and collapses whitespace, tabs and newlines included', () => {
  assert.equal(ok('  Will   DeMaida  '), 'Will DeMaida');
  assert.equal(ok('Will\tDe\nMaida'), 'Will De Maida');
  assert.equal(ok('Mike'), 'Mike');
});

test('display name: strips control and bidi override characters, keeps emoji joiners', () => {
  assert.equal(ok('Will\u0000\u0007 D'), 'Will D');
  assert.equal(ok('‮evil‬ name'), 'evil name');
  assert.equal(ok('Ada ⁦x⁩'), 'Ada x');
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  assert.equal(ok(`Fam ${family}`), `Fam ${family}`);
});

test('display name: NFC-normalizes', () => {
  assert.equal(ok('José'), 'José');
});

test('display name: blank, whitespace-only, control-only and non-strings are required errors', () => {
  for (const raw of ['', '   ', '\t\n', '\u0000\u0001', '‮', undefined, null, 42, {}, ['Will']]) {
    assert.equal(code(raw), 'display_name_required', JSON.stringify(raw));
  }
});

test('display name: 40 characters max, counted as code points', () => {
  assert.equal(ok('a'.repeat(DISPLAY_NAME_MAX)).length, 40);
  assert.equal(code('a'.repeat(DISPLAY_NAME_MAX + 1)), 'display_name_too_long');
  // 40 emoji = 80 UTF-16 units, still 40 characters.
  assert.ok(normalizeDisplayName('\u{1F3B1}'.repeat(40)).ok);
  assert.equal(code('\u{1F3B1}'.repeat(41)), 'display_name_too_long');
  // Measured after collapsing: 39 letters + lots of spaces in the middle is fine.
  assert.ok(normalizeDisplayName(`${'a'.repeat(20)}          ${'b'.repeat(19)}`).ok);
});

test('display name: may not start with @ (after trimming), may contain one', () => {
  assert.equal(code('@helmhead'), 'display_name_at');
  assert.equal(code('   @helmhead'), 'display_name_at');
  assert.equal(ok('Will @ Poit’s'), 'Will @ Poit’s');
});

test('avatarFromClerk: webhook (snake_case) and SDK (camelCase) shapes', () => {
  assert.equal(avatarFromClerk({ has_image: true, image_url: 'https://img.clerk.com/abc' }), 'https://img.clerk.com/abc');
  assert.equal(avatarFromClerk({ hasImage: true, imageUrl: 'https://img.clerk.com/def' }), 'https://img.clerk.com/def');
});

test('avatarFromClerk: null for Clerk’s default avatar (has_image false/missing), junk and non-https', () => {
  assert.equal(avatarFromClerk({ has_image: false, image_url: 'https://img.clerk.com/default' }), null);
  assert.equal(avatarFromClerk({ image_url: 'https://img.clerk.com/default' }), null);
  assert.equal(avatarFromClerk({ hasImage: 'true', imageUrl: 'https://img.clerk.com/x' }), null);
  assert.equal(avatarFromClerk({ has_image: true, image_url: 'http://img.clerk.com/x' }), null);
  assert.equal(avatarFromClerk({ has_image: true, image_url: 'javascript:alert(1)' }), null);
  assert.equal(avatarFromClerk({ has_image: true, image_url: 'not a url' }), null);
  assert.equal(avatarFromClerk({ has_image: true }), null);
  assert.equal(avatarFromClerk(null), null);
  assert.equal(avatarFromClerk('https://img.clerk.com/x'), null);
});

test('clerkInstant: ms → Date, anything else → null', () => {
  assert.equal(clerkInstant(1760000000000)?.toISOString(), new Date(1760000000000).toISOString());
  for (const v of [0, -1, NaN, Infinity, '1760000000000', null, undefined]) assert.equal(clerkInstant(v), null);
});

test('username: setup rule — trims, lowercases, drops anything but a-z 0-9 _', () => {
  const v = (raw: unknown) => { const r = normalizeUsername(raw); assert.ok(r.ok, String(raw)); return r.value; };
  assert.equal(v('  Will_D99 '), 'will_d99');
  assert.equal(v('Will D!'), 'willd');
});

test('username: blank, whitespace-only, all-invalid and non-strings are refused', () => {
  const c = (raw: unknown) => { const r = normalizeUsername(raw); assert.ok(!r.ok, String(raw)); return r.code; };
  assert.equal(c(''), 'username_required');
  assert.equal(c('   '), 'username_required');
  assert.equal(c(undefined), 'username_required');
  assert.equal(c(42), 'username_required');
  assert.equal(c('!!! ---'), 'username_invalid');
});

test('username: strict (admin) refuses what setup would silently drop, still folds case', () => {
  const strict = (raw: unknown) => normalizeUsername(raw, { strict: true });
  assert.deepEqual(strict(' Helmhead_2 '), { ok: true, value: 'helmhead_2' });
  const spaced = strict('will d');
  assert.ok(!spaced.ok && spaced.code === 'username_invalid');
  const blank = strict('  ');
  assert.ok(!blank.ok && blank.code === 'username_required');
});
