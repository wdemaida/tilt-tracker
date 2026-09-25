// Pure helpers for turning what the model read off a score display into something the app can use.
//
// A "template" is the score written most-significant digit first, digits plus `?` for any position
// that exists but couldn't be read — "72052??" for a Black Knight 2000 display caught mid-refresh.
// Old multiplexed 7-segment / gas-plasma displays light one digit (or one bank) at a time, so a fast
// phone shutter routinely catches some positions dark. We never guess those digits; the user fills
// them in from the machine. See ScoreDigitInput.tsx on the frontend.
//
// No I/O in this file — it's unit-tested directly (see the report for the tsx test script).

export type ReadStatus = 'complete' | 'partial' | 'unreadable';

/** One image's read, as the model reported it (after sanitizing). */
export interface ImageRead {
  template: string;
  /** Indexes into `template` of digits the model read but isn't sure of (e.g. half-lit). */
  lowConfidence: number[];
  status: ReadStatus;
  possiblyTruncated: boolean;
  truncationReason: string | null;
}

export interface ScoreConflict {
  /** Index into the merged template (most-significant first). */
  index: number;
  /** The distinct digits the images disagreed between, ascending. */
  candidates: string[];
}

/** The merged read across every uploaded photo — this is what goes to the client as `scoreRead`. */
export interface MergedRead {
  template: string;
  lowConfidence: number[];
  status: ReadStatus;
  possiblyTruncated: boolean;
  truncationReason: string | null;
  conflicts: ScoreConflict[];
}

/**
 * Normalizes a model-produced template: strips separators (commas, dots, spaces, apostrophes), maps
 * any other placeholder the model might use (x, _, -, *) to `?`, and drops anything else. Leading
 * zeros are dropped — a display never lights a leading zero, so one can only be a misread.
 */
export function sanitizeTemplate(raw: unknown): string {
  return sanitizeWithIndexMap(raw).template;
}

/**
 * sanitizeTemplate plus a map from each *raw* character index to its index in the clean template
 * (or -1 if dropped), so the model's lowConfidence indexes survive a stray comma in its template.
 */
export function sanitizeWithIndexMap(raw: unknown): { template: string; indexMap: number[] } {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { template: '', indexMap: [] };
  const s = String(raw);
  const out: string[] = [];
  const indexMap: number[] = [];
  for (const ch of s) {
    const c = /[xX_*\-]/.test(ch) ? '?' : ch;
    if (/[0-9?]/.test(c)) { indexMap.push(out.length); out.push(c); }
    else indexMap.push(-1);
  }
  let lead = 0;
  while (lead < out.length - 1 && out[lead] === '0') lead++;
  return {
    template: out.slice(lead).join(''),
    indexMap: indexMap.map(i => (i < lead ? -1 : i - lead)),
  };
}

/**
 * Derives a template from the model's literal transcription of the display ("7,205,?__"), applying
 * the one counting rule models get wrong most: commas sit every three digits from the right, so the
 * group after the last comma always has exactly three positions. A partly lit digit followed by
 * darkness after "7,205," is therefore "7205???", however many dark windows the model thought it saw.
 *
 * Only the score itself is used. The transcription can carry other text from the display ("EXTRA
 * BALL", "P1", "BALL 2") — every whitespace-separated token containing anything but digits,
 * separators, "?" and "_" is dropped, and of what's left the longest run is taken (consecutive
 * three-position tokens are joined first, for a model that wrote "7 205 2__" with spaces as
 * separators). Only "?" (partly lit) and "_" (dark) are read as unread positions; letters never are.
 * Returns '' when no score-like token has a digit.
 */
