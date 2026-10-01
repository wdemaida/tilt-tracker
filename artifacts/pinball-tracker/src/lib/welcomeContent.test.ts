// Run: npx tsx --test src/lib/welcomeContent.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WELCOME_DEFAULTS, WELCOME_KEYS, mergeWelcomeContent } from './welcomeContent.ts';

test('no overrides → the defaults', () => {
  assert.deepEqual(mergeWelcomeContent({}), WELCOME_DEFAULTS);
  assert.deepEqual(mergeWelcomeContent(null), WELCOME_DEFAULTS);
  assert.deepEqual(mergeWelcomeContent('junk'), WELCOME_DEFAULTS);
});

test('an override replaces its section, field by field', () => {
  const m = mergeWelcomeContent({ 'welcome.hero': { headline: 'New', subhead: 'Sub', eyebrow: '' } });
  assert.equal(m['welcome.hero'].headline, 'New');
  assert.equal(m['welcome.hero'].eyebrow, '', 'an emptied optional field stays empty');
  assert.deepEqual(m['welcome.how'], WELCOME_DEFAULTS['welcome.how'], 'other sections untouched');
});

test('a field missing from a stored override keeps its default (added after the save)', () => {
  const m = mergeWelcomeContent({ 'welcome.founder': { title: 'Mine', body: 'Text' } });
  assert.equal(m['welcome.founder'].title, 'Mine');
  assert.equal(m['welcome.founder'].signature, WELCOME_DEFAULTS['welcome.founder'].signature);
});

test('wrong types and unknown keys are ignored', () => {
  const m = mergeWelcomeContent({
    'welcome.how': { title: 5, steps: 'nope' },
    'welcome.timeline': ['x'],
    'welcome.unknown': { a: 1 },
  });
  assert.deepEqual(m['welcome.how'], WELCOME_DEFAULTS['welcome.how']);
  assert.deepEqual(m['welcome.timeline'], WELCOME_DEFAULTS['welcome.timeline']);
  assert.ok(!('welcome.unknown' in m));
});

test('defaults cover the nine sections, with the founder note free of private details', () => {
  assert.equal(WELCOME_KEYS.length, 9);
  const all = JSON.stringify(WELCOME_DEFAULTS).toLowerCase();
  for (const word of ['brother', 'waterbury', 'cancer', 'diagnos']) assert.ok(!all.includes(word), word);
});
