import sharp from 'sharp';

// Anthropic rejects a base64 image payload over 10 MiB (10,485,760 bytes).
const ANTHROPIC_MAX_BASE64_BYTES = 10 * 1024 * 1024;
// Base64 inflates raw bytes by ~4/3; stay a little under the true ceiling for safety margin.
const TARGET_RAW_BYTES = Math.floor((ANTHROPIC_MAX_BASE64_BYTES * 3) / 4 * 0.97);

// A generous ceiling well above Claude's own effective internal vision resolution (~1568px on the
// longest edge, per Anthropic's guidance — larger inputs get downsampled internally regardless).
// Bounds the *initial* decode of a possibly-huge source (a 48MP+ phone photo can be tens of MB as a
// raw bitmap) so we never hold a giant image in memory, without costing any real legibility.
const INITIAL_DECODE_CEILING = 3000;

/**
 * Ensures an image fits under Anthropic's base64 size limit before it's sent for score extraction.
 * Score-screen photos rely on small/grainy digits staying legible, so this only touches images that
 * are actually oversized, and prefers JPEG quality reduction (compression artifacts) over resolution
 * reduction (losing the pixels that make up digit shapes) — resizing further only kicks in as a last
 * resort. Crucially, the original buffer is decoded exactly once: every fallback step below re-encodes
 * the already-downsized `working` buffer instead of re-decoding the full-size source repeatedly, which
 * previously risked OOM-crashing the whole process on a memory-constrained server.
 */
export async function fitUnderAnthropicLimit(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (buffer.length <= TARGET_RAW_BYTES) return { buffer, mimeType };

  let working = await sharp(buffer)
    .resize({ width: INITIAL_DECODE_CEILING, height: INITIAL_DECODE_CEILING, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  if (working.length <= TARGET_RAW_BYTES) return { buffer: working, mimeType: 'image/jpeg' };

  for (let quality = 80; quality >= 40; quality -= 10) {
    const out = await sharp(working).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= TARGET_RAW_BYTES) return { buffer: out, mimeType: 'image/jpeg' };
  }

  // Quality reduction alone wasn't enough — shrink resolution further, still working from the
  // already-small buffer, re-checking each step so we cut as little as the limit demands.
  let width = INITIAL_DECODE_CEILING;
  for (let i = 0; i < 5; i++) {
    width = Math.round(width * 0.8);
    const out = await sharp(working).resize({ width }).jpeg({ quality: 60, mozjpeg: true }).toBuffer();
    if (out.length <= TARGET_RAW_BYTES) return { buffer: out, mimeType: 'image/jpeg' };
  }

  // Give up gracefully — a small, low-quality fallback still round-trips cleanly through Anthropic
  // rather than crashing the request (or the whole process, per the route's try/catch).
  const out = await sharp(working).resize({ width: 1200 }).jpeg({ quality: 50, mozjpeg: true }).toBuffer();
  return { buffer: out, mimeType: 'image/jpeg' };
}