export function templateFromDisplayText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const isScoreToken = (t: string) => /^[0-9?_,.]+$/.test(t) && /[0-9?]/.test(t);
  const positions = (t: string) => t.replace(/[,.]/g, '').length;

  // Runs of score-like tokens; a token of exactly three positions continues the previous run.
  const runs: string[] = [];
  let current: string | null = null;
  for (const token of raw.trim().split(/\s+/)) {
    if (!isScoreToken(token)) { if (current != null) runs.push(current); current = null; continue; }
    if (current != null && positions(token) === 3) current += `,${token}`;
    else { if (current != null) runs.push(current); current = token; }
  }
  if (current != null) runs.push(current);

  let best = '';
  for (const r of runs) if (positions(r) > positions(best)) best = r;
  // Leading dark windows ("_") are blank positions left of a right-aligned score, not part of it. A
  // leading "?" is different: a partly lit digit, i.e. a real position.
  let body = best.replace(/\./g, ',').replace(/^[_,]+/, '').replace(/_/g, '?');
  if (!/[0-9]/.test(body)) return '';
  const lastComma = body.lastIndexOf(',');
  if (lastComma >= 0) {
    const tail = body.length - lastComma - 1;
    if (tail < 3) body += '?'.repeat(3 - tail);
  }
  return sanitizeTemplate(body.replace(/,/g, ''));
}

/**
 * Whether the transcription-derived template may replace the model's own. It may only *refine* it:
 * never disagree with a digit the model read, and never shorten it. Concretely, left-aligned (both
 * start at the most-significant digit): wherever both have a digit they match, and any positions the
 * transcription adds beyond the model's template are unread (`?`) — i.e. the comma rule completing
 * the final group. Anything else means the transcription picked up something that isn't the score.
 */
export function displayRefinesModel(fromDisplay: string, fromModel: string): boolean {
  if (!fromDisplay) return false;
  if (!fromModel) return true;
  if (fromDisplay.length < fromModel.length) return false;
  if (/[0-9]/.test(fromDisplay.slice(fromModel.length))) return false;
  for (let i = 0; i < fromModel.length; i++) {
    const a = fromDisplay[i], b = fromModel[i];
    if (a !== '?' && b !== '?' && a !== b) return false;
  }
  return true;
}

/** Sanitizes one raw per-image read from the model. */
export function sanitizeImageRead(raw: {
  template?: unknown; displayText?: unknown; lowConfidence?: unknown; possiblyTruncated?: unknown; truncationReason?: unknown;
}): ImageRead {
  const fromModel = sanitizeWithIndexMap(raw.template);
  const fromDisplay = templateFromDisplayText(raw.displayText);
  // The literal transcription wins only when it refines the template (see displayRefinesModel): it's
  // the model's direct reading, so a partly lit digit it wrote as "?" there isn't "improved" into a
  // guess, and the comma rule fixes the position count.
  const template = displayRefinesModel(fromDisplay, fromModel.template) ? fromDisplay : fromModel.template;
  // lowConfidence indexes refer to the model's template. A refining transcription only ever agrees
  // with it position-for-position from the left and adds unread positions on the right, so the
  // left-based index map stays correct; sanitizeLowConfidence then keeps only indexes that still
  // hold a digit (a position the transcription turned into "?" is no longer "a digit, unsure").
  const indexMap = fromModel.indexMap;
  const mappedLow = Array.isArray(raw.lowConfidence)
    ? raw.lowConfidence.map(v => (Number.isInteger(Number(v)) ? indexMap[Number(v)] ?? -1 : -1))
    : [];
  const reason = typeof raw.truncationReason === 'string' && raw.truncationReason.trim() ? raw.truncationReason.trim() : null;
  return {
    template,
    lowConfidence: sanitizeLowConfidence(template, mappedLow),
    // Derived from the template rather than trusted from the model, so the two can never disagree.
    status: templateStatus(template),
    possiblyTruncated: raw.possiblyTruncated === true,
    truncationReason: raw.possiblyTruncated === true ? reason : null,
  };
}

export function templateStatus(template: string): ReadStatus {
  if (!/[0-9]/.test(template)) return 'unreadable';
  return template.includes('?') ? 'partial' : 'complete';
}

