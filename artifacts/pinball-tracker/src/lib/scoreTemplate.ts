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

/**
 * One player display's read, merged across every uploaded photo. /api/upload returns one per player
 * display as `playerReads`, and the default one again as `scoreRead` (for older clients).
 */
export interface ScoreRead {
  /** 1–4 from a "1UP"/"PLAYER 1" label or the layout; null when it can't be told. */
  player?: number | null;
  template: string;
  lowConfidence: number[];
  status: 'complete' | 'partial' | 'unreadable';
  possiblyTruncated: boolean;
  truncationReason: string | null;
  /** The leftmost window was dark on a strobing display — it may hide a leading digit. */
  leadingPositionAmbiguous?: boolean;
  /**
   * The close-up re-read of this display disagreed with the whole-photo read on some digit. The
   * close-up's positions were kept; the contested digits are in `lowConfidence`.
   */
  alignmentWarning?: boolean;
  conflicts: ScoreConflict[];
  bestImageIndex: number;
  perImage: string[];
  plausibility: ScorePlausibility | null;
}

/** Non-blocking note for `alignmentWarning`. */
export const ALIGNMENT_WARNING = 'Digits were hard to line up — check each one against the machine.';

/** "May be missing digits" reason for `leadingPositionAmbiguous`. */
export const LEADING_AMBIGUOUS_REASON = 'The first digit position was dark — check the machine for a leading digit.';

/** "Player 2", or "Display 2" (1-based position) when the display carries no player number. */
export function playerLabel(read: Pick<ScoreRead, 'player'>, index: number): string {
  return read.player != null ? `Player ${read.player}` : `Display ${index + 1}`;
}

/**
 * After "Add another photo" re-reads the set, which of the new player reads is the one the user had
 * picked? By player number when the old pick had one; otherwise by position, but only when the
 * number of displays didn't change (a lone display stays itself). null means ask again.
 */
export function matchPlayerRead(prev: ScoreRead[], prevIndex: number | null, next: ScoreRead[]): number | null {
  if (prevIndex == null || !prev[prevIndex] || next.length === 0) return null;
  const player = prev[prevIndex].player;
  if (player != null) {
    const i = next.findIndex(r => r.player === player);
    if (i >= 0) return i;
  }
  return prev.length === next.length ? prevIndex : null;
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

/** A cell where the user's digit and a later photo's reading disagree. The user's digit is kept. */
export interface ScoreDisagreement {
  index: number;
  readDigit: string;
}

/**
 * Carries the user's own entries over to a fresh read (after "Add another photo" re-reads the set).
 *
 * An entry is any position where the working value differs from the read it started from and holds a
 * digit — a filled-in x, or a digit the user corrected. Positions are matched right-aligned (the ones
 * digit is always last), exactly as the server merges photos, so a new read that found an extra
 * leading digit still lines up. For each entry:
 *  - new read has `?` there         → the user's digit fills it
 *  - new read agrees                → nothing to do
 *  - new read has a different digit → the user's digit wins, flagged as a disagreement
 * An entry that falls off the left of a shorter new read is dropped.
 */
export function reconcileUserDigits(
  prevRead: string, prevValue: string, nextRead: string,
): { template: string; disagreements: ScoreDisagreement[] } {
  let template = nextRead;
  const disagreements: ScoreDisagreement[] = [];
  const len = Math.min(prevRead.length, prevValue.length);
  for (let fromRight = 0; fromRight < len; fromRight++) {
    const was = prevRead[prevRead.length - 1 - fromRight];
    const now = prevValue[prevValue.length - 1 - fromRight];
    if (!/[0-9]/.test(now) || now === was) continue;
    const j = nextRead.length - 1 - fromRight;
    if (j < 0) continue;
    const read = nextRead[j];
    if (read === now) continue;
    template = setAt(template, j, now);
    if (read !== '?') disagreements.push({ index: j, readDigit: read });
  }
  disagreements.sort((a, b) => a.index - b.index);
  return { template, disagreements };
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
