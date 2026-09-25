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

/** Highest player number a display can be labelled with ("1UP".."4UP", "PLAYER 1".."PLAYER 4"). */
export const MAX_PLAYER = 4;

/** One player display in one image, as the model reported it (after sanitizing). */
export interface DisplayRead {
  /** 1–4 from a "1UP"/"PLAYER 1" label or the machine's layout; null when it can't be told. */
  player: number | null;
  template: string;
  /** Indexes into `template` of digits the model read but isn't sure of (e.g. glare). */
  lowConfidence: number[];
  status: ReadStatus;
  possiblyTruncated: boolean;
  truncationReason: string | null;
  /**
   * The leftmost digit window was dark on a strobing segment display: it may be a blank (the score
   * has fewer digits) or a digit the shutter caught unlit. The template treats it as blank — the
   * comma rule can only pin down the *trailing* count — so the UI asks the user to check.
   */
  leadingPositionAmbiguous: boolean;
  /**
   * The crop pass (displayCrops.ts) re-read this display window by window and its digits didn't line
   * up with the whole-photo read. Its positions were kept, the contested digits marked lowConfidence.
   */
  alignmentWarning?: boolean;
  /** Positions the crop pass couldn't settle: "?" in the template, both readings offered. */
  conflicts?: ScoreConflict[];
  /** Index among the image's displays in the model's own order, before player sorting. */
  position?: number;
  // Pass-1 details the crop pass needs; never sent to the client (mergeReads builds fresh objects).
  displayKind?: string;
  /** The digit-window strip, as fractions of the image (0–1). */
  bbox?: BBox | null;
  digitWindows?: number | null;
}

/** A region of an image as fractions of its width/height, top-left origin. */
export interface BBox { x: number; y: number; w: number; h: number }

/** Every player display the model found in one image, in player order (unnumbered ones last). */
export interface ImageRead {
  displays: DisplayRead[];
}

export interface ScoreConflict {
  /** Index into the merged template (most-significant first). */
  index: number;
  /** The distinct digits the images disagreed between, ascending. */
  candidates: string[];
}

/** One display merged across every uploaded photo. */
export interface MergedRead {
  template: string;
  lowConfidence: number[];
  status: ReadStatus;
  possiblyTruncated: boolean;
  truncationReason: string | null;
  leadingPositionAmbiguous: boolean;
  /** See DisplayRead.alignmentWarning — true if any photo's crop re-read disagreed. */
  alignmentWarning: boolean;
  conflicts: ScoreConflict[];
}

/** One player's display merged across every photo — the client gets one of these per player. */
export interface MergedPlayerRead extends MergedRead {
  player: number | null;
  /** That player's template in each image, in image order ('' where the image didn't show it). */
  perImage: string[];
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
  const best = scoreRunFromDisplayText(raw);
  // Leading dark windows ("_") are blank positions left of a right-aligned score, not part of it. A
  // leading "?" is different: a partly lit digit, i.e. a real position. (Whether that blank might
  // really be a strobed-off digit is `displayLeadsWithDark`'s question, not this one's.)
  let body = best.replace(/^[_,]+/, '').replace(/_/g, '?');
  if (!/[0-9]/.test(body)) return '';
  const lastComma = body.lastIndexOf(',');
  if (lastComma >= 0) {
    const tail = body.length - lastComma - 1;
    if (tail < 3) body += '?'.repeat(3 - tail);
  }
  return sanitizeTemplate(body.replace(/,/g, ''));
}

/**
 * The score's run of characters from a display transcription (see templateFromDisplayText), with
 * "." separators normalized to ",". A dark window written as its own token next to the score
 * ("_ 8076 _") is joined onto it first, so it still counts as a position of that display.
 */
