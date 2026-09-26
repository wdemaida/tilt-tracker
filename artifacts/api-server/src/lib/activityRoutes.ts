import type { Request, Response, NextFunction } from 'express';
import { logActivity, clientIp, type ActivityType } from './activity.js';

// Route-level activity logging for routers we'd rather not edit line by line (Pinball Map posting is
// being reworked on another branch; venues.ts is 1600 lines of repair flow). Mounted in index.ts in
// front of a router: it matches method + path, waits for the response to finish, and logs one event
// from the status code, the path params and a whitelist of body fields. req.appUser is set by the
// router's own requireAppUser before the response goes out, so the actor is known by then.
//
// It never touches the response and never throws; the log is written after the reply is sent.

export interface RouteActivityRule {
  method: string;
  /** Matched against req.path relative to the mount point (e.g. /12/repair/merge). */
  pattern: RegExp;
  /** Event type on a 2xx; `failure` (optional) on 4xx/5xx other than 401/403 (auth refusals aren't activity). */
  success: ActivityType;
  failure?: ActivityType;
  targetType?: string;
  /** Capture group index in `pattern` holding the target id. */
  targetGroup?: number;
  /** Body fields worth keeping (primitives only; anything secret-looking is dropped anyway). */
  bodyFields?: string[];
  /** Record ip + user agent. */
  withClientInfo?: boolean;
}

/** Pure: the event a finished request should produce, or null. Unit-tested. */
export function eventForFinishedRequest(
  rules: RouteActivityRule[], method: string, path: string, status: number, body: unknown,
): { type: ActivityType; rule: RouteActivityRule; targetId: string | null; payload: Record<string, unknown> } | null {
  for (const rule of rules) {
    if (rule.method !== method) continue;
    const m = rule.pattern.exec(path);
    if (!m) continue;
    let type: ActivityType | undefined;
    if (status >= 200 && status < 300) type = rule.success;
    else if (status >= 400 && status !== 401 && status !== 403) type = rule.failure;
    if (!type) return null;
    const payload: Record<string, unknown> = { status };
    const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    for (const f of rule.bodyFields ?? []) {
      const v = src[f];
      if (v == null) continue;
      if (typeof v === 'string') payload[f] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') payload[f] = v;
      else if (Array.isArray(v)) payload[`${f}Count`] = v.length;
    }
    return { type, rule, targetId: rule.targetGroup != null ? m[rule.targetGroup] ?? null : null, payload };
  }
  return null;
}

export function routeActivity(rules: RouteActivityRule[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!rules.some(r => r.method === req.method && r.pattern.test(req.path))) return next();
    const method = req.method;
    const path = req.path;
    res.on('finish', () => {
      try {
        const ev = eventForFinishedRequest(rules, method, path, res.statusCode, req.body);
        if (!ev) return;
        const appUser = (req as any).appUser;
        void logActivity({
          type: ev.type,
          actorUserId: appUser?.id ?? null,
          targetType: ev.rule.targetType ?? null,
          targetId: ev.targetId,
          payload: ev.payload,
          ...(ev.rule.withClientInfo ? { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null } : {}),
        });
      } catch (err) {
        console.error('[activity] route logger failed:', err);
      }
    });
    next();
  };
}

// ── rule sets ────────────────────────────────────────────────────────────────

/** /api/pinballmap — account connect and score cross-posting (success and failure). */
export const PM_RULES: RouteActivityRule[] = [
  { method: 'POST', pattern: /^\/auth\/?$/, success: 'pm.connected', withClientInfo: true },
  {
    method: 'POST', pattern: /^\/submit-score\/?$/, success: 'pm.score_posted', failure: 'pm.score_post_failed',
    bodyFields: ['venueId', 'machineName', 'score', 'scoreId'],
  },
];

/** /api/venues — repair / re-sync / merge, and the admin-only delete. */
export const VENUE_RULES: RouteActivityRule[] = [
  { method: 'POST', pattern: /^\/(\d+)\/repair\/here\/?$/, success: 'venue.repair_here', targetType: 'venue', targetGroup: 1 },
  { method: 'POST', pattern: /^\/(\d+)\/repair\/here\/attach\/?$/, success: 'venue.repair_here_attach', targetType: 'venue', targetGroup: 1, bodyFields: ['hereId'] },
  { method: 'POST', pattern: /^\/(\d+)\/repair\/place\/?$/, success: 'venue.repair_place', targetType: 'venue', targetGroup: 1, bodyFields: ['hereId', 'pinballMapId', 'source'] },
  { method: 'POST', pattern: /^\/(\d+)\/repair\/pm-link\/?$/, success: 'venue.repair_pm_link', targetType: 'venue', targetGroup: 1, bodyFields: ['pinballMapId'] },
  { method: 'POST', pattern: /^\/(\d+)\/repair\/resync-apply\/?$/, success: 'venue.resync_applied', targetType: 'venue', targetGroup: 1, bodyFields: ['merges'] },
  { method: 'POST', pattern: /^\/(\d+)\/repair\/merge\/?$/, success: 'venue.merged', targetType: 'venue', targetGroup: 1, bodyFields: ['intoVenueId', 'expectedScoreCount'] },
  { method: 'DELETE', pattern: /^\/(\d+)\/?$/, success: 'admin.venue_deleted', targetType: 'venue', targetGroup: 1, withClientInfo: true },
];

/** /api/machines — admin-only edit and delete. */
export const MACHINE_RULES: RouteActivityRule[] = [
  { method: 'PATCH', pattern: /^\/(\d+)\/?$/, success: 'admin.machine_updated', targetType: 'machine', targetGroup: 1, bodyFields: ['name', 'manufacturer', 'year'] },
  { method: 'DELETE', pattern: /^\/(\d+)\/?$/, success: 'admin.machine_deleted', targetType: 'machine', targetGroup: 1, withClientInfo: true },
];
