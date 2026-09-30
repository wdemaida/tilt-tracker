// Badges — the ad hoc rule vocabulary, as pure functions (feature/badges). No database here:
// lib/badges.ts loads a user's candidate scores and asks these whether a rule badge is earned.
// Modeled on challengeRules.ts; unit-tested in badgeRules.test.ts.
//
// A rule is a small declarative JSON object (badges.rule), never SQL or code. Every condition present
// must hold (AND). The vocabulary:
//   localDate        {from, to} 'YYYY-MM-DD', inclusive — the play date in the VENUE's local time
//                    (venues.timezone, else America/New_York)
//   daysOfWeek       [0..6], 0 = Sunday, venue local
//   localTime        {from, to} 'HH:MM', venue local; from > to wraps midnight (22:00–02:00)
//   postedWithinHours  created_at − played_at must be ≤ N hours. ALWAYS applied when localDate is
//                    set (default 48) — Will: a date badge can't be earned by backdating a score.
//                    Optional otherwise.
//   machine          {machineId, matchMode 'group'|'exact', matchGroup} — matchGroup is the OPDB group,
//                    captured when the rule is saved (normalizeRule's caller fills it); reuses
//                    challengeRules.machineMatches
//   venueId          one venue; or city / state (case-insensitive, the venue's own fields)
//   minScore, scoreType ('casual'|'tournament'), requiresPhoto (photo_url OR photo_thumbnail)
//   count (default 1) + distinct 'none'|'machine'|'venue' — how many qualifying scores are needed
//
// Timestamps: scores.played_at / created_at are naive columns holding UTC (see api-server CLAUDE.md);
// drizzle reads them as UTC instants, which is what these functions expect.
//
// Never in the future (Will, 2026-09-30): EVERY rule — posting window or not — ignores a score whose
// played_at is more than FUTURE_SKEW_MS after its created_at (playedAtClock.playedAfter), the same
// rule challenges apply. The routes refuse new ones; this keeps legacy future-dated rows from earning
// anything. loadRuleScores() applies the same cut in SQL (badgeMetrics.playedNotInFutureSql), and so
// do the score metrics, so live evaluation and the retroactive backfill agree.

import { machineMatches } from './challengeRules.js';
import { FUTURE_SKEW_MS, playedAfter } from './playedAtClock.js';

export const DEFAULT_TZ = 'America/New_York';
export const DEFAULT_POSTED_WITHIN_HOURS = 48;
/** A played_at this far after created_at is still "now" (client clock skew) — shared, see playedAtClock.ts. */
export { FUTURE_SKEW_MS };
export const MAX_RULE_COUNT = 1000;

export interface BadgeRule {
  localDate?: { from: string; to: string };
  daysOfWeek?: number[];
  localTime?: { from: string; to: string };
  postedWithinHours?: number;
  machine?: { machineId: number; matchMode: 'group' | 'exact'; matchGroup: string | null; name?: string };
  venueId?: number;
  city?: string;
  state?: string;
  minScore?: number;
  scoreType?: 'casual' | 'tournament';
  requiresPhoto?: boolean;
  count?: number;
  distinct?: 'none' | 'machine' | 'venue';
}

export interface RuleScore {
  id: number;
  machineId: number;
  opdbId: string | null;
  venueId: number | null;
  venueCity: string | null;
  venueState: string | null;
  venueTimezone: string | null;
  score: number;
  type: string;
  playedAt: Date;
  createdAt: Date;
  hasPhoto: boolean;
}

