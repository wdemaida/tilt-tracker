import { db, pods, podMembers, scores } from '@workspace/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Viewer } from './venueActivity.js';

// Comparison scope for score listings (feature/pods, step 3): whose scores a chart/table compares
// the viewer against. Parsed from the query string, shared by every endpoint that offers it (the
// machine page today; venue and stats pages next):
//
//   (nothing)          → all       every visible score, as before
//   ?mine=true         → mine      only the viewer's own scores
//   ?pod=<id>          → pod       the viewer + that pod's members
//   ?pod=<id>&others=1 → pod       …plus everyone else, tagged 'other'
//
// PRIVACY RULES (same as routes/pods.ts):
//  - The client sends only a pod id. Membership is resolved here, in SQL, and member ids never go
//    over the wire from this path — only per-score `group` tags on rows the viewer could already see.
//  - A pod the viewer doesn't own — someone else's, nonexistent, malformed, or any pod while signed
//    out — is the same 404 `pod_not_found`, so a probe can't tell them apart.
//  - Scope only ever NARROWS a listing. Callers must still AND in visibleScoreSql(viewer): being in
//    someone's pod reveals nothing their home-venue privacy switch hides.

export type ScoreGroup = 'self' | 'pod' | 'other';

export type ParsedScope =
  | { kind: 'all' }
  | { kind: 'mine' }
  | { kind: 'pod'; podId: number; others: boolean };

export type ResolvedScope =
  | { kind: 'all' }
  | { kind: 'mine'; viewerId: number }
  | { kind: 'pod'; viewerId: number; pod: { id: number; name: string; color: string }; others: boolean };

function flag(v: unknown): boolean {
  return v === 'true' || v === '1';
}

export function parseComparisonScope(query: Record<string, unknown>): ParsedScope {
  if (query.pod !== undefined) {
    const id = Number(query.pod);
    // Malformed ids resolve to 0 → never owned → the same 404 as everything else.
    return { kind: 'pod', podId: Number.isInteger(id) && id > 0 ? id : 0, others: flag(query.others) };
  }
  if (flag(query.mine)) return { kind: 'mine' };
  return { kind: 'all' };
}

export const POD_NOT_FOUND = { error: 'Pod not found', code: 'pod_not_found' } as const;

/**
 * Checks pod ownership. Returns null when the scope names a pod the viewer doesn't own (the caller
 * answers 404 POD_NOT_FOUND). `mine` while signed out degrades to `all`, like `/machines?mine=true`.
 */
export async function resolveComparisonScope(parsed: ParsedScope, viewer?: Viewer): Promise<ResolvedScope | null> {
  if (parsed.kind === 'all') return { kind: 'all' };
  if (parsed.kind === 'mine') return viewer ? { kind: 'mine', viewerId: viewer.id } : { kind: 'all' };
  if (!viewer || parsed.podId <= 0) return null;
  const [pod] = await db
    .select({ id: pods.id, name: pods.name, color: pods.color })
    .from(pods)
    .where(and(eq(pods.id, parsed.podId), eq(pods.ownerId, viewer.id)))
    .limit(1);
  if (!pod) return null;
  return { kind: 'pod', viewerId: viewer.id, pod, others: parsed.others };
}

// "scores.user_id is a member of this pod" — re-checks ownership inside the subquery as well, so a
// resolved scope can never be pointed at someone else's pod by mistake.
function podMemberSql(scope: Extract<ResolvedScope, { kind: 'pod' }>): SQL {
  return sql`${scores.userId} IN (
    SELECT pm.user_id FROM ${podMembers} pm
    JOIN ${pods} p ON p.id = pm.pod_id
    WHERE p.id = ${scope.pod.id} AND p.owner_id = ${scope.viewerId}
  )`;
}

/** Extra WHERE condition for `scores` under this scope, or undefined for no narrowing. */
export function scopeFilterSql(scope: ResolvedScope): SQL | undefined {
  if (scope.kind === 'mine') return eq(scores.userId, scope.viewerId);
  if (scope.kind === 'pod' && !scope.others) {
    return sql`(${scores.userId} = ${scope.viewerId} OR ${podMemberSql(scope)})`;
  }
  return undefined;
}

/** Per-row group tag: the viewer's own scores, the selected pod's members, everyone else. */
export function scoreGroupSql(scope: ResolvedScope, viewer?: Viewer): SQL<ScoreGroup> {
  if (!viewer) return sql<ScoreGroup>`'other'`;
  if (scope.kind === 'pod') {
    return sql<ScoreGroup>`CASE WHEN ${scores.userId} = ${viewer.id} THEN 'self' WHEN ${podMemberSql(scope)} THEN 'pod' ELSE 'other' END`;
  }
  return sql<ScoreGroup>`CASE WHEN ${scores.userId} = ${viewer.id} THEN 'self' ELSE 'other' END`;
}

/** What the response echoes back so the client can label the chart. Only ever the viewer's own pod. */
export function scopeView(scope: ResolvedScope) {
  if (scope.kind === 'pod') return { kind: 'pod' as const, pod: scope.pod, others: scope.others };
  return { kind: scope.kind };
}
