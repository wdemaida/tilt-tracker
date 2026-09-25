// Client-side helpers for partial score reads. A "template" is the score most-significant digit
// first, with `?` for every position that exists but wasn't legible in the photo — the display was
// caught mid-refresh (see the api-server's lib/scoreRead.ts, which produces them). The UI renders
// `?` as an amber "x" the user fills in from the machine.

export interface ScoreConflict {
  index: number;
  candidates: string[];
}

export interface ScorePlausibility {
  flagged: boolean;
  reason: string | null;
  median: number;
  sampleSize: number;
}

/** What /api/upload returns as `scoreRead`. */
export interface ScoreRead {
  template: string;
  lowConfidence: number[];
  status: 'complete' | 'partial' | 'unreadable';
  possiblyTruncated: boolean;
  truncationReason: string | null;
  conflicts: ScoreConflict[];
  bestImageIndex: number;
  perImage: string[];
  plausibility: ScorePlausibility | null;
}

export const unknownCount = (template: string) => (template.match(/\?/g) ?? []).length;

export const hasUnknown = (template: string) => template.includes('?');

/** Whether a comma belongs before position `i` (commas every three digits, counted from the right). */
export const commaBefore = (template: string, i: number) => i > 0 && (template.length - i) % 3 === 0;

/** "72052??" → "7,205,2xx". */
export function formatTemplate(template: string): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    if (commaBefore(template, i)) out += ',';
    out += template[i] === '?' ? 'x' : template[i];
  }
  return out;
}

/** The whole-number score, only once every x is filled. */
export function templateToScore(template: string): number | null {
  if (!/^\d+$/.test(template)) return null;
  const n = Number(template);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function setAt(template: string, i: number, ch: string): string {
  return template.slice(0, i) + ch + template.slice(i + 1);
}

/**
 * "7,205,200 — fill with 0s?" — only offered when every remaining x is at the end, which is where
 * zeros are genuinely likely (most machines score in multiples of 10 or more). Never auto-applied.
 */
export function trailingZerosSuggestion(template: string): string | null {
  return /^\d+\?+$/.test(template) ? template.replace(/\?/g, '0') : null;
}

/** Mirror of the server's checkPlausibility (lib/scoreRead.ts) — keep the two in step. */
export const PLAUSIBILITY_RATIO = 50;

export function checkPlausibility(template: string, median: number | null | undefined, sampleSize: number): ScorePlausibility | null {
  if (median == null || !(median > 0) || sampleSize < 1 || !/[0-9?]/.test(template)) return null;
  // Unread positions count as 9s: only flag when even the largest possible fill is implausibly small.
  const upperBound = Number(template.replace(/\?/g, '9'));
  if (!Number.isFinite(upperBound) || upperBound <= 0) return null;
  const flagged = upperBound * PLAUSIBILITY_RATIO < median;
  return { flagged, reason: flagged ? 'Much lower than other scores on this machine' : null, median, sampleSize };
}
