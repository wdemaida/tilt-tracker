// Third pass of score extraction, behind SCORE_LIT_FILTER=1 (off by default): re-read a photo's
// segment displays from a copy where only the brightly lit segments keep their color.
//
// Why: an unlit gas-plasma / 7-segment window still shows every segment as a faint gray outline, and
// in bar lighting the model reads those outlines as lit 8s. A Stars (Stern 1978) upload came back as
// P1 "882,950" for 92,450 and P2 "891,330" for 41,330 — a ghost 8 in front of each real score — and no
// prompt wording fixed it. Keeping pixels of the display's own lit color at full strength and
// dimming everything else to 15% removes the outlines: the same photo then read 92,450 and 41,330.
// A hard black/white mask did worse (the glow around lit segments fills a 3 into an 8), as did
// upscaled crops; the dimmed whole photo is what worked.
//
// The lit color is measured, not assumed (photoLitHue): the dominant bright saturated hue inside each
// segment display's box from pass 1 — orange-red on Bally/Stern/Williams plasma, blue on Gottlieb's
// and on some Stars — and the boxes must agree, since a box that landed on backglass art measures
// the art. No single color → no filter. The filtered read is folded in by reconcileLitRead
// (scoreRead.ts), which only drops ghost-8 leading windows and fills x's; any other disagreement
// becomes a choice for the user. The filtered read alone is not trustworthy: it also loses lit
// digits (glare, a segment just outside the hue) and still misreads some ghosts.
//
// Evaluated 2026-10-02 on 30 photos with known scores (15 with segment displays — 12 saved uploads,
// the user's Stars screenshot and two old test photos — and 15 DMD/LCD), one run each: no
// regressions, one improvement (that Stars P2 went from a wrong 99,330 to a 4-or-9 / 1-or-9
// choice). A looser version (one hue per photo, the filtered digit winning) fixed both Stars players
// but broke two correct reads (Cheetah 633,740 → 533,740; Sinbad 67,480 → 7,480). Hence off by default.
//
// Memory: each photo is decoded once, straight to the size the model sees (≤1568px, ~1.15MP — ~3.5MB
// raw), masked in place and encoded; photos one at a time. It runs alongside the crop pass, whose
// decode is bounded separately (displayCrops.ts), so at most one bitmap of each is alive.
//
// Failure is always silent: a sharp error or an API error leaves the reads exactly as they were.

import sharp from 'sharp';
import { extractScoreReads, type ExtractionImage, type TokenUsage } from './anthropic.js';
import type { AiCallContext } from './aiUsage.js';
import { type BBox, type ImageRead } from './scoreRead.js';

/** On only when explicitly enabled — shipping this changes nothing until the flag is flipped. */
export function litFilterEnabled(): boolean {
  return process.env.SCORE_LIT_FILTER === '1';
}

/** A pixel counts as lit at or above both of these (HSV saturation and value, 0–1). */
export const MIN_LIT_SATURATION = 0.45;
export const MIN_LIT_VALUE = 0.55;
/** Lit pixels within this many degrees of the display's hue keep their color. */
export const HUE_TOLERANCE = 25;
/** Everything else is scaled to this brightness. Faint enough to hide outlines, enough to keep layout. */
export const DIM_FACTOR = 0.15;
/** A hue is only trusted when at least this share of the box pixels are lit and of one hue. */
export const MIN_LIT_SHARE = 0.004;
const MIN_LIT_PIXELS = 40;

