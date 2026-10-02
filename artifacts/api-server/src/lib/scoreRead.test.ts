// Run: npx tsx --test src/lib/scoreRead.test.ts   (from artifacts/api-server)
//
// Pure rules only (scoreRead.ts has no imports). Covers the ghost-display and lit-player-count rules
// in sanitizeImageDisplays; the rest of scoreRead.ts was checked with ad-hoc scripts when it was built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGhostDisplay, sanitizePlayerCount, capToPlayerCount, sanitizeImageDisplays, type DisplayRead,
} from './scoreRead.js';

const seg = (template: string) => ({ template, displayKind: 'segment' });

test('isGhostDisplay: an unlit segment display read as 8s', () => {
  assert.equal(isGhostDisplay(seg('888888')), true);
  assert.equal(isGhostDisplay(seg('8888')), true);
  assert.equal(isGhostDisplay(seg('888')), true);
  assert.equal(isGhostDisplay(seg('88?888')), true, 'a ? among the ghost 8s');
  assert.equal(isGhostDisplay(seg('88')), true, 'two-window ghost');
});

test('isGhostDisplay: ghost 8s in front of lit zeros (Stars 3UP "8888" + "00")', () => {
  assert.equal(isGhostDisplay(seg('888800')), true);
  assert.equal(isGhostDisplay(seg('8880')), true);
});

test('isGhostDisplay: real scores and partial reads stay', () => {
  assert.equal(isGhostDisplay(seg('882950')), false, 'ghost 8s in front of real digits can\'t be told apart');
  assert.equal(isGhostDisplay(seg('92450')), false);
  assert.equal(isGhostDisplay(seg('8800')), false, 'two 8s then zeros: a real 8,800 is plausible');
  assert.equal(isGhostDisplay(seg('880')), false);
  assert.equal(isGhostDisplay(seg('8?8')), false, 'only two known 8s');
  assert.equal(isGhostDisplay(seg('8')), false);
  assert.equal(isGhostDisplay(seg('888080')), false, 'a lit 0 between 8s is a real digit');
  assert.equal(isGhostDisplay(seg('???')), false);
  assert.equal(isGhostDisplay(seg('')), false);
});

test('isGhostDisplay: only segment displays — a DMD/LCD 888,888 is a score', () => {
  assert.equal(isGhostDisplay({ template: '888888', displayKind: 'dot_matrix' }), false);
  assert.equal(isGhostDisplay({ template: '888888', displayKind: 'lcd' }), false);
  assert.equal(isGhostDisplay({ template: '888888', displayKind: undefined }), false);
});

test('sanitizePlayerCount: 1-4 integers only', () => {
  assert.equal(sanitizePlayerCount(3), 3);
  assert.equal(sanitizePlayerCount('2'), 2);
  for (const bad of [null, undefined, 0, 5, 2.5, 'x', -1, '']) assert.equal(sanitizePlayerCount(bad), null, String(bad));
});

const d = (player: number | null, template: string): DisplayRead => ({
  player, template, lowConfidence: [], status: 'complete', possiblyTruncated: false, truncationReason: null,
  leadingPositionAmbiguous: false, displayKind: 'segment',
});

test('capToPlayerCount: null count changes nothing', () => {
  const ds = [d(1, '100'), d(4, '200'), d(null, '300')];
  assert.deepEqual(capToPlayerCount(ds, null), ds);
});

test('capToPlayerCount: drops displays numbered above the lit count', () => {
  const out = capToPlayerCount([d(1, '92450'), d(2, '41330'), d(3, '00'), d(4, '888888')], 3);
  assert.deepEqual(out.map(x => x.player), [1, 2, 3]);
});

test('capToPlayerCount: unnumbered displays go only when the numbered ones fill every slot', () => {
  // 3 players, P1-P3 all numbered: the unnumbered "2310" (a ball/match display) can't be a player.
  const full = capToPlayerCount([d(1, '92450'), d(2, '41330'), d(3, '00'), d(null, '2310')], 3);
  assert.deepEqual(full.map(x => x.template), ['92450', '41330', '00']);
  // P3 isn't numbered: the unnumbered display might be P3, so it stays.
  const open = capToPlayerCount([d(1, '92450'), d(2, '41330'), d(null, '2310')], 3);
  assert.deepEqual(open.map(x => x.template), ['92450', '41330', '2310']);
  // A repeated player number fills one slot, not two.
  const dup = capToPlayerCount([d(1, '100'), d(1, '200'), d(null, '300')], 2);
  assert.deepEqual(dup.map(x => x.template), ['100', '200', '300']);
});

test('capToPlayerCount: ignored when it would leave no display with a digit', () => {
  // Lamps say 1 player, but the only score is labelled 2UP — the lamps or the label is wrong.
  const ds = [d(2, '41330'), d(3, '00')];
  assert.deepEqual(capToPlayerCount(ds, 1), ds);
});

const raw = (player: number | null, template: string, displayKind = 'segment') =>
  ({ player, displayKind, template, displayText: '', lowConfidence: [], possiblyTruncated: false, truncationReason: null, leadingPositionAmbiguous: false });

test('sanitizeImageDisplays: the Stars upload — ghost P4 and the ball/match display drop out', () => {
  // What the model returned for the user's photo: P3 was really the ball/match display, P4 an unlit
  // display. With the lamps showing 3 players and the top-right "00" numbered P3, both go.
  const displays = [raw(1, '882950'), raw(2, '891330'), raw(3, '00'), raw(4, '888888'), raw(null, '2310')];
  const out = sanitizeImageDisplays(displays, undefined, 3).displays;
  assert.deepEqual(out.map(x => [x.player, x.template]), [[1, '882950'], [2, '891330']]);
  // Without the lamps the ghost P4 still goes; the unnumbered display has nothing to rule it out.
  const noLamps = sanitizeImageDisplays(displays).displays;
  assert.deepEqual(noLamps.map(x => [x.player, x.template]), [[1, '882950'], [2, '891330'], [null, '2310']]);
});

test('sanitizeImageDisplays: a ghost display doesn\'t fill a player slot', () => {
  // Ghost-8 P2 is dropped before the cap counts slots, so the unnumbered display (maybe P2) stays.
  const out = sanitizeImageDisplays([raw(1, '5000'), raw(2, '888888'), raw(null, '7000')], undefined, 2).displays;
  assert.deepEqual(out.map(x => x.template), ['5000', '7000']);
});

test('sanitizeImageDisplays: an LCD reading 888,888 is kept', () => {
  const out = sanitizeImageDisplays([raw(1, '888888', 'lcd')]).displays;
  assert.deepEqual(out.map(x => x.template), ['888888']);
});
