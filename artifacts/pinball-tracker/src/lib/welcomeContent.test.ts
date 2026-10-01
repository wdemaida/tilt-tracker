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

test("a How-it-works row saved before step icons existed gets each step's default icon by position", () => {
  // The shape of the prod row Will saved on 2026-10-01: steps with no `icon` field.
  const stored = {
    tagline: 'No machine left behind', eyebrow: 'How it works', title: 'Mine',
    steps: [
      { title: 'One', body: 'a' }, { title: 'Two', body: 'b' }, { title: 'Three', body: 'c' }, { title: 'Four', body: 'd' },
    ],
  };
  const m = mergeWelcomeContent({ 'welcome.how': stored });
  assert.deepEqual(m['welcome.how'].steps.map(s => s.icon), ['camera', 'pinball', 'trending-up', 'camera'], 'cycled past the defaults');
  assert.deepEqual(m['welcome.how'].steps.map(s => s.title), ['One', 'Two', 'Three', 'Four'], 'the saved text is untouched');
  assert.equal(m['welcome.how'].title, 'Mine');
});

test('a chosen step icon is kept; an empty or unknown one falls back to the default for its position', () => {
  const steps = [
    { icon: 'trophy', title: 'A', body: 'a' },
    { icon: '', title: 'B', body: 'b' },
    { icon: 'not-an-icon', title: 'C', body: 'c' },
  ];
  const m = mergeWelcomeContent({ 'welcome.how': { ...WELCOME_DEFAULTS['welcome.how'], steps } });
  assert.deepEqual(m['welcome.how'].steps.map(s => s.icon), ['trophy', 'pinball', 'trending-up']);
});

test('defaults cover the nine sections, with the founder note free of private details', () => {
  assert.equal(WELCOME_KEYS.length, 9);
  const all = JSON.stringify(WELCOME_DEFAULTS).toLowerCase();
  for (const word of ['brother', 'waterbury', 'cancer', 'diagnos']) assert.ok(!all.includes(word), word);
});