/** The numeric score, but only when every position is known — otherwise null. */
export function templateToScore(template: string): number | null {
  if (!/^\d+$/.test(template)) return null;
  const n = Number(template);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function knownDigitCount(template: string): number {
  return (template.match(/[0-9]/g) ?? []).length;
}

/** Keeps only in-range, integer, de-duplicated indexes that point at an actual digit. */
export function sanitizeLowConfidence(template: string, raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) {
    const i = Number(v);
    if (Number.isInteger(i) && i >= 0 && i < template.length && /[0-9]/.test(template[i])) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Merges several photos of the same display into one template.
 *
 * Templates are right-aligned (the ones digit is always the rightmost position on a pinball display),
 * and the longest one sets the length. At each position:
 *  - no image has a digit          → `?`
 *  - every image with a digit agrees → that digit
 *  - images disagree               → `?`, plus a conflict listing the candidates for the UI to offer
 * A merged digit is low-confidence only when every image that contributed it marked it so — a second,
 * confident read of the same digit is exactly what a second photo is for.
 */
export function mergeReads(reads: ImageRead[]): MergedRead {
  const usable = reads.filter(r => r.template.length > 0);
  if (usable.length === 0) {
    return { template: '', lowConfidence: [], status: 'unreadable', possiblyTruncated: reads.some(r => r.possiblyTruncated), truncationReason: reads.find(r => r.truncationReason)?.truncationReason ?? null, conflicts: [] };
  }

  const length = Math.max(...usable.map(r => r.template.length));
  const chars: string[] = [];
  const lowConfidence: number[] = [];
  const conflicts: ScoreConflict[] = [];

  for (let index = 0; index < length; index++) {
    const fromRight = length - 1 - index;
    const contributions: Array<{ digit: string; low: boolean }> = [];
    for (const r of usable) {
      const i = r.template.length - 1 - fromRight;
      if (i < 0) continue;
      const c = r.template[i];
      if (c >= '0' && c <= '9') contributions.push({ digit: c, low: r.lowConfidence.includes(i) });
    }

    const distinct = [...new Set(contributions.map(c => c.digit))].sort();
    if (distinct.length === 0) {
      chars.push('?');
    } else if (distinct.length === 1) {
      chars.push(distinct[0]);
      if (contributions.every(c => c.low)) lowConfidence.push(index);
    } else {
      chars.push('?');
      conflicts.push({ index, candidates: distinct });
    }
  }

  const template = chars.join('');
  // Truncation is judged on the longest read(s): a short photo saying "may be missing digits" is
  // answered by another photo that shows them.
  const longest = usable.filter(r => r.template.length === length);
  const truncating = longest.find(r => r.possiblyTruncated);

  return {
    template,
    lowConfidence,
    status: templateStatus(template),
    possiblyTruncated: !!truncating,
    truncationReason: truncating?.truncationReason ?? null,
    conflicts,
  };
}

/** Default best image: the one with the most known digits (ties → earliest). */
export function defaultBestImageIndex(reads: ImageRead[]): number {
  let best = 0;
  reads.forEach((r, i) => {
    if (knownDigitCount(r.template) > knownDigitCount(reads[best].template)) best = i;
  });
  return best;
}

// ---------------------------------------------------------------------------
// Plausibility — "this score may be missing digits"
// ---------------------------------------------------------------------------

/** A read below 1/PLAUSIBILITY_RATIO of the machine's median recorded score gets flagged. */
export const PLAUSIBILITY_RATIO = 50;

export interface Plausibility {
  flagged: boolean;
  reason: string | null;
  median: number;
  sampleSize: number;
}

/**
 * Compares a (possibly partial) read against a machine's median recorded score. Unread positions are
 * taken as 9s, so the check only fires when even the *largest* number the template could turn out
 * to be is implausibly small — a partial read is never flagged just for having x's in it.
 */
export function checkPlausibility(template: string, median: number | null, sampleSize: number): Plausibility | null {
  if (median == null || !(median > 0) || sampleSize < 1 || !/[0-9?]/.test(template)) return null;
  const upperBound = Number(template.replace(/\?/g, '9'));
  if (!Number.isFinite(upperBound) || upperBound <= 0) return null;
  const flagged = upperBound * PLAUSIBILITY_RATIO < median;
  return {
    flagged,
    reason: flagged ? 'Much lower than other scores on this machine' : null,
    median,
    sampleSize,
  };
}

// ---------------------------------------------------------------------------
// Score input validation (shared by every route that accepts a score)
// ---------------------------------------------------------------------------

/**
 * Accepts only a safe positive integer, as a JSON number or a string of digits. Anything else —
 * decimals, negatives, exponent notation, "7,205,200", a template with x's still in it — is null,
 * and callers answer 400 `invalid_score`.
 */
export function parseScore(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) n = Number(value);
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
