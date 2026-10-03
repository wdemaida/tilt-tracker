// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/litFilter.test.ts   (from artifacts/api-server)
//
// The pixel rules of the lit-filter pass, on synthetic bitmaps. No model calls (litFilter.ts imports
// anthropic.ts, hence the dummy DATABASE_URL — it's never dialled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  rgbToHsv, hueDistance, boxToRect, dominantLitHue, photoLitHue, applyLitMask, filterImage, litFilterBoxes,
  litFilterEnabled, DIM_FACTOR,
} from './litFilter.js';
import type { DisplayRead } from './scoreRead.js';

const ORANGE: [number, number, number] = [255, 120, 20]; // lit gas plasma, hue ~26°
const BLUE: [number, number, number] = [40, 150, 255]; // lit Gottlieb VFD, hue ~211°
const RED: [number, number, number] = [230, 20, 30]; // backglass art
const GHOST: [number, number, number] = [150, 140, 135]; // an unlit segment outline: bright-ish, gray

/** A w×h RGB bitmap, `fill` everywhere, then `paint` rectangles. */
function bitmap(w: number, h: number, fill: [number, number, number], paint: Array<[number, number, number, number, [number, number, number]]> = []) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 3);
  for (const [x0, y0, x1, y1, c] of paint) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set(c, (y * w + x) * 3);
  return data;
}
const px = (data: Uint8Array, w: number, x: number, y: number) => [...data.slice((y * w + x) * 3, (y * w + x) * 3 + 3)];

test('rgbToHsv / hueDistance', () => {
  const [h, s, v] = rgbToHsv(...ORANGE);
  assert.ok(Math.abs(h - 25.9) < 0.5 && s > 0.9 && v === 1);
  assert.deepEqual(rgbToHsv(128, 128, 128).slice(1), [0, 128 / 255]);
  assert.equal(hueDistance(350, 10), 20);
  assert.equal(hueDistance(10, 200), 170);
});

test('boxToRect: fractions to clamped pixels', () => {
  assert.deepEqual(boxToRect({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, 100, 50), { left: 10, top: 10, width: 50, height: 25 });
  assert.deepEqual(boxToRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100), { left: 90, top: 90, width: 10, height: 10 });
});

test('dominantLitHue: the lit digits\' color, not the gray outlines', () => {
  const w = 100, h = 20;
  const data = bitmap(w, h, [10, 10, 10], [[0, 0, 60, 20, GHOST], [60, 0, 100, 20, ORANGE]]);
  const found = dominantLitHue(data, w, 3, [{ left: 0, top: 0, width: w, height: h }]);
  assert.ok(found && Math.abs(found.hue - 26) < 2, `got ${found?.hue}`);
  assert.equal(dominantLitHue(bitmap(w, h, GHOST), w, 3, [{ left: 0, top: 0, width: w, height: h }]), null, 'nothing lit');
});

test('photoLitHue: boxes must agree on one color', () => {
  const w = 200, h = 20;
  const data = bitmap(w, h, [10, 10, 10], [[0, 0, 100, 20, BLUE], [100, 0, 200, 20, BLUE]]);
  const left = { left: 0, top: 0, width: 100, height: 20 }, right = { left: 100, top: 0, width: 100, height: 20 };
  assert.ok(Math.abs(photoLitHue(data, w, 3, [left, right])! - 211) < 3);
  // One box landed on red art (the Sinbad case): no filter rather than the wrong color.
  const mixed = bitmap(w, h, [10, 10, 10], [[0, 0, 100, 20, BLUE], [100, 0, 200, 20, RED]]);
  assert.equal(photoLitHue(mixed, w, 3, [left, right]), null);
  // A box with nothing lit doesn't vote.
  const oneLit = bitmap(w, h, [10, 10, 10], [[0, 0, 100, 20, BLUE]]);
  assert.ok(photoLitHue(oneLit, w, 3, [left, right]) != null);
});

test('applyLitMask: lit pixels of the hue keep their color, everything else is dimmed', () => {
  const w = 3, data = bitmap(w, 1, [10, 10, 10], [[0, 0, 1, 1, ORANGE], [1, 0, 2, 1, GHOST], [2, 0, 3, 1, BLUE]]);
  applyLitMask(data, 3, 26);
  assert.deepEqual(px(data, w, 0, 0), ORANGE);
  assert.deepEqual(px(data, w, 1, 0), GHOST.map(c => Math.round(c * DIM_FACTOR)));
  assert.deepEqual(px(data, w, 2, 0), BLUE.map(c => Math.round(c * DIM_FACTOR)), 'another lit color is dimmed too');
});

const seg = (bbox: DisplayRead['bbox'], displayKind = 'segment'): DisplayRead => ({
  player: null, template: '1', lowConfidence: [], status: 'complete', possiblyTruncated: false, truncationReason: null,
  leadingPositionAmbiguous: false, displayKind, bbox,
});

test('litFilterBoxes: segment displays with a box only', () => {
  const b = { x: 0, y: 0, w: 0.5, h: 0.1 };
  assert.deepEqual(litFilterBoxes({ displays: [seg(b), seg(b, 'dot_matrix'), seg(null)] }), [b]);
});

test('filterImage: decodes at the model-view size, masks, and reports the hue', async () => {
  const w = 120, h = 60;
  const raw = bitmap(w, h, [10, 10, 10], [[10, 20, 50, 40, GHOST], [60, 20, 110, 40, ORANGE]]);
  const jpeg = await sharp(Buffer.from(raw), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const out = await filterImage({ base64: jpeg.toString('base64'), mimeType: 'image/jpeg', width: 60, height: 30 }, [{ x: 0, y: 0.3, w: 1, h: 0.4 }]);
  assert.ok(out && Math.abs(out.hue - 26) < 4, `hue ${out?.hue}`);
  assert.equal(out!.image.width, 60);
  const { data, info } = await sharp(Buffer.from(out!.image.base64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [60, 30]);
  const ghost = px(data, 60, 15, 15), lit = px(data, 60, 42, 15);
  assert.ok(ghost.every(c => c < 40), `ghost dimmed: ${ghost}`);
  assert.ok(lit[0] > 200, `lit kept: ${lit}`);
  // No size (modelViewSize couldn't read it) or no boxes → no filter.
  assert.equal(await filterImage({ base64: jpeg.toString('base64'), mimeType: 'image/jpeg' }, [{ x: 0, y: 0, w: 1, h: 1 }]), null);
});

test('litFilterEnabled: off unless SCORE_LIT_FILTER=1', () => {
  const was = process.env.SCORE_LIT_FILTER;
  delete process.env.SCORE_LIT_FILTER;
  assert.equal(litFilterEnabled(), false);
  process.env.SCORE_LIT_FILTER = 'true';
  assert.equal(litFilterEnabled(), false);
  process.env.SCORE_LIT_FILTER = '1';
  assert.equal(litFilterEnabled(), true);
  if (was == null) delete process.env.SCORE_LIT_FILTER; else process.env.SCORE_LIT_FILTER = was;
});
