// Run: npx tsx --test src/lib/imageSize.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithin, orientedSize, readJpegSize, scaledBitmapUsable } from './imageSize.ts';

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/** An APP1 Exif segment whose IFD0 holds one Orientation entry. */
function exifSegment(orientation: number, little: boolean): number[] {
  const u16 = little ? u16le : u16be;
  const u32 = (n: number) => (little ? [...u16le(n & 0xffff), ...u16le(n >>> 16)] : [...u16be(n >>> 16), ...u16be(n & 0xffff)]);
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), // header, IFD0 at 8
    ...u16(1), // one entry
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, // Orientation, SHORT, 1
    ...u32(0), // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return [0xff, 0xe1, ...u16be(payload.length + 2), ...payload];
}

function sof(marker: number, width: number, height: number): number[] {
  const payload = [8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return [0xff, marker, ...u16be(payload.length + 2), ...payload];
}

const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
const dqt = [0xff, 0xdb, 0, 4, 0, 0];
const jpeg = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0, 2]);

test('a plain JPEG: the SOF size', () => {
  assert.deepEqual(readJpegSize(jpeg(app0, dqt, sof(0xc0, 12000, 9000))), { width: 12000, height: 9000, orientation: 1 });
  // Progressive (SOF2) too.
  assert.deepEqual(readJpegSize(jpeg(app0, sof(0xc2, 4000, 3000))), { width: 4000, height: 3000, orientation: 1 });
});

test('EXIF orientation 5–8 swaps to the displayed size, both byte orders', () => {
  for (const little of [true, false]) {
    for (const o of [1, 2, 3, 4]) {
      assert.deepEqual(readJpegSize(jpeg(exifSegment(o, little), sof(0xc0, 4000, 3000))), { width: 4000, height: 3000, orientation: o });
    }
    for (const o of [5, 6, 7, 8]) {
      assert.deepEqual(readJpegSize(jpeg(exifSegment(o, little), sof(0xc0, 4000, 3000))), { width: 3000, height: 4000, orientation: o });
    }
  }
});

test('DHT/fill bytes are skipped, not mistaken for a frame header', () => {
  const dht = [0xff, 0xc4, 0, 5, 0, 1, 2];
  assert.deepEqual(readJpegSize(jpeg(dht, [0xff], sof(0xc0, 640, 480))), { width: 640, height: 480, orientation: 1 });
});

test('not a JPEG, or no frame header in the bytes read: null', () => {
  assert.equal(readJpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
  assert.equal(readJpegSize(new Uint8Array([])), null);
  // Truncated before the SOF (the caller only reads the start of the file).
  const full = jpeg(app0, sof(0xc0, 640, 480));
  assert.equal(readJpegSize(full.slice(0, app0.length + 4)), null);
  // Start of scan before any SOF.
  assert.equal(readJpegSize(jpeg(app0)), null);
});

test('orientedSize', () => {
  assert.deepEqual(orientedSize(4000, 3000, 6), { width: 3000, height: 4000 });
  assert.deepEqual(orientedSize(4000, 3000, 3), { width: 4000, height: 3000 });
});

test('fitWithin never upscales and keeps the shape', () => {
  assert.deepEqual(fitWithin(16320, 12240, 4096), { width: 4096, height: 3072 });
  assert.deepEqual(fitWithin(12240, 16320, 2000), { width: 1500, height: 2000 });
  assert.deepEqual(fitWithin(800, 600, 2000), { width: 800, height: 600 });
});

test('scaledBitmapUsable: right size, ±1px, or larger of the same shape', () => {
  const target = { width: 1500, height: 2000 };
  assert.equal(scaledBitmapUsable({ width: 1500, height: 2000 }, target), true);
  assert.equal(scaledBitmapUsable({ width: 1500, height: 2001 }, target), true); // ceil vs round
  // Resize options ignored: full-size, same portrait shape — usable, drawn down later.
  assert.equal(scaledBitmapUsable({ width: 12240, height: 16320 }, target), true);
  // Resized before orientation was applied: portrait but too small — rejected.
  assert.equal(scaledBitmapUsable({ width: 1125, height: 1500 }, target), false);
  // Wrong way round — rejected.
  assert.equal(scaledBitmapUsable({ width: 2000, height: 1500 }, target), false);
  assert.equal(scaledBitmapUsable({ width: 16320, height: 12240 }, target), false);
});
