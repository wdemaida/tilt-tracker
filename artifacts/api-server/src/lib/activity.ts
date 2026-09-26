import { db, activityEvents, type NewActivityEvent } from '@workspace/db';

// The admin activity log — writing side. Reading is routes/adminArea.ts.
//
// ONE RULE: logging never fails a user action. logActivity() catches and logs every error; callers
// just `await` it (or not). The only code that needs a throwing insert is the Clerk webhook, which
// must answer 5xx so Svix retries — it uses insertActivity() directly.
//
// Inside a transaction, pass { tx }: the insert runs in a SAVEPOINT, so a failed log insert rolls
// back only itself (a plain failed statement would abort the whole Postgres transaction) and a
// rolled-back action takes its event with it.
//
// PRIVACY: payloads go through sanitizePayload() — keys that look like secrets (tokens, passwords,
// R2/photo keys, emails, auth headers) are dropped at any depth, strings are capped, and the whole
// payload is size-capped. Still: only pass ids and display facts admins can already see.

export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Event types, grouped by category for the admin filter. Unknown types still log (category 'other').
 * Every type here also needs a retention tier in activityRetention.ts (TIER_BY_TYPE) — a unit test
 * fails otherwise.
 */
export const ACTIVITY_TYPES = {
  auth: ['user.signed_up', 'user.signed_in', 'user.first_setup', 'user.clerk_deleted'],
  score: ['score.created', 'score.edited', 'score.deleted', 'score.repair_machine', 'photo.uploaded', 'photo.replaced'],
  venue: [
    'venue.repair_here', 'venue.repair_here_attach', 'venue.repair_place', 'venue.repair_pm_link',
    'venue.resync_applied', 'venue.merged',
  ],
  friend: [
    'friend.request_sent', 'friend.request_resent', 'friend.request_accepted', 'friend.request_declined',
    'friend.request_cancelled', 'friend.removed',
  ],
  pod: ['pod.created', 'pod.updated', 'pod.deleted', 'pod.member_added', 'pod.member_removed'],
  challenge: [
    'challenge.created', 'challenge.accepted', 'challenge.declined', 'challenge.cancelled',
    'challenge.forfeited', 'challenge.resolved', 'challenge.expired',
  ],
  notification: ['notification.sent'],
  pm: ['pm.connected', 'pm.score_posted', 'pm.score_post_failed'],
  admin: [
    'admin.user_updated', 'admin.user_disabled', 'admin.user_enabled',
    'admin.score_deleted', 'admin.photo_deleted', 'admin.thumbnail_deleted',
    'admin.challenge_voided', 'admin.friendship_removed', 'admin.notification_deleted', 'admin.notifications_cleared',
    'admin.venue_deleted', 'admin.machine_updated', 'admin.machine_deleted',
    'admin.settings_changed', 'admin.photo_orphans_run',
  ],
  system: ['system.stat_snapshot', 'system.challenge_sweep', 'system.activity_retention', 'system.photo_orphans'],
} as const;

export type ActivityCategory = keyof typeof ACTIVITY_TYPES;
export type ActivityType = (typeof ACTIVITY_TYPES)[ActivityCategory][number];

export function categoryOf(type: string): ActivityCategory | 'other' {
  for (const [cat, types] of Object.entries(ACTIVITY_TYPES) as [ActivityCategory, readonly string[]][]) {
    if (types.includes(type)) return cat;
  }
  return 'other';
}

export interface ActivityInput {
  type: ActivityType;
  actorUserId?: number | null;
  subjectUserId?: number | null;
  targetType?: string | null;
  targetId?: string | number | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  svixId?: string | null;
}

const SECRET_KEY = /(token|password|passwd|secret|api[_-]?key|authorization|cookie|email|photo_?key|^key$|r2)/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_PAYLOAD_BYTES = 8_000;

/** Drop secret-looking keys (any depth), cap strings/arrays/depth. Pure — unit-tested. */
export function sanitizePayload(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(v => sanitizePayload(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) || v === undefined || typeof v === 'function') continue;
      out[k] = sanitizePayload(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

/** The row logActivity would insert. Pure — unit-tested. */
export function buildActivityRow(ev: ActivityInput): NewActivityEvent {
  let payload = (sanitizePayload(ev.payload ?? {}) ?? {}) as Record<string, unknown>;
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) payload = { truncated: true };
  const cap = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);
  return {
    type: ev.type,
    actorUserId: ev.actorUserId ?? null,
    subjectUserId: ev.subjectUserId ?? null,
    targetType: ev.targetType ?? null,
    targetId: ev.targetId == null ? null : String(ev.targetId),
    payload,
    ip: cap(ev.ip, 100),
    userAgent: cap(ev.userAgent, 300),
    svixId: ev.svixId ?? null,
  };
}

/**
 * Insert one event and THROW on failure. Returns the new id, or null when `svixId` was already
 * logged (a webhook retry). Only the Clerk webhook should call this directly.
 */
export async function insertActivity(ev: ActivityInput, ex: Executor = db): Promise<number | null> {
  const rows = await ex.insert(activityEvents).values(buildActivityRow(ev))
    .onConflictDoNothing({ target: activityEvents.svixId })
    .returning({ id: activityEvents.id });
  return rows[0]?.id ?? null;
}

/** Log an event. Never throws. With { tx }, runs in a savepoint of that transaction. */
export async function logActivity(ev: ActivityInput, opts: { tx?: Executor } = {}): Promise<void> {
  try {
    const tx = opts.tx;
    if (tx && tx !== db && typeof (tx as any).transaction === 'function') {
      await (tx as any).transaction((sp: Executor) => insertActivity(ev, sp));
    } else {
      await insertActivity(ev, tx ?? db);
    }
  } catch (err: any) {
    console.error(`[activity] failed to log ${ev.type}:`, err?.message ?? err);
  }
}

/**
 * The client address for an event. The app doesn't set `trust proxy`; on Render the proxy appends
 * the real client address as the LAST X-Forwarded-For entry (earlier ones are client-supplied).
 */
export function clientIp(req: any): string | null {
  const xff = req?.headers?.['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
  return list[list.length - 1] ?? req?.ip ?? null;
}

/** Actor + ip + user agent from a request that went through requireAppUser. */
export function fromReq(req: any): Pick<ActivityInput, 'actorUserId' | 'ip' | 'userAgent'> {
  return {
    actorUserId: req?.appUser?.id ?? null,
    ip: clientIp(req),
    userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

/** Just the actor — for everyday actions where an IP adds nothing. */
export function actorOf(req: any): Pick<ActivityInput, 'actorUserId'> {
  return { actorUserId: req?.appUser?.id ?? null };
}