function scoreRunFromDisplayText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const isScoreToken = (t: string) => /^[0-9?_,.]+$/.test(t) && /[0-9?]/.test(t);
  const positions = (t: string) => t.replace(/[,.]/g, '').length;
  // Glue all-dark tokens onto the score token they sit next to (never onto other text like "P1").
  // A dark group of exactly three after a score is left alone: the run logic below joins it as a
  // comma group, like any other three-position token.
  const tokens: string[] = [];
  const raws = raw.trim().split(/\s+/);
  for (let i = 0; i < raws.length; i++) {
    const t = raws[i];
    if (/^_+$/.test(t)) {
      const prev = tokens[tokens.length - 1];
      if (prev != null && isScoreToken(prev)) {
        if (t.length !== 3) tokens[tokens.length - 1] = prev + t;
        else tokens.push(t);
        continue;
      }
      const next = raws[i + 1];
      if (next != null && isScoreToken(next)) { raws[i + 1] = t + next; continue; }
    }
    tokens.push(t);
  }

  // Runs of score-like tokens; a token of exactly three positions continues the previous run.
  const runs: string[] = [];
  let current: string | null = null;
  for (const token of tokens) {
    if (current != null && /^_{3}$/.test(token)) { current += `,${token}`; continue; }
    if (!isScoreToken(token)) { if (current != null) runs.push(current); current = null; continue; }
    if (current != null && positions(token) === 3) current += `,${token}`;
    else { if (current != null) runs.push(current); current = token; }
  }
  if (current != null) runs.push(current);

  let best = '';
  for (const r of runs) if (positions(r) > positions(best)) best = r;
  return best.replace(/\./g, ',');
}

/**
 * Whether the transcription shows a dark window to the left of the score's first lit (or partly
 * lit) digit — i.e. the leftmost lit digit isn't in the display's first window.
 */
