// Second pass of score extraction: crop each score display out of the photo and have the model
// re-read it window by window.
//
// At whole-photo resolution the model reads the digits fine but only roughly knows *where* a dark
// window sits — a 6-window display showing "8807" then two dark windows came back as "_8807_", and
// "8807", dark, "0" as "88070_". A close crop of just that display fixes the placement. The pass only
// runs when it can matter (see needsCropPass): several player displays, or a segment display with
// unread or leading-dark positions. A lone complete DMD/LCD read costs nothing extra.
//
// Memory: each photo is decoded exactly once into a raw bitmap and every display is extracted from
// that — never one full decode per crop (the decode-in-a-loop pattern that OOM-killed Render once;
// see imageCompress.ts). Photos are processed one at a time; only the small crop JPEGs are held.
//
// Failure is always silent: a bad box, a sharp error or an API error leaves that photo's whole-photo
// read exactly as it was. The upload never fails because of this pass.

import sharp from 'sharp';
import { readDisplayWindows, type CropImage, type ExtractionImage, type TokenUsage } from './anthropic.js';
import { needsCropPass, reconcileWindowRead, type BBox, type ImageRead } from './scoreRead.js';

/** Most crops sent per upload, across all photos (in photo order, then display order). */
export const MAX_CROPS = 8;
/** Crops are scaled to this width — small displays are upscaled so each window is many pixels wide. */
const CROP_WIDTH = 1000;
/**
 * Padding around the model's box, as a fraction of the box. The boxes are approximate — on the test
 * photos they were routinely a third of a display-width off sideways and a full display-height off
 * vertically (a Black Knight 2000 crop at 15% padding caught only the top edge of the digits) — so
 * the crop is generous: a third of the box's width each side, a whole box height above and below.
 * A crop that still misses reads no digits and is discarded (reconcileWindowRead).
 */
const PAD_X = 0.35;
const PAD_Y = 1.0;
/** Minimum padding as a fraction of the image, for boxes so thin that 15% of them is a few pixels. */
const MIN_PAD = 0.01;

// Tied to MODEL in anthropic.ts (claude-sonnet-4-6): its image downscale limits. Re-check on a model change.
// The API downsamples any image past these (long edge / total pixels) before the model sees it, and
// the model reports display boxes in pixels of what it saw. (Checked: a 1506x2008 photo costs the
// same input tokens as the 931x1236 this computes for it.) Pixel boxes land far closer than
// fractions, which came back as round guesses that missed displays entirely.
const MODEL_MAX_EDGE = 1568;
const MODEL_MAX_PIXELS = 1_150_000;

/**
 * Attaches the size the model will see a photo at (header read only — no decode). The photo itself
 * is sent unchanged: re-encoding it ourselves, or stating its size in the prompt, both measurably
 * changed how pass 1 transcribed the displays.
 */
export async function modelViewSize(image: ExtractionImage): Promise<ExtractionImage> {
  const { width, height } = await sharp(Buffer.from(image.base64, 'base64')).metadata();
  if (!width || !height) return image;
  const scale = Math.min(1, MODEL_MAX_EDGE / Math.max(width, height), Math.sqrt(MODEL_MAX_PIXELS / (width * height)));
  return { ...image, width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface CropPassImageReport {
  imageIndex: number;
  crops: number;
  usage?: TokenUsage;
  error?: string;
  raw?: unknown;
}

export interface CropPassResult {
  reads: ImageRead[];
  report: CropPassImageReport[];
}

/** Pixel rectangle for a normalized box, padded and clamped to the image. null if degenerate. */
export function cropRect(box: BBox, width: number, height: number): { left: number; top: number; width: number; height: number } | null {
  const padX = Math.max(box.w * PAD_X, MIN_PAD);
  const padY = Math.max(box.h * PAD_Y, MIN_PAD);
  const x0 = Math.max(0, Math.floor((box.x - padX) * width));
  const y0 = Math.max(0, Math.floor((box.y - padY) * height));
  const x1 = Math.min(width, Math.ceil((box.x + box.w + padX) * width));
  const y1 = Math.min(height, Math.ceil((box.y + box.h + padY) * height));
  if (x1 - x0 < 8 || y1 - y0 < 4) return null;
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

/** Crops every box out of one image, decoding it once. A box that can't be cut is null. */
export async function cropDisplays(image: ExtractionImage, boxes: BBox[]): Promise<Array<Buffer | null>> {
  const { data, info } = await sharp(Buffer.from(image.base64, 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out: Array<Buffer | null> = [];
  for (const box of boxes) {
    const rect = cropRect(box, info.width, info.height);
    if (!rect) { out.push(null); continue; }
    try {
      out.push(await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .extract(rect)
        .resize({ width: CROP_WIDTH })
        .jpeg({ quality: 90 })
        .toBuffer());
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * Runs the crop pass over every photo that needs it and folds the window reads into the whole-photo
 * reads (reconcileWindowRead). `onCrop` is a debugging hook for local scripts (saves the crops).
 */
export async function refineWithCrops(
  images: ExtractionImage[],
  reads: ImageRead[],
  onCrop?: (imageIndex: number, displayIndex: number, jpeg: Buffer) => void,
): Promise<CropPassResult> {
  let budget = MAX_CROPS;
  const jobs: Array<{ imageIndex: number; displayIndexes: number[]; crops: CropImage[] }> = [];

  // Sequential: one decoded bitmap alive at a time.
  for (let i = 0; i < images.length && budget > 0; i++) {
    const read = reads[i];
    if (!read || !needsCropPass(read)) continue;
    const candidates = read.displays
      .map((d, k) => ({ d, k }))
      .filter(({ d }) => d.bbox)
      .slice(0, budget);
    if (candidates.length === 0) continue;
    let buffers: Array<Buffer | null>;
    try {
      buffers = await cropDisplays(images[i], candidates.map(c => c.d.bbox!));
    } catch {
      continue; // undecodable photo: keep its whole-photo read
    }
    const job = { imageIndex: i, displayIndexes: [] as number[], crops: [] as CropImage[] };
    candidates.forEach(({ d, k }, n) => {
      const buf = buffers[n];
      if (!buf) return;
      onCrop?.(i, k, buf);
      job.displayIndexes.push(k);
      job.crops.push({
        base64: buf.toString('base64'),
        mimeType: 'image/jpeg',
        label: d.player != null ? `player ${d.player}` : `display ${k + 1}`,
      });
    });
    if (job.crops.length) {
      jobs.push(job);
      budget -= job.crops.length;
    }
  }

  const out = reads.map(r => ({ displays: [...r.displays] }));
  // One call per photo, in parallel — the crops are small, the bitmaps are already released.
  const report = await Promise.all(jobs.map(async (job): Promise<CropPassImageReport> => {
    try {
      let raw: unknown;
      const { reads: windowReads, usage } = await readDisplayWindows(job.crops, r => { raw = r; });
      job.displayIndexes.forEach((k, n) => {
        const w = windowReads[n];
        if (w) out[job.imageIndex].displays[k] = reconcileWindowRead(out[job.imageIndex].displays[k], w);
      });
      return { imageIndex: job.imageIndex, crops: job.crops.length, usage, raw };
    } catch (err: any) {
      return { imageIndex: job.imageIndex, crops: job.crops.length, error: String(err?.message ?? err) };
    }
  }));

  return { reads: out, report };
}
