// Pure image-size helpers for the reduced-size decode in prepareUploadImage.ts / fullSizePhoto.ts.
// No DOM here, so they're unit-testable: npx tsx --test src/lib/imageSize.test.ts
//
// Why: a 200MP phone photo decoded at full resolution is ~800MB of pixels, which is what tips a
// memory-starved Android tab over (2026-10-01, a Galaxy S23 Ultra on Vivaldi). Knowing the size up
// front lets decodeScaled (prepareUploadImage.ts) decode straight to ≤2000px / ≤4096px instead.

export interface Size { width: number; height: number }

/** EXIF orientations 5–8 rotate the image a quarter turn, so the displayed size is the stored one swapped. */
export function orientedSize(width: number, height: number, orientation: number): Size {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/** A size that fits within `maxEdge` on its long side, never upscaled. */
export function fitWithin(width: number, height: number, maxEdge: number): Size {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** EXIF orientation (1–8) from an APP1 "Exif\0\0" segment's payload, or 1. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  // "Exif\0\0" then a TIFF header.
  if (end - start < 14) return 1;
  if (b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66) return 1;
  const tiff = start + 6;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1;
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (little
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
    : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * A JPEG's displayed size (EXIF orientation applied) from its header bytes — the SOF frame size,
 * plus the orientation tag in the APP1 segment before it. Null when it isn't a JPEG, or the frame
 * header isn't within `bytes` (the caller only reads the start of the file).
 */
export function readJpegSize(bytes: Uint8Array): (Size & { orientation: number }) | null {
  const b = bytes;
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null; // lost sync: not a marker where one should be
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any SOF
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) return null;
    const segStart = i + 4;
    const segEnd = i + 2 + length;
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segStart + 5 > b.length) return null;
      const height = (b[segStart + 1] << 8) | b[segStart + 2];
      const width = (b[segStart + 3] << 8) | b[segStart + 4];
      if (!width || !height) return null;
      return { ...orientedSize(width, height, orientation), orientation };
    }
    if (marker === 0xe1 && orientation === 1) {
      orientation = exifOrientation(b, segStart, Math.min(segEnd, b.length));
    }
    i = segEnd;
  }
  return null;
}

/**
 * Whether a bitmap decoded with `resizeWidth: target.width` is usable as the `target`-sized image.
 * Within a pixel either way is fine (browsers round the derived height differently). Anything else —
 * notably a browser that resized before applying EXIF orientation, so a portrait photo came out
 * smaller and the other way round — is rejected and the caller decodes without resize options.
 * A larger bitmap of the same shape (resize options ignored) is accepted too: it's already decoded,
 * and drawing it into the target-sized canvas gives the same result as the old full decode.
 */
export function scaledBitmapUsable(bitmap: Size, target: Size): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  if (near(bitmap.width, target.width) && near(bitmap.height, target.height)) return true;
  const sameShape = Math.abs(bitmap.width / bitmap.height - target.width / target.height) <= 0.01 * (target.width / target.height);
  return sameShape && bitmap.width >= target.width && bitmap.height >= target.height;
}