export function displayLeadsWithDark(raw: unknown): boolean {
  const run = scoreRunFromDisplayText(raw);
  return /^[,]*_/.test(run) && /[0-9]/.test(run);
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

/** A raw player display from the model's tool call. */
export interface RawDisplay {
  player?: unknown; displayKind?: unknown; template?: unknown; displayText?: unknown; lowConfidence?: unknown;
  possiblyTruncated?: unknown; truncationReason?: unknown; leadingPositionAmbiguous?: unknown;
  bbox?: unknown; digitWindows?: unknown;
}

/** Sanitizes one raw player display from the model. */
export function sanitizeDisplayRead(raw: RawDisplay, size?: ImageSize): DisplayRead {
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
  const player = Number(raw.player);
  return {
    player: raw.player != null && Number.isInteger(player) && player >= 1 && player <= MAX_PLAYER ? player : null,
    template,
    lowConfidence: sanitizeLowConfidence(template, mappedLow),
    // Derived from the template rather than trusted from the model, so the two can never disagree.
    status: templateStatus(template),
    possiblyTruncated: raw.possiblyTruncated === true,
    truncationReason: raw.possiblyTruncated === true ? reason : null,
    leadingPositionAmbiguous: leadingAmbiguity(raw, template),
    displayKind: typeof raw.displayKind === 'string' ? raw.displayKind : undefined,
    bbox: sanitizeBBox(raw.bbox, size),
    digitWindows: Number.isInteger(raw.digitWindows) && (raw.digitWindows as number) > 0 ? (raw.digitWindows as number) : null,
  };
}

/** Pixel size of the image the model was shown. */
export interface ImageSize { width: number; height: number }

/**
 * A model-reported bounding box, normalized to fractions of the image and clamped to it. The model
 * reports pixels of the image it was shown when `size` is given (it places boxes far more precisely
 * in pixels of a stated size than in fractions — fractions came back as round guesses like 0.07,
 * 0.63 that missed the display entirely), fractions otherwise. null when it's missing, not numeric,
 * or too small to hold a readable display (a zero box is how the model says "don't know").
 */
export function sanitizeBBox(raw: unknown, size?: ImageSize): BBox | null {
  if (!raw || typeof raw !== 'object') return null;
  let { x, y, w, h } = raw as Record<string, unknown>;
  if (![x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  if (size && size.width > 0 && size.height > 0) {
    x = (x as number) / size.width; w = (w as number) / size.width;
    y = (y as number) / size.height; h = (h as number) / size.height;
  }
  const x0 = Math.min(Math.max(x as number, 0), 1), y0 = Math.min(Math.max(y as number, 0), 1);
  const x1 = Math.min(Math.max((x as number) + (w as number), 0), 1), y1 = Math.min(Math.max((y as number) + (h as number), 0), 1);
  if (x1 - x0 < 0.02 || y1 - y0 < 0.005) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether the leftmost dark window might be a strobed-off digit rather than a blank. Only on a
 * segment/plasma display (DMD and LCD screens don't strobe digit by digit), only when the
 * transcription actually shows a dark window left of the first lit digit, and only when there's
 * evidence the shutter caught the display mid-refresh — an unread position in the read — or the
 * model itself judged the leading position doubtful. A fully lit short score on a wide display is
 * just a short score; flagging every one of those would make the warning noise.
 */
function leadingAmbiguity(raw: RawDisplay, template: string): boolean {
  if (raw.displayKind !== 'segment') return false;
  if (!displayLeadsWithDark(raw.displayText)) return false;
  return raw.leadingPositionAmbiguous === true || template.includes('?');
}

/**
 * Sanitizes one image's list of player displays: drops displays that show no score (blank, or only
 * zeros — a "00" is a ball-in-play or unused player, and a zero score can't be saved anyway), drops
 * all-unread displays when the image has a readable one, de-duplicates player numbers (a second
 * display claiming the same number loses it), and sorts numbered displays first, in player order.
 */
export function sanitizeImageDisplays(raw: unknown, size?: ImageSize): ImageRead {
  const list = Array.isArray(raw) ? raw : [];
  let displays = list
    .filter((d): d is RawDisplay => !!d && typeof d === 'object')
    .map(d => sanitizeDisplayRead(d, size))
    .filter(d => /[1-9?]/.test(d.template));
  if (displays.some(d => /[0-9]/.test(d.template))) displays = displays.filter(d => /[0-9]/.test(d.template));
  // Remember where each display sat in the model's own (reading-order) list before sorting by player
  // number — mergePlayerReads matches unnumbered displays across photos on this, not on sorted order.
  displays = displays.map((d, k) => ({ ...d, position: k }));
  const seen = new Set<number>();
  displays = displays.map(d => {
    if (d.player == null) return d;
    if (seen.has(d.player)) return { ...d, player: null };
    seen.add(d.player);
    return d;
  });
  const numbered = displays.filter(d => d.player != null).sort((a, b) => a.player! - b.player!);
  return { displays: [...numbered, ...displays.filter(d => d.player == null)] };
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
export function mergeReads(reads: DisplayRead[]): MergedRead {
  const usable = reads.filter(r => r.template.length > 0);
  if (usable.length === 0) {
    return {
      template: '', lowConfidence: [], status: 'unreadable',
      possiblyTruncated: reads.some(r => r.possiblyTruncated),
      truncationReason: reads.find(r => r.truncationReason)?.truncationReason ?? null,
      leadingPositionAmbiguous: false,
      alignmentWarning: false,
      conflicts: [],
    };
  }

  const length = Math.max(...usable.map(r => r.template.length));
  const chars: string[] = [];
  const lowConfidence: number[] = [];
  const conflicts: ScoreConflict[] = [];

  for (let index = 0; index < length; index++) {
    const fromRight = length - 1 - index;
    const contributions: Array<{ digit: string; low: boolean }> = [];
    const offered = new Set<string>(); // candidates a crop-pass conflict left at this position
    for (const r of usable) {
      const i = r.template.length - 1 - fromRight;
      if (i < 0) continue;
      const c = r.template[i];
      if (c >= '0' && c <= '9') contributions.push({ digit: c, low: r.lowConfidence.includes(i) });
      for (const cf of r.conflicts ?? []) if (cf.index === i) cf.candidates.forEach(d => offered.add(d));
    }

    const distinct = [...new Set(contributions.map(c => c.digit))].sort();
    if (distinct.length === 0) {
      chars.push('?');
      if (offered.size) conflicts.push({ index, candidates: [...offered].sort() });
    } else if (distinct.length === 1) {
      chars.push(distinct[0]);
      if (contributions.every(c => c.low)) lowConfidence.push(index);
    } else {
      chars.push('?');
      conflicts.push({ index, candidates: [...new Set([...distinct, ...offered])].sort() });
    }
  }

  const template = chars.join('');
  // Truncation and leading ambiguity are judged on the longest read(s): a short photo saying "may be
  // missing digits" — at either end — is answered by another photo that shows them.
  const longest = usable.filter(r => r.template.length === length);
  const truncating = longest.find(r => r.possiblyTruncated);

  return {
    template,
    lowConfidence,
    status: templateStatus(template),
    possiblyTruncated: !!truncating,
    truncationReason: truncating?.truncationReason ?? null,
    leadingPositionAmbiguous: longest.some(r => r.leadingPositionAmbiguous),
    alignmentWarning: usable.some(r => r.alignmentWarning === true),
    conflicts,
  };
}

/**
 * Right-aligned agreement between two templates: how many positions both read as the same digit, and
 * how many they read as different digits.
 */
function templateAgreement(a: string, b: string): { agree: number; disagree: number } {
  let agree = 0, disagree = 0;
  for (let k = 1; k <= Math.min(a.length, b.length); k++) {
    const x = a[a.length - k], y = b[b.length - k];
    if (x === '?' || y === '?') continue;
    if (x === y) agree++; else disagree++;
  }
  return { agree, disagree };
}

/** A display may join a player's group unless both carry player numbers and they differ. */
const playersCompatible = (a: number | null, b: number | null) => a == null || b == null || a === b;

/**
 * Merges every photo's player displays per player, so a 4-player backglass photographed three times
 * yields four merged reads, not one read mashed together from four different scores.
 *
 * Displays are matched across images by, in order:
 *  1. player number (from a "1UP"/"PLAYER 1" label or the layout);
 *  2. position, when an image shows the same number of displays as the reference image (the one with
 *     the most) — each display's place in the model's own list (`position`, kept from before the
 *     player-number sort), which is reading order;
 *  3. the template itself, for a lone unnumbered display (a close-up of one player's display): it
 *     joins the one group it agrees with on at least two digits without contradicting any. Two
 *     equally good groups (identical scores) is ambiguity, not a match.
 * Anything left over becomes its own group. Two different player numbers never merge — on a
 * single-display machine showing "PLAYER 2" in one photo and "PLAYER 3" in another, those are two
 * different scores, and the user is asked which one was theirs.
 *
 * Output is numbered players ascending, then unnumbered groups in the reference image's order.
 */
export function mergePlayerReads(images: ImageRead[]): MergedPlayerRead[] {
  interface Group { player: number | null; position?: number; members: Array<{ image: number; read: DisplayRead }> }
  if (images.every(im => im.displays.length === 0)) return [];

  let ref = 0;
  images.forEach((im, i) => { if (im.displays.length > images[ref].displays.length) ref = i; });
  const groups: Group[] = images[ref].displays.map((d, k) => ({
    player: d.player, position: d.position ?? k, members: [{ image: ref, read: d }],
  }));
  const refCount = groups.length;

  images.forEach((im, i) => {
    if (i === ref) return;
    const ds = im.displays;
    const assigned: Array<Group | undefined> = new Array(ds.length);
    const used = new Set<Group>();
    const take = (j: number, g: Group) => { assigned[j] = g; used.add(g); };

    // 1. Player number.
    ds.forEach((d, j) => {
      if (d.player == null) return;
      const g = groups.find(g => g.player === d.player && !used.has(g));
      if (g) take(j, g);
    });
    // 2. Position, when the display counts line up with the reference image. Matched on each
    //    display's original place in the model's list — the sorted order puts numbered displays
    //    first, so with partial numbering it no longer lines up between photos.
    if (ds.length === refCount) {
      ds.forEach((d, j) => {
        if (assigned[j]) return;
        const pos = d.position ?? j;
        const g = groups.find(g => g.position === pos && !used.has(g));
        if (g && playersCompatible(g.player, d.player)) take(j, g);
      });
    }
    // 3. Template agreement.
    ds.forEach((d, j) => {
      if (assigned[j]) return;
      const scored = groups
        .filter(g => !used.has(g) && playersCompatible(g.player, d.player))
        .map(g => ({ g, ...templateAgreement(mergeReads(g.members.map(m => m.read)).template, d.template) }))
        .filter(s => s.disagree === 0 && s.agree >= 2)
        .sort((a, b) => b.agree - a.agree);
      if (scored.length > 0 && (scored.length === 1 || scored[0].agree > scored[1].agree)) take(j, scored[0].g);
    });

    ds.forEach((d, j) => {
      let g = assigned[j];
      if (!g) { g = { player: d.player, members: [] }; groups.push(g); }
      g.members.push({ image: i, read: d });
      if (g.player == null && d.player != null && !groups.some(o => o.player === d.player)) g.player = d.player;
    });
  });

  const numbered = groups.filter(g => g.player != null).sort((a, b) => a.player! - b.player!);
  return [...numbered, ...groups.filter(g => g.player == null)].map(g => ({
    player: g.player,
    ...mergeReads(g.members.map(m => m.read)),
    perImage: images.map((_, i) => g.members.find(m => m.image === i)?.read.template ?? ''),
  }));
}

/**
 * Which player's read a client that can't ask ("Which player were you?") should get — the top-level
 * `score`/`scoreRead` older clients read. The highest score, reading unread positions as 0s; a longer
 * template wins outright, since it's at least a digit more.
 */
export function defaultPlayerIndex(players: MergedRead[]): number {
  let best = 0;
  const value = (t: string) => Number(t.replace(/\?/g, '0')) || 0;
  players.forEach((p, i) => {
    const b = players[best].template;
    if (p.template.length > b.length || (p.template.length === b.length && value(p.template) > value(b))) best = i;
  });
  return best;
}

/** Default best image: the one with the most known digits across its displays (ties → earliest). */
export function defaultBestImageIndex(reads: ImageRead[]): number {
  const known = (r: ImageRead) => r.displays.reduce((n, d) => n + knownDigitCount(d.template), 0);
  let best = 0;
  reads.forEach((r, i) => {
    if (known(r) > known(reads[best])) best = i;
  });
  return best;
}

// ---------------------------------------------------------------------------
// Crop pass — window-by-window re-read of each display (see displayCrops.ts)
// ---------------------------------------------------------------------------

/** More windows than any real score display has: the crop read counted glass or bezel as windows. */
export const MAX_DISPLAY_WINDOWS = 10;

/**
 * Whether an image's reads are worth a crop pass: more than one score display (players' digits are
 * small and easy to misplace), or a segment/plasma display with unread or leading-dark positions.
 * A lone complete DMD/LCD read — the common case — skips it.
 */
export function needsCropPass(image: ImageRead): boolean {
  const withBox = image.displays.filter(d => d.bbox);
  if (withBox.length === 0) return false;
  if (image.displays.length > 1) return true;
  return withBox.some(d => d.displayKind === 'segment' && (d.template.includes('?') || d.leadingPositionAmbiguous));
}

/** One display's window-by-window transcription from the crop pass. */
export interface WindowRead {
  windowCount: unknown;
  windows: unknown;
}

/**
 * The window list as a transcription string ("_8076_"): a digit, "_" dark, "?" partly lit, "," a
 * separator. null when any entry isn't one of those.
 */
export function windowsToText(windows: unknown): string | null {
  if (!Array.isArray(windows)) return null;
  let out = '';
  for (const w of windows) {
    if (typeof w !== 'string') return null;
    if (/^[0-9]$/.test(w) || w === ',') out += w;
    else if (w === '_' || w === 'dark') out += '_';
    else if (w === '?' || w === 'partly_lit') out += '?';
    else return null;
  }
  return out;
}

/** The known digits of a template, in order ("8807?0" → "88070"). */
const knownSequence = (t: string) => t.replace(/\?/g, '');

/** Template indexes of the known digits, in order ("8807?0" → [0,1,2,3,5]). */
const digitIndexes = (t: string) => [...t].flatMap((c, i) => (c === '?' ? [] : [i]));

/**
 * Folds a crop-pass window read into a whole-photo (pass 1) read. Returns pass 1 unchanged when the
 * crop read can't be trusted:
 *  - pass 1 is a complete non-segment read (DMD/LCD) — nothing for a window re-read to fix;
 *  - its list isn't a clean window transcription, has no digit at all, or knows two or more fewer
 *    digits than pass 1 (the crop missed the display);
 *  - it counts more than MAX_DISPLAY_WINDOWS windows, more than one window off pass 1's own count, or
 *    disagrees with its own stated windowCount — the signature of dark glass or bezel beyond the last
 *    window being counted as windows, which turns "7205???" into "7205??????";
 *  - most of the digits both reads have disagree (right-aligned) — the crop is of a different
 *    display, or hallucinated: "123450" vs a neighbour's "987600", or "8807?" vs "880700".
 * Otherwise, comparing the two reads' known digits as sequences:
 *  - same sequence → the crop only moved dark windows ("88070?" → "8807?0"): its positions win.
 *  - the crop has exactly one extra digit, the rest in order ("8807?" → "8807?0") → its positions
 *    win; the extra digit is marked lowConfidence and the display flagged `alignmentWarning`.
 *  - the crop has exactly one digit fewer, the rest in order (it judged one partly lit) → its
 *    positions win, flagged `alignmentWarning`.
 *  - anything else → the crop's positions, but every position where the two disagree (right-aligned)
 *    becomes "?" with a conflict offering both digits — the picker the UI already shows for photos
 *    that disagree. Also `alignmentWarning`. Never a silent replacement of a digit pass 1 read.
 * The comma rule and leading-dark logic apply to the crop exactly as to pass 1.
 */
export function reconcileWindowRead(pass1: DisplayRead, crop: WindowRead): DisplayRead {
  if (pass1.displayKind !== 'segment' && !pass1.template.includes('?')) return pass1;
  const text = windowsToText(crop.windows);
  if (text == null) return pass1;
  const count = text.replace(/,/g, '').length;
  if (count === 0 || count > MAX_DISPLAY_WINDOWS) return pass1;
  if (pass1.digitWindows != null && Math.abs(count - pass1.digitWindows) > 1) return pass1;
  if (Number.isInteger(crop.windowCount) && crop.windowCount !== count) return pass1;
  let template = templateFromDisplayText(text);
  if (!/[0-9]/.test(template)) return pass1;
  // A crop that sees clearly reads at least what the whole photo did; one that lost two or more
  // digits was cut from the wrong place (a box off by a display-height catches only the edge of the
  // digits). One fewer is allowed — deciding a pass-1 digit was only partly lit is the crop's job.
  if (knownDigitCount(template) < knownDigitCount(pass1.template) - 1) return pass1;

  // Right-aligned comparison of the positions where both reads have a digit.
  const disagree: Array<{ i: number; a: string; b: string }> = [];
  let agreeCount = 0;
  for (let k = 1; k <= Math.min(template.length, pass1.template.length); k++) {
    const i = template.length - k, j = pass1.template.length - k;
    const a = template[i], b = pass1.template[j];
    if (a === '?' || b === '?') continue;
    if (a !== b) disagree.push({ i, a, b }); else agreeCount++;
  }

  const seqCrop = knownSequence(template), seqPass1 = knownSequence(pass1.template);
  const cropIdx = digitIndexes(template), pass1Idx = digitIndexes(pass1.template);
  let lowConfidence: number[] = [];
  const conflicts: ScoreConflict[] = [];
  let alignmentWarning = false;

  if (seqCrop === seqPass1) {
    // Relocation only: carry pass 1's unsure digits across by their order among the known digits.
    lowConfidence = pass1Idx.flatMap((j, n) => (pass1.lowConfidence.includes(j) ? [cropIdx[n]] : []));
  } else if (seqCrop.length === seqPass1.length + 1 && extraDigit(seqPass1, seqCrop) != null) {
    lowConfidence = [cropIdx[extraDigit(seqPass1, seqCrop)!]];
    alignmentWarning = true;
  } else if (seqPass1.length === seqCrop.length + 1 && extraDigit(seqCrop, seqPass1) != null) {
    // The crop saw one pass-1 digit as only partly lit ("?"): its positions win, flagged.
    alignmentWarning = true;
  } else {
    if (disagree.length > agreeCount) return pass1;
    for (const { i, a, b } of disagree) {
      template = template.slice(0, i) + '?' + template.slice(i + 1);
      conflicts.push({ index: i, candidates: [a, b].sort() });
    }
    conflicts.sort((x, y) => x.index - y.index);
    alignmentWarning = true;
    if (!/[0-9]/.test(template)) return pass1;
  }

  const truncated = pass1.possiblyTruncated && template.length <= pass1.template.length;
  return {
    ...pass1,
    template,
    lowConfidence: sanitizeLowConfidence(template, lowConfidence),
    status: templateStatus(template),
    // Pass 1's "may have more digits" is answered once the crop counted more positions than it read.
    possiblyTruncated: truncated,
    truncationReason: truncated ? pass1.truncationReason : null,
    leadingPositionAmbiguous: pass1.displayKind === 'segment' && displayLeadsWithDark(text) && template.includes('?'),
    alignmentWarning,
    conflicts,
  };
}

/**
 * When `longer` is `shorter` with exactly one digit inserted, the index (in `longer`) of that digit —
 * the first place they diverge. null when `longer` isn't one insertion away.
 */
function extraDigit(shorter: string, longer: string): number | null {
  let n = 0;
  while (n < shorter.length && shorter[n] === longer[n]) n++;
  return shorter.slice(n) === longer.slice(n + 1) ? n : null;
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
