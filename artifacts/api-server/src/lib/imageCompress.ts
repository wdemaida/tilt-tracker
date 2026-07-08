import sharp from 'sharp';

// Anthropic rejects a base64 image payload over 10 MiB (10,485,760 bytes).
const ANTHROPIC_MAX_BASE64_BYTES = 10 * 1024 * 1024;
// Base64 inflates raw bytes by ~4/3; stay a little under the true ceiling for safety margin.
const TARGET_RAW_BYTES = Math.floor((ANTHROPIC_MAX_BASE64_BYTES * 3) / 4 * 0.97);

/**
 * Ensures an image fits under Anthropic's base64 size limit before it's sent for score extraction.
 * Score-screen photos rely on small/grainy digits staying legible, so this only touches images that
 * are actually oversized, and prefers JPEG quality reduction (compression artifacts) over resolution
 * reduction (losing the pixels that make up digit shapes) — resizing only kicks in as a last resort.
 */
export async function fitUnderAnthropicLimit(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (buffer.length <= TARGET_RAW_BYTES) return { buffer, mimeType };

  for (let quality = 90; quality >= 40; quality -= 10) {
    const out = await sharp(buffer).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= TARGET_RAW_BYTES) return { buffer: out, mimeType: 'image/jpeg' };
  }

  // Quality reduction alone wasn't enough — the image is enormous in pixel dimensions. Shrink it
  // in modest steps, re-checking each time, so we cut resolution as little as the limit demands.
  const meta = await sharp(buffer).metadata();
  let width = meta.width;
  for (let i = 0; i < 6 && width; i++) {
    width = Math.round(width * 0.85);
    const out = await sharp(buffer).resize({ width }).jpeg({ quality: 60, mozjpeg: true }).toBuffer();
    if (out.length <= TARGET_RAW_BYTES) return { buffer: out, mimeType: 'image/jpeg' };
  }

  // Give up gracefully — a small, low-quality fallback still round-trips through Anthropic cleanly
  // rather than crashing the request (or the whole process, per the route's try/catch).
  const out = await sharp(buffer).resize({ width: 1600 }).jpeg({ quality: 50, mozjpeg: true }).toBuffer();
  return { buffer: out, mimeType: 'image/jpeg' };
}
