// Server-side twin of the frontend's pod color validation (artifacts/pinball-tracker/src/lib/podColor.ts).
//
// Duplicated rather than shared: the frontend module imports React and the theme helpers, and the
// workspace has no plain-TS shared package to put a 20-line validator in. KEEP THE TWO IN STEP —
// same accepted inputs (`#abc`, `abc`, `#AABBCC`, surrounding whitespace), same canonical output
// (`#rrggbb`, lowercase), same palette in the same order.

export const POD_PALETTE = [
  '#fe7b32', // orange
  '#e7b6fe', // lavender
  '#1c9870', // jade
  '#fa0246', // crimson
  '#8c6d08', // ochre
  '#9d5072', // plum
] as const;

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rrggbb` lowercase, or null for anything else (named colors, rgb(), alpha, 4/8-digit hex). */
export function normalizePodColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(HEX_RE);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return `#${h}`;
}

/** First palette color not already used by one of the owner's pods; cycles once all are taken. */
export function nextPodColor(usedColors: readonly string[]): string {
  const used = new Set(usedColors.map(c => normalizePodColor(c)).filter(Boolean));
  const free = POD_PALETTE.find(c => !used.has(c));
  return free ?? POD_PALETTE[usedColors.length % POD_PALETTE.length];
}

export const POD_NAME_MAX = 40;

/** Trimmed, inner whitespace collapsed; null when empty or longer than POD_NAME_MAX. */
export function normalizePodName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().replace(/\s+/g, ' ');
  if (!name || name.length > POD_NAME_MAX) return null;
  return name;
}
