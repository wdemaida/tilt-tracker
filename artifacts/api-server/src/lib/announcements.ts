import { createHash, randomUUID } from 'node:crypto';
import { db, users, notifications, activityEvents } from '@workspace/db';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { logActivity, type ActivityInput } from './activity.js';
import { raiseNotificationsBulk, type Executor } from './notify.js';

// Admin announcements (feature/admin-announcements, 2026-10-03): an admin sends a short plain-text
// notice — title, body, optional in-app link — to every active user or to picked users. Each
// recipient gets one `announcement` row in `notifications` (no new table, no migration); the durable
// record is the `admin.announcement_sent` activity event (admin tier — kept forever by default).
//
// SECURITY
// - Text is plain: normalised here (NFC, control and bidi-override characters stripped) and rendered
//   by React as text — never as HTML or markdown.
// - The link is an IN-APP PATH only (validateInternalPath): one leading "/", no "//", no "\", no
//   whitespace or control characters (raw or percent-encoded), no scheme, nothing under /api, and the
//   first segment must be a real app route. `{username}` is the only placeholder, substituted per
//   recipient. The frontend re-checks with the same rule before linking (lib/internalPath.ts).
// - Disabled users never receive one: recipients are `disabled_at IS NULL`, re-checked in the send
//   transaction, and an explicitly picked disabled user is reported as skipped.
//
// The pure parts (normalise, validate, audience, recipients, payloads) are unit-tested in
// announcements.test.ts; the DB parts are thin.

export const TITLE_MAX = 80;
export const BODY_MAX = 500;
export const LINK_MAX = 200;
/** "Pick users" audience: at most this many ids per send. */
export const MAX_PICKED = 200;
/** Same title + body + audience again within this window is refused unless `allowDuplicate`. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
/** Sends per admin per hour (in-process limiter, routes/adminAnnouncements.ts). */
export const SENDS_PER_HOUR = 10;
export const SAMPLE_SIZE = 10;
/** First N recipient ids kept in the activity event (sanitizePayload caps arrays at 50 anyway). */
const EVENT_USER_IDS = 50;

/** The first path segment a link may start with — every one is a route in pinball-tracker App.tsx. */
export const LINK_ROOTS = [
  '', // "/" itself (Home), optionally with ?query or #hash
  'users', 'venues', 'machines', 'crew', 'challenges', 'badges', 'stats', 'add', 'welcome', 'notifications',
] as const;

export const USERNAME_PLACEHOLDER = '{username}';

// ── text ─────────────────────────────────────────────────────────────────────

// C0 controls except \n (\t is turned into a space first), DEL, C1 controls, and the Unicode
// bidi/format characters that can visually reorder or hide text (LRE…RLO, LRI…PDI, LRM/RLM/ALM,
// zero-width chars, BOM).
const STRIP = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩؜﻿]/g;