/** Hue in degrees (0–360), saturation and value (0–1) of an 8-bit RGB pixel. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  if (max === min) return [0, s, v];
  const d = max - min;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, v];
}

/** Shortest distance between two hues, in degrees (0–180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export interface PixelRect { left: number; top: number; width: number; height: number }

/** A fractional box as a pixel rectangle, clamped to the image. null if nothing is left of it. */
export function boxToRect(box: BBox, width: number, height: number): PixelRect | null {
  const x0 = Math.max(0, Math.floor(box.x * width)), y0 = Math.max(0, Math.floor(box.y * height));
  const x1 = Math.min(width, Math.ceil((box.x + box.w) * width)), y1 = Math.min(height, Math.ceil((box.y + box.h) * height));
  return x1 > x0 && y1 > y0 ? { left: x0, top: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * The lit segments' hue: the peak of a 10°-bin histogram (smoothed with its neighbours, wrapping at
 * 360) of the lit pixels inside `rects`, refined to the circular mean of the lit pixels near that
 * peak. null when too few pixels are lit for the peak to mean anything — a display the boxes missed,
 * or one lit white, which this filter can't separate from its outlines anyway.
 */
export function dominantLitHue(
  data: Uint8Array, width: number, channels: number, rects: PixelRect[],
): { hue: number; share: number } | null {
  const bins = new Array(36).fill(0);
  const lit: number[] = [];
  let total = 0;
  for (const r of rects) {
    for (let y = r.top; y < r.top + r.height; y++) {
      for (let x = r.left; x < r.left + r.width; x++) {
        const p = (y * width + x) * channels;
        const [h, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
        total++;
        if (s < MIN_LIT_SATURATION || v < MIN_LIT_VALUE) continue;
        lit.push(h);
        bins[Math.floor(h / 10) % 36]++;
      }
    }
  }
  if (total === 0) return null;
  const smoothed = bins.map((n, i) => n + bins[(i + 35) % 36] + bins[(i + 1) % 36]);
  const peak = smoothed.indexOf(Math.max(...smoothed));
  const center = peak * 10 + 5;
  const near = lit.filter(h => hueDistance(h, center) <= 15);
  if (near.length < MIN_LIT_PIXELS || near.length / total < MIN_LIT_SHARE) return null;
  const rad = (h: number) => (h * Math.PI) / 180;
  const sx = near.reduce((a, h) => a + Math.cos(rad(h)), 0), sy = near.reduce((a, h) => a + Math.sin(rad(h)), 0);
  const hue = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
  return { hue, share: near.length / total };
}

/** Most the displays' own hues may spread before the photo's display color counts as unknown. */
export const MAX_HUE_SPREAD = 40;

/**
 * The photo's lit display color, measured one display box at a time. Boxes are routinely off by a
 * display-height, so a box can land on lit backglass art instead: on a Sinbad photo two of four
 * boxes measured red art around blue displays, and one shared hue then dimmed the real digits (a
 * correct "67480" re-read as "7480"). So every box that has a hue must agree within MAX_HUE_SPREAD
 * — machines light all their score displays the same color — or the photo isn't filtered. Boxes
 * with too few lit pixels to say are ignored; none left → null.
 */
export function photoLitHue(data: Uint8Array, width: number, channels: number, rects: PixelRect[]): number | null {
  const hues = rects.map(r => dominantLitHue(data, width, channels, [r])?.hue).filter((h): h is number => h != null);
  if (hues.length === 0) return null;
  for (const a of hues) for (const b of hues) if (hueDistance(a, b) > MAX_HUE_SPREAD) return null;
  const rad = (h: number) => (h * Math.PI) / 180;
  const sx = hues.reduce((s, h) => s + Math.cos(rad(h)), 0), sy = hues.reduce((s, h) => s + Math.sin(rad(h)), 0);
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

/** In place: lit pixels of `hue` (± HUE_TOLERANCE) keep their color, every other pixel is dimmed. */
export function applyLitMask(data: Uint8Array, channels: number, hue: number): void {
  for (let p = 0; p + 2 < data.length; p += channels) {
    const [h, s, v] = rgbToHsv(data[p], data[p + 1], data[p + 2]);
    if (s >= MIN_LIT_SATURATION && v >= MIN_LIT_VALUE && hueDistance(h, hue) <= HUE_TOLERANCE) continue;
    data[p] = Math.round(data[p] * DIM_FACTOR);
    data[p + 1] = Math.round(data[p + 1] * DIM_FACTOR);
    data[p + 2] = Math.round(data[p + 2] * DIM_FACTOR);
  }
}

/** Segment displays with a box — the only ones the filter is for (DMD/LCD screens have no outlines). */
export function litFilterBoxes(read: ImageRead): BBox[] {
  return read.displays.filter(d => d.displayKind === 'segment' && d.bbox).map(d => d.bbox!);
}

/** Largest source accepted; sharp refuses anything bigger before decoding it (as displayCrops.ts). */
const MAX_INPUT_PIXELS = 40e6;

/**
 * The filtered copy of one photo, at the size the model sees it (`image.width`/`height`, from
 * modelViewSize), or null when the boxes give no single lit hue (photoLitHue). The output is already within
 * the API's downscale limits, so the model sees exactly these pixels and its boxes come back in them.
 * A photo with an EXIF rotation is skipped, as in the crop pass: the boxes may refer to either view.
 */
export async function filterImage(image: ExtractionImage, boxes: BBox[]): Promise<{ image: ExtractionImage; hue: number } | null> {
  if (!image.width || !image.height || boxes.length === 0) return null;
  const input = Buffer.from(image.base64, 'base64');
  const { orientation } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (orientation && orientation > 1) return null;
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize({ width: image.width, height: image.height, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rects = boxes.map(b => boxToRect(b, info.width, info.height)).filter((r): r is PixelRect => !!r);
  const hue = photoLitHue(data, info.width, info.channels, rects);
  if (hue == null) return null;
  applyLitMask(data, info.channels, hue);
  const jpeg = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { image: { base64: jpeg.toString('base64'), mimeType: 'image/jpeg', width: info.width, height: info.height }, hue };
}

/** Sent ahead of the filtered photos. The main prompt is unchanged — it's the same read. */
const PREFACE = 'These photos have been image-processed to make the score displays easier to read: every pixel that is not a brightly lit display segment has been darkened. Unlit digit windows and their faint segment outlines are therefore dark — a window with no bright segments is dark ("_"), never an 8.';

export interface LitPassResult {
  /** Per input image: the read of its filtered copy, or null where no filtered copy was made. */
  reads: Array<ImageRead | null>;
  /** The measured lit hue per image (degrees), null where skipped. */
  hues: Array<number | null>;
  usage?: TokenUsage;
  error?: string;
}

/**
 * Filters every photo with segment displays (one at a time) and reads all the filtered copies in one
 * model call. Returns null reads where a photo was skipped; the caller folds the rest in with
 * reconcileLitRead. Never throws — an API failure is reported in `error` with every read null.
 */
export async function readLitFiltered(
  images: ExtractionImage[], reads: ImageRead[], onFiltered?: (imageIndex: number, jpeg: Buffer) => void, ctx?: AiCallContext,
): Promise<LitPassResult> {
  const hues: Array<number | null> = images.map(() => null);
  const filtered: Array<{ index: number; image: ExtractionImage }> = [];
  for (let i = 0; i < images.length; i++) {
    const boxes = reads[i] ? litFilterBoxes(reads[i]) : [];
    if (boxes.length === 0) continue;
    try {
      const out = await filterImage(images[i], boxes);
      if (!out) continue;
      hues[i] = out.hue;
      filtered.push({ index: i, image: out.image });
      onFiltered?.(i, Buffer.from(out.image.base64, 'base64'));
    } catch {
      // undecodable photo: keep its read as it is
    }
  }
  const none: Array<ImageRead | null> = images.map(() => null);
  if (filtered.length === 0) return { reads: none, hues };
  try {
    const result = await extractScoreReads(filtered.map(f => f.image), undefined, ctx, { operation: 'lit_filter_read', preface: PREFACE });
    const out = [...none];
    filtered.forEach((f, k) => { out[f.index] = result.reads[k] ?? null; });
    return { reads: out, hues, usage: result.usage };
  } catch (err: any) {
    return { reads: none, hues, error: String(err?.message ?? err) };
  }
}
