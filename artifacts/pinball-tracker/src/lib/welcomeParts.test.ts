// Run: npx tsx --tsconfig tsconfig.app.json --test src/lib/welcomeParts.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChips, parseLadder, socialHref, socialKind, welcomeImageUrl } from './welcomeParts.ts';

test('chips: comma-separated, a leading * highlights, blanks dropped', () => {
  assert.deepEqual(parseChips('3 days, *1 week, 2 weeks,, Custom: 1 hour to 90 days'), [
    { label: '3 days', highlighted: false },
    { label: '1 week', highlighted: true },
    { label: '2 weeks', highlighted: false },
    { label: 'Custom: 1 hour to 90 days', highlighted: false },
  ]);
  assert.deepEqual(parseChips(''), []);
  assert.deepEqual(parseChips(' * , '), []);
});

test('ladder: at most four names', () => {
  assert.deepEqual(parseLadder('A, B ,C, D, E'), ['A', 'B', 'C', 'D']);
  assert.deepEqual(parseLadder(''), []);
});

test('screenshot files: plain names in /welcome/ only', () => {
  assert.equal(welcomeImageUrl('trend.png'), '/welcome/trend.png');
  assert.equal(welcomeImageUrl(' Venue-2.JPG '), '/welcome/Venue-2.JPG');
  for (const bad of ['', '../secret.png', 'a/b.png', 'https://evil.example/x.png', 'x.svg', '.png', 'javascript:alert(1)', 'a..png']) {
    assert.equal(welcomeImageUrl(bad), null, bad);
  }
});

test('social links: icon by label, no href for empty / unsafe / mailto', () => {
  assert.equal(socialKind('Instagram'), 'instagram');
  assert.equal(socialKind('r/pinball'), 'reddit');
  assert.equal(socialKind('Our subreddit', 'https://www.reddit.com/r/tilttrack'), 'reddit');
  assert.equal(socialKind('Discord'), 'discord');
  assert.equal(socialKind('Bluesky'), 'other');
  assert.equal(socialHref(''), null);
  assert.equal(socialHref('javascript:alert(1)'), null);
  assert.equal(socialHref('mailto:a@b.c'), null);
  assert.equal(socialHref(' https://www.reddit.com/r/pinball/ '), 'https://www.reddit.com/r/pinball/');
});