// ── local time ───────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** A valid IANA zone, else the default. */
export function zoneOrDefault(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    formatterFor(tz);
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall clock of `at` in `tz`: date 'YYYY-MM-DD', minutes since midnight, weekday 0–6. */
export function localParts(at: Date, tz: string | null | undefined): { date: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(formatterFor(zoneOrDefault(tz)).formatToParts(at).map(p => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
  };
}

// ── evaluation ───────────────────────────────────────────────────────────────

const hhmm = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** The grace window in hours that applies to this rule, or null when none does. */
export function graceHours(rule: BadgeRule): number | null {
  if (rule.localDate) return rule.postedWithinHours ?? DEFAULT_POSTED_WITHIN_HOURS;
  return rule.postedWithinHours ?? null;
}

/** Does one score meet every per-score condition of `rule`? `venueTz` defaults to the score's venue zone. */
export function scoreQualifies(rule: BadgeRule, score: RuleScore, venueTz: string | null = score.venueTimezone): boolean {
  if (rule.machine && !machineMatches({ machineId: rule.machine.machineId, matchGroup: rule.machine.matchMode === 'group' ? rule.machine.matchGroup : null }, score)) return false;
  if (rule.venueId != null && score.venueId !== rule.venueId) return false;
  if (rule.city && (score.venueCity ?? '').trim().toLowerCase() !== rule.city.trim().toLowerCase()) return false;
  if (rule.state && (score.venueState ?? '').trim().toLowerCase() !== rule.state.trim().toLowerCase()) return false;
  if (rule.minScore != null && score.score < rule.minScore) return false;
  if (rule.scoreType && score.type !== rule.scoreType) return false;
  if (rule.requiresPhoto && !score.hasPhoto) return false;

  // Every rule: a played time in the future of its posting never counts (see the header).
  if (playedAfter(score.playedAt, score.createdAt)) return false;

  const grace = graceHours(rule);
  if (grace != null && +score.createdAt - +score.playedAt > grace * 3_600_000) return false;

  if (rule.localDate || rule.daysOfWeek || rule.localTime) {
    const local = localParts(score.playedAt, venueTz);
    if (rule.localDate && (local.date < rule.localDate.from || local.date > rule.localDate.to)) return false;
    if (rule.daysOfWeek && !rule.daysOfWeek.includes(local.weekday)) return false;
    if (rule.localTime) {
      const from = hhmm(rule.localTime.from), to = hhmm(rule.localTime.to);
      const inside = from <= to ? local.minutes >= from && local.minutes <= to : local.minutes >= from || local.minutes <= to;
      if (!inside) return false;
    }
  }
  return true;
}

/**
 * Is the rule met by these scores? Qualifying scores are taken in posting order (created_at, then id);
 * with `distinct`, only the first per machine / venue counts (a score with no venue never counts
 * toward distinct venues). `sourceScoreId` is the score that completed the count.
 */
export function ruleSatisfied(rule: BadgeRule, scores: RuleScore[]): { met: boolean; sourceScoreId: number | null; progress: number } {
  const need = rule.count ?? 1;
  const distinct = rule.distinct ?? 'none';
  const seen = new Set<number>();
  let n = 0;
  const ordered = [...scores].sort((a, b) => +a.createdAt - +b.createdAt || a.id - b.id);
  for (const s of ordered) {
    if (!scoreQualifies(rule, s)) continue;
    if (distinct === 'machine') {
      if (seen.has(s.machineId)) continue;
      seen.add(s.machineId);
    } else if (distinct === 'venue') {
      if (s.venueId == null || seen.has(s.venueId)) continue;
      seen.add(s.venueId);
    }
    n++;
    if (n >= need) return { met: true, sourceScoreId: s.id, progress: n };
  }
  return { met: false, sourceScoreId: null, progress: n };
}

// ── validation ───────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === s;
}

const posInt = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= max;

/**
 * Validate an admin-submitted rule and return its canonical form (unknown keys dropped, strings
 * trimmed). `machine.matchGroup` / `name` are NOT trusted from input — the route fills them from the
 * machines table. At least one condition is required, so a rule can't mean "any score at all" by
 * accident (use the scores_posted metric for that).
 */
export function normalizeRule(input: unknown): { rule: BadgeRule } | { errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['rule must be an object'] };
  const r = input as Record<string, any>;
  const out: BadgeRule = {};

  if (r.localDate != null) {
    const { from, to } = r.localDate ?? {};
    if (!validDate(from) || !validDate(to)) errors.push('localDate.from and localDate.to must be YYYY-MM-DD dates');
    else if (from > to) errors.push('localDate.from must not be after localDate.to');
    else out.localDate = { from, to };
  }
  if (r.daysOfWeek != null) {
    const days = r.daysOfWeek;
    if (!Array.isArray(days) || !days.length || !days.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
      errors.push('daysOfWeek must be a non-empty list of 0 (Sunday) – 6');
    } else out.daysOfWeek = [...new Set(days as number[])].sort();
  }
  if (r.localTime != null) {
    const { from, to } = r.localTime ?? {};
    if (typeof from !== 'string' || typeof to !== 'string' || !TIME_RE.test(from) || !TIME_RE.test(to)) errors.push('localTime.from and localTime.to must be HH:MM');
    else out.localTime = { from, to };
  }
  if (r.postedWithinHours != null) {
    if (!posInt(r.postedWithinHours, 24 * 30)) errors.push('postedWithinHours must be 1–720');
    else out.postedWithinHours = r.postedWithinHours;
  }
  if (r.machine != null) {
    const m = r.machine ?? {};
    const mode = m.matchMode ?? 'group';
    if (!posInt(m.machineId)) errors.push('machine.machineId must be a machine id');
    else if (mode !== 'group' && mode !== 'exact') errors.push("machine.matchMode must be 'group' or 'exact'");
    else out.machine = { machineId: m.machineId, matchMode: mode, matchGroup: null };
  }
  if (r.venueId != null) {
    if (!posInt(r.venueId)) errors.push('venueId must be a venue id');
    else out.venueId = r.venueId;
  }
  for (const k of ['city', 'state'] as const) {
    if (r[k] != null && r[k] !== '') {
      if (typeof r[k] !== 'string' || r[k].trim().length > 80 || !r[k].trim()) errors.push(`${k} must be a short text`);
      else out[k] = r[k].trim();
    }
  }
  if (r.minScore != null) {
    if (!posInt(r.minScore)) errors.push('minScore must be a positive whole number');
    else out.minScore = r.minScore;
  }
  if (r.scoreType != null) {
    if (r.scoreType !== 'casual' && r.scoreType !== 'tournament') errors.push("scoreType must be 'casual' or 'tournament'");
    else out.scoreType = r.scoreType;
  }
  if (r.requiresPhoto != null) {
    if (typeof r.requiresPhoto !== 'boolean') errors.push('requiresPhoto must be true or false');
    else if (r.requiresPhoto) out.requiresPhoto = true;
  }
  if (r.count != null) {
    if (!posInt(r.count, MAX_RULE_COUNT)) errors.push(`count must be 1–${MAX_RULE_COUNT}`);
    else if (r.count > 1) out.count = r.count;
  }
  if (r.distinct != null) {
    if (!['none', 'machine', 'venue'].includes(r.distinct)) errors.push("distinct must be 'none', 'machine' or 'venue'");
    else if (r.distinct !== 'none') out.distinct = r.distinct;
  }

  const conditions = ['localDate', 'daysOfWeek', 'localTime', 'postedWithinHours', 'machine', 'venueId', 'city', 'state', 'minScore', 'scoreType', 'requiresPhoto'] as const;
  if (!errors.length && !conditions.some(k => out[k] !== undefined)) errors.push('a rule needs at least one condition');
  return errors.length ? { errors } : { rule: out };
}

