// Run: npx tsx --test src/lib/scoreRead.test.ts   (from artifacts/api-server)
//
// Pure rules only (scoreRead.ts has no imports). Covers the ghost-display and lit-player-count rules
// in sanitizeImageDisplays and the lit-filter reconciliation; the rest of scoreRead.ts was checked
// with ad-hoc scripts when it was built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGhostDisplay, sanitizePlayerCount, capToPlayerCount, sanitizeImageDisplays, type DisplayRead,
  reconcileLitDisplay, reconcileLitRead, matchLitDisplay,
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

// --- Lit-filter pass (reconcileLitDisplay / reconcileLitRead) ---

const box = (x: number, y: number) => ({ x, y, w: 0.2, h: 0.04 });
const read = (template: string, extra: Partial<DisplayRead> = {}): DisplayRead => ({
  player: null, template, lowConfidence: [], status: 'complete', possiblyTruncated: false, truncationReason: null,
  leadingPositionAmbiguous: false, displayKind: 'segment', bbox: box(0.1, 0.5), ...extra,
});

test('reconcileLitDisplay: ghost 8 leaders go when the filtered read is clean and agrees', () => {
  const out = reconcileLitDisplay(read('882950'), read('82950'));
  assert.equal(out.template, '82950');
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.litFilter, 'changed');
  assert.equal(reconcileLitDisplay(read('?92450'), read('92450')).template, '92450', 'a leading x too');
});

test('reconcileLitDisplay: a different digit becomes a choice, never a silent swap', () => {
  // The user's Stars P2: 41,330 read as "?99330" (outlines turned the 4 and the 1 into 9s).
  const out = reconcileLitDisplay(read('?99330'), read('41330'));
  assert.equal(out.template, '??330');
  assert.deepEqual(out.conflicts, [{ index: 0, candidates: ['4', '9'] }, { index: 1, candidates: ['1', '9'] }]);
  assert.equal(out.alignmentWarning, true);
  // A filter that dimmed a lit segment (Cheetah 6 → 5) only costs the user a tap.
  assert.deepEqual(reconcileLitDisplay(read('633740'), read('533740')).conflicts, [{ index: 0, candidates: ['5', '6'] }]);
});

test('reconcileLitDisplay: fills x\'s, unsure', () => {
  const out = reconcileLitDisplay(read('8079?0'), read('807940'));
  assert.equal(out.template, '807940');
  assert.deepEqual(out.lowConfidence, [4]);
});

test('reconcileLitDisplay: a non-8 leading digit keeps the base read (the filter may have lost it)', () => {
  const base = read('564700');
  assert.equal(reconcileLitDisplay(base, read('64700')), base);
  assert.equal(reconcileLitDisplay(read('189245?'), read('92450')).template, '189245?');
});

test('reconcileLitDisplay: a filtered read with x\'s of its own is ignored', () => {
  const base = read('8807?0');
  assert.equal(reconcileLitDisplay(base, read('??70')), base);
  assert.equal(reconcileLitDisplay(read('564700'), read('?64700')).template, '564700');
});

test('reconcileLitDisplay: leading digits only the filtered read has must be confirmed', () => {
  const out = reconcileLitDisplay(read('2450'), read('92450'));
  assert.equal(out.template, '?2450');
  assert.deepEqual(out.conflicts, [{ index: 0, candidates: ['9'] }]);
});

test('reconcileLitDisplay: left alone when the reads disagree more than they agree, or not a segment display', () => {
  const base = read('123456');
  assert.equal(reconcileLitDisplay(base, read('987656')), base);
  const lcd = read('882950', { displayKind: 'lcd' });
  assert.equal(reconcileLitDisplay(lcd, read('82950')), lcd);
  const short = read('880');
  assert.equal(reconcileLitDisplay(short, read('0')), short, 'dropping leaders needs 2 agreeing digits');
});

test('reconcileLitDisplay: agreement keeps the read and marks it confirmed', () => {
  const out = reconcileLitDisplay(read('512090'), read('512090'));
  assert.equal(out.template, '512090');
  assert.equal(out.litFilter, 'confirmed');
});

test('matchLitDisplay: nearest box within slack, else player number when boxes are missing', () => {
  const a = read('1', { bbox: box(0.1, 0.5) }), far = read('2', { bbox: box(0.6, 0.1) }), near = read('3', { bbox: box(0.15, 0.52) });
  assert.equal(matchLitDisplay(a, [far, near], new Set()), near);
  assert.equal(matchLitDisplay(a, [far], new Set()), null);
  assert.equal(matchLitDisplay(a, [near], new Set([near])), null, 'each filtered display is used once');
  const p2 = read('4', { player: 2, bbox: null }), q2 = read('5', { player: 2, bbox: null });
  assert.equal(matchLitDisplay(p2, [q2], new Set()), q2);
});

test('reconcileLitRead: DMD/LCD and unmatched displays untouched; null = not filtered', () => {
  const base = { displays: [read('882950', { player: 1 }), read('2339520', { displayKind: 'dot_matrix', bbox: box(0.5, 0.2) })] };
  assert.equal(reconcileLitRead(base, null), base);
  const lit = { displays: [read('82950', { bbox: box(0.11, 0.5) }), read('2339529', { bbox: box(0.5, 0.2) }), read('2710', { bbox: box(0.5, 0.8) })] };
  const out = reconcileLitRead(base, lit).displays;
  assert.deepEqual(out.map(x => x.template), ['82950', '2339520'], 'the extra filtered display (ball/match) is never added');
});