/** Body text: NFC, CRLF → LF, tabs → space, control/bidi chars stripped, trailing spaces per line trimmed, 3+ newlines → 2. */
export function normalizeBody(s: string): string {
  return s.normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(STRIP, '')
    .split('\n').map(l => l.replace(/\s+$/u, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Title text: like the body, but one line — any run of whitespace (newlines included) becomes one space. */
export function normalizeTitle(s: string): string {
  return s.normalize('NFC').replace(/\s+/gu, ' ').replace(STRIP, '').replace(/\s+/gu, ' ').trim();
}

// ── link ─────────────────────────────────────────────────────────────────────

export type LinkResult = { ok: true; value: string | null } | { ok: false; error: string };

const DUMMY_ORIGIN = 'https://tilttrack.invalid';

/**
 * An optional in-app path. Empty/null/undefined → null (no link). Anything that could leave the app
 * — `//host`, `/\host`, `javascript:`, `https://…`, a tab or newline browsers strip, an encoded slash
 * or backslash — is refused. `{username}` may appear (substituted per recipient); no other braces.
 */
export function validateInternalPath(input: unknown): LinkResult {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: 'The link must be text' };
  const link = input.trim();
  if (!link) return { ok: true, value: null };
  if (link.length > LINK_MAX) return { ok: false, error: `The link can be at most ${LINK_MAX} characters` };
  // Any whitespace or control character — browsers silently drop tabs/newlines inside URLs, which is
  // how "/\t/evil.example" becomes "//evil.example".
  if (/[\s\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/u.test(link)) {
    return { ok: false, error: 'The link can’t contain spaces or control characters' };
  }
  if (link[0] !== '/') return { ok: false, error: 'The link must be a path inside TiltTrack, starting with /' };
  if (link[1] === '/') return { ok: false, error: 'The link can’t start with //' };
  if (link.includes('\\')) return { ok: false, error: 'The link can’t contain \\' };
  // Encoded slash, backslash, dot-dot-ish tricks or controls: refuse outright rather than reason about decoding.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f|2e)/i.test(link)) return { ok: false, error: 'The link contains an encoded character that isn’t allowed' };
  try { decodeURIComponent(link); } catch { return { ok: false, error: 'The link has a malformed % escape' }; }
  // Braces only as the {username} placeholder.
  if (/[{}]/.test(link.split(USERNAME_PLACEHOLDER).join(''))) return { ok: false, error: 'The only placeholder allowed is {username}' };
  // Path segments "." / ".." would let a link climb out of an allowed root.
  const pathOnly = link.split(/[?#]/)[0];
  if (pathOnly.split('/').some(seg => seg === '.' || seg === '..')) return { ok: false, error: 'The link can’t contain . or .. segments' };

  const root = pathOnly.split('/')[1] ?? '';
  if (root.toLowerCase() === 'api') return { ok: false, error: 'The link can’t point at the API' };
  if (!(LINK_ROOTS as readonly string[]).includes(root)) {
    return { ok: false, error: `The link must start with one of: ${LINK_ROOTS.map(r => `/${r}`).join(', ')}` };
  }
  // Belt and braces: it must resolve to the same origin, whatever the placeholder becomes.
  try {
    const url = new URL(substituteLink(link, 'someone'), DUMMY_ORIGIN);
    if (url.origin !== DUMMY_ORIGIN) return { ok: false, error: 'The link must stay inside TiltTrack' };
  } catch {
    return { ok: false, error: 'The link isn’t a valid path' };
  }
  return { ok: true, value: link };
}

/** The link for one recipient: `{username}` → their (URL-encoded) username. */
export function substituteLink(link: string, username: string): string {
  return link.split(USERNAME_PLACEHOLDER).join(encodeURIComponent(username));
}

// ── whole announcement ───────────────────────────────────────────────────────

export interface AnnouncementText { title: string; body: string; link: string | null }

export type NormalizeResult =
  | { ok: true; value: AnnouncementText }
  | { ok: false; errors: Partial<Record<'title' | 'body' | 'link', string>> };

export function normalizeAnnouncement(input: { title?: unknown; body?: unknown; link?: unknown }): NormalizeResult {
  const errors: Partial<Record<'title' | 'body' | 'link', string>> = {};
  const title = typeof input.title === 'string' ? normalizeTitle(input.title) : '';
  const body = typeof input.body === 'string' ? normalizeBody(input.body) : '';
  if (!title) errors.title = 'A title is required';
  else if (title.length > TITLE_MAX) errors.title = `The title can be at most ${TITLE_MAX} characters`;
  if (!body) errors.body = 'A message is required';
  else if (body.length > BODY_MAX) errors.body = `The message can be at most ${BODY_MAX} characters`;
  const link = validateInternalPath(input.link);
  if (!link.ok) errors.link = link.error;
  if (Object.keys(errors).length || !link.ok) return { ok: false, errors };
  return { ok: true, value: { title, body, link: link.value } };
}

// ── audience ─────────────────────────────────────────────────────────────────

export type Audience = { audience: 'all' } | { audience: 'users'; userIds: number[] };
export type AudienceResult = { ok: true; value: Audience } | { ok: false; code: string; error: string };

/** `audience: 'all'`, or `audience: 'users'` with 1–MAX_PICKED positive integer ids (deduped, order kept). */
export function parseAudience(input: { audience?: unknown; userIds?: unknown }): AudienceResult {
  if (input.audience === 'all') return { ok: true, value: { audience: 'all' } };
  if (input.audience !== 'users') return { ok: false, code: 'invalid_audience', error: 'Pick an audience: all or users' };
  if (!Array.isArray(input.userIds)) return { ok: false, code: 'invalid_audience', error: 'userIds must be a list' };
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const v of input.userIds) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, code: 'invalid_audience', error: 'userIds must be user ids' };
    if (!seen.has(n)) { seen.add(n); ids.push(n); }
  }
  if (!ids.length) return { ok: false, code: 'invalid_audience', error: 'Pick at least one user' };
  if (ids.length > MAX_PICKED) return { ok: false, code: 'too_many_recipients', error: `Pick at most ${MAX_PICKED} users (or send to everyone)` };
  return { ok: true, value: { audience: 'users', userIds: ids } };
}

/** A stable key for "the same audience" (duplicate detection): 'all', or a hash of the sorted ids. */
export function audienceKey(a: Audience): string {
  if (a.audience === 'all') return 'all';
  const sorted = [...a.userIds].sort((x, y) => x - y).join(',');
  return `users:${createHash('sha256').update(sorted).digest('hex').slice(0, 16)}`;
}

export interface UserRow { id: number; username: string; displayName: string; disabledAt: Date | string | null }
export interface UserRef { id: number; username: string; displayName: string }
export interface Skipped { id: number; username: string | null; reason: 'disabled' | 'unknown' }

/**
 * Who receives it, from the user rows loaded for this audience. Disabled users are never recipients —
 * for 'all' they're dropped silently, for picked users they're reported in `skipped` (as are ids that
 * don't exist). Pure — unit-tested.
 */
export function selectRecipients(audience: Audience, rows: UserRow[]): { recipients: UserRef[]; skipped: Skipped[] } {
  const ref = (r: UserRow): UserRef => ({ id: r.id, username: r.username, displayName: r.displayName });
  if (audience.audience === 'all') {
    return { recipients: rows.filter(r => r.disabledAt == null).sort((a, b) => a.id - b.id).map(ref), skipped: [] };
  }
  const byId = new Map(rows.map(r => [r.id, r]));
  const recipients: UserRef[] = [];
  const skipped: Skipped[] = [];
  for (const id of audience.userIds) {
    const r = byId.get(id);
    if (!r) skipped.push({ id, username: null, reason: 'unknown' });
    else if (r.disabledAt != null) skipped.push({ id, username: r.username, reason: 'disabled' });
    else recipients.push(ref(r));
  }
  return { recipients, skipped };
}

/** One notification per recipient. Pure — unit-tested. */
export function buildNotificationItems(announcementId: string, text: AnnouncementText, recipients: UserRef[]) {
  return recipients.map(r => ({
    userId: r.id,
    payload: {
      announcementId,
      title: text.title,
      body: text.body,
      link: text.link ? substituteLink(text.link, r.username) : null,
      from: 'TiltTrack',
    } as Record<string, unknown>,
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isAnnouncementId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
/** The client's idempotency key: 8–64 chars of [A-Za-z0-9_-]; anything else → null (no key). */
export function parseRequestId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

// ── DB ───────────────────────────────────────────────────────────────────────

/** Load the user rows for an audience (all users for 'all', the picked ids otherwise) and select recipients. */
export async function resolveRecipients(audience: Audience, ex: Executor = db) {
  const cols = { id: users.id, username: users.username, displayName: users.displayName, disabledAt: users.disabledAt };
  const rows = audience.audience === 'all'
    ? await ex.select(cols).from(users).where(isNull(users.disabledAt))
    : await ex.select(cols).from(users).where(inArray(users.id, audience.userIds));
  return selectRecipients(audience, rows);
}

export interface DuplicateOf { announcementId: string; at: string; reason: 'request' | 'recent' }

/**
 * A previous send this one repeats: the same client requestId (a double submit — always refused), or
 * the same title + body + audience within DUPLICATE_WINDOW_MS (refused unless allowDuplicate).
 */
export async function findDuplicate(
  q: { requestId: string | null; title: string; body: string; audienceKey: string },
  ex: Executor = db,
): Promise<DuplicateOf | null> {
  const base = eq(activityEvents.type, 'admin.announcement_sent');
  if (q.requestId) {
    const [hit] = await ex.select({ id: activityEvents.targetId, at: activityEvents.createdAt }).from(activityEvents)
      .where(and(base, sql`${activityEvents.payload} ->> 'requestId' = ${q.requestId}`))
      .orderBy(desc(activityEvents.id)).limit(1);
    if (hit?.id) return { announcementId: hit.id, at: new Date(hit.at).toISOString(), reason: 'request' };
  }
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const [recent] = await ex.select({ id: activityEvents.targetId, at: activityEvents.createdAt }).from(activityEvents)
    .where(and(
      base,
      gte(activityEvents.createdAt, since),
      sql`${activityEvents.payload} ->> 'title' = ${q.title}`,
      sql`${activityEvents.payload} ->> 'body' = ${q.body}`,
      sql`${activityEvents.payload} ->> 'audienceKey' = ${q.audienceKey}`,
    ))
    .orderBy(desc(activityEvents.id)).limit(1);
  return recent?.id ? { announcementId: recent.id, at: new Date(recent.at).toISOString(), reason: 'recent' } : null;
}

export type SendOutcome =
  | { ok: true; announcementId: string; sent: number; skipped: Skipped[] }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Send it: one transaction that (1) serialises this admin's sends (advisory lock — a double submit
 * can't slip between the duplicate check and the insert), (2) re-resolves the recipients and refuses
 * if the count isn't the one the admin confirmed, (3) refuses a duplicate, (4) raises the
 * notifications in bulk and (5) logs admin.announcement_sent. Any failure rolls back everything.
 */
export async function sendAnnouncement(
  adminId: number,
  input: { text: AnnouncementText; audience: Audience; confirmCount: number; requestId: string | null; allowDuplicate: boolean },
  meta: Pick<ActivityInput, 'actorUserId' | 'ip' | 'userAgent'>,
): Promise<SendOutcome> {
  const key = audienceKey(input.audience);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin_announcement'), ${adminId}::int)`);
    const { recipients, skipped } = await resolveRecipients(input.audience, tx);
    if (!recipients.length) {
      return { ok: false as const, status: 400, body: { error: 'Nobody would receive this — every picked user is disabled or unknown', code: 'no_recipients', skipped } };
    }
    if (recipients.length !== input.confirmCount) {
      return {
        ok: false as const, status: 409,
        body: { error: `The audience changed: it’s ${recipients.length} now, not ${input.confirmCount}. Review and send again.`, code: 'recipient_count_changed', recipientCount: recipients.length },
      };
    }
    const dup = await findDuplicate({ requestId: input.requestId, title: input.text.title, body: input.text.body, audienceKey: key }, tx);
    if (dup && (dup.reason === 'request' || !input.allowDuplicate)) {
      return {
        ok: false as const, status: 409,
        body: {
          error: dup.reason === 'request' ? 'This announcement was already sent.' : 'The same announcement went to the same audience in the last 10 minutes.',
          code: 'duplicate_send', duplicateOf: dup,
        },
      };
    }
    const announcementId = randomUUID();
    const sent = await raiseNotificationsBulk(tx, 'announcement', buildNotificationItems(announcementId, input.text, recipients), 'announcementId');
    await logActivity({
      type: 'admin.announcement_sent', ...meta, targetType: 'announcement', targetId: announcementId,
      payload: {
        announcementId, title: input.text.title, body: input.text.body, link: input.text.link,
        audience: input.audience.audience, audienceKey: key, recipientCount: sent,
        userIds: recipients.slice(0, EVENT_USER_IDS).map(r => r.id),
        skippedCount: skipped.length, requestId: input.requestId,
      },
    }, { tx });
    return { ok: true as const, announcementId, sent, skipped };
  });
}

export interface AnnouncementHistoryItem {
  /** The event id — the keyset for paging. */
  id: number;
  announcementId: string;
  sentAt: string;
  sentBy: UserRef | null;
  title: string; body: string; link: string | null;
  audience: 'all' | 'users';
  recipientCount: number;
  /** Live, from notifications: rows still there (read ones are pruned after 30 days; users can Clear all). */
  delivered: number;
  unread: number;
  retractedAt: string | null;
  retracted: number | null;
}

/** Sent announcements, newest first, keyset-paged on the event id, with live delivered/unread counts. */
export async function listAnnouncements(before: number | null, limit: number): Promise<{ items: AnnouncementHistoryItem[]; nextBefore: number | null }> {
  const rows = await db.select({
    id: activityEvents.id, createdAt: activityEvents.createdAt, targetId: activityEvents.targetId, payload: activityEvents.payload,
    actorId: users.id, actorUsername: users.username, actorDisplayName: users.displayName,
  }).from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorUserId))
    .where(and(eq(activityEvents.type, 'admin.announcement_sent'), before ? lt(activityEvents.id, before) : undefined))
    .orderBy(desc(activityEvents.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const ids = pageRows.map(r => r.targetId).filter((v): v is string => !!v);
  const counts = new Map<string, { delivered: number; unread: number }>();
  const retracts = new Map<string, { at: string; removed: number | null }>();
  if (ids.length) {
    const c = await db.select({
      id: sql<string>`${notifications.payload} ->> 'announcementId'`,
      delivered: sql<number>`count(*)`.mapWith(Number),
      unread: sql<number>`count(*) FILTER (WHERE ${notifications.readAt} IS NULL)`.mapWith(Number),
    }).from(notifications)
      .where(and(eq(notifications.kind, 'announcement'), inArray(sql`${notifications.payload} ->> 'announcementId'`, ids)))
      .groupBy(sql`${notifications.payload} ->> 'announcementId'`);
    for (const r of c) counts.set(r.id, { delivered: r.delivered, unread: r.unread });
    const rt = await db.select({ id: activityEvents.targetId, at: activityEvents.createdAt, payload: activityEvents.payload })
      .from(activityEvents)
      .where(and(eq(activityEvents.type, 'admin.announcement_retracted'), eq(activityEvents.targetType, 'announcement'), inArray(activityEvents.targetId, ids)));
    for (const r of rt) if (r.id) retracts.set(r.id, { at: new Date(r.at).toISOString(), removed: typeof r.payload?.removed === 'number' ? r.payload.removed : null });
  }
  const items = pageRows.map(r => {
    const p = (r.payload ?? {}) as Record<string, any>;
    const aid = r.targetId ?? String(p.announcementId ?? '');
    return {
      id: r.id,
      announcementId: aid,
      sentAt: new Date(r.createdAt).toISOString(),
      sentBy: r.actorId != null ? { id: r.actorId, username: r.actorUsername!, displayName: r.actorDisplayName! } : null,
      title: String(p.title ?? ''), body: String(p.body ?? ''), link: typeof p.link === 'string' ? p.link : null,
      audience: p.audience === 'users' ? 'users' as const : 'all' as const,
      recipientCount: typeof p.recipientCount === 'number' ? p.recipientCount : 0,
      delivered: counts.get(aid)?.delivered ?? 0,
      unread: counts.get(aid)?.unread ?? 0,
      retractedAt: retracts.get(aid)?.at ?? null,
      retracted: retracts.get(aid)?.removed ?? null,
    };
  });
  return { items, nextBefore: rows.length > limit ? pageRows[pageRows.length - 1].id : null };
}

/**
 * Retract: delete every remaining notification of this announcement (read or not) and log
 * admin.announcement_retracted. 404 for an id that was never sent. Retracting twice is harmless
 * (the second removes 0 and is logged too).
 */
export async function retractAnnouncement(
  announcementId: string,
  meta: Pick<ActivityInput, 'actorUserId' | 'ip' | 'userAgent'>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return db.transaction(async tx => {
    const [sent] = await tx.select({ payload: activityEvents.payload }).from(activityEvents)
      .where(and(eq(activityEvents.type, 'admin.announcement_sent'), eq(activityEvents.targetType, 'announcement'), eq(activityEvents.targetId, announcementId)))
      .limit(1);
    if (!sent) return { status: 404, body: { error: 'Announcement not found', code: 'announcement_not_found' } };
    const gone = await tx.delete(notifications)
      .where(and(eq(notifications.kind, 'announcement'), sql`${notifications.payload} ->> 'announcementId' = ${announcementId}`))
      .returning({ id: notifications.id });
    await logActivity({
      type: 'admin.announcement_retracted', ...meta, targetType: 'announcement', targetId: announcementId,
      payload: { announcementId, title: (sent.payload as any)?.title ?? null, removed: gone.length },
    }, { tx });
    return { status: 200, body: { announcementId, removed: gone.length } };
  });
}