// ── description ──────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 'Dec 25, 2026' from '2026-12-25'. */
export function prettyDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

/** A plain-English summary of what earns a rule badge, for the catalog ("Post a score on Dec 25, 2026"). */
export function describeRule(rule: BadgeRule): string {
  const n = rule.count ?? 1;
  const what = rule.distinct === 'machine' ? `${n === 1 ? 'a score' : `scores on ${n} different machines`}`
    : rule.distinct === 'venue' ? `${n === 1 ? 'a score' : `scores at ${n} different venues`}`
      : n === 1 ? 'a score' : `${n} scores`;
  const bits: string[] = [`Post ${what}`];
  if (rule.minScore != null) bits.push(`of at least ${rule.minScore.toLocaleString('en-US')}`);
  if (rule.machine) bits.push(`on ${rule.machine.name ?? 'a specific machine'}${rule.machine.matchMode === 'group' ? ' (any model)' : ''}`);
  if (rule.scoreType === 'tournament') bits.push('in a tournament');
  if (rule.requiresPhoto) bits.push('with a photo');
  if (rule.venueId != null) bits.push('at a specific venue');
  if (rule.city || rule.state) bits.push(`in ${[rule.city, rule.state].filter(Boolean).join(', ')}`);
  if (rule.localDate) {
    bits.push(rule.localDate.from === rule.localDate.to
      ? `on ${prettyDate(rule.localDate.from)}`
      : `between ${prettyDate(rule.localDate.from)} and ${prettyDate(rule.localDate.to)}`);
  }
  if (rule.daysOfWeek) bits.push(`on a ${rule.daysOfWeek.map(d => DAY_NAMES[d]).join(' or ')}`);
  if (rule.localTime) bits.push(`between ${rule.localTime.from} and ${rule.localTime.to}`);
  const grace = graceHours(rule);
  if (grace != null) bits.push(`(posted within ${grace} hours of playing)`);
  return bits.join(' ');
}
