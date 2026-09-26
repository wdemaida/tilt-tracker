import { friendships } from '@workspace/db';
import { sql, type SQL } from 'drizzle-orm';

// Friendship SQL shared by the friends routes and the comparison scope (feature/friends, phase 1).
// The rules themselves are pure, in friendRules.ts.

/** "This row is the pair (a, b)", in either direction — there is at most one such row. */
export function pairSql(a: number, b: number): SQL {
  return sql`least(${friendships.requesterId}, ${friendships.addresseeId}) = ${Math.min(a, b)}
    AND greatest(${friendships.requesterId}, ${friendships.addresseeId}) = ${Math.max(a, b)}`;
}

/**
 * Subquery: the user ids of `viewerId`'s accepted friends. Resolved in SQL from the viewer's own id
 * only — callers never pass a client-supplied list of ids. Written with the raw table name (and
 * no drizzle column refs) so it can be embedded inside any outer query without alias clashes.
 */
export function friendIdsSql(viewerId: number): SQL {
  return sql`(
    SELECT CASE WHEN f.requester_id = ${viewerId} THEN f.addressee_id ELSE f.requester_id END
    FROM friendships f
    WHERE f.status = 'accepted' AND (f.requester_id = ${viewerId} OR f.addressee_id = ${viewerId})
  )`;
}

/** "a and b are accepted friends right now" — the consent a challenge needs (checked at creation). */
export function acceptedPairSql(a: number, b: number): SQL {
  return sql`${pairSql(a, b)} AND ${friendships.status} = 'accepted'`;
}
