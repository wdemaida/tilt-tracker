import { venueLabel } from './venueLabel';

/**
 * The Recent Scores search box (HomePage). A score matches when every whitespace-separated word of
 * the query appears, case-insensitively, in one of the things its card shows: the machine name, the
 * venue as labelled on the card ("HOME (@collasta)" / "HOME (you)", via venueLabel), the player's
 * @username, or their display name.
 *
 * Privacy: the haystack is built only from fields the server already sent this viewer for display.
 * Scores the viewer may not see (a home venue whose owner hid its activity) never reach the client —
 * GET /api/scores leaves them out (api-server venueActivity.ts visibleScoreSql) — and an owner handle
 * is only matchable when the server chose to send `venueOwnerUsername`. Never add a field here that
 * the card doesn't show.
 */
export type SearchableScore = {
  machineName: string;
  venueName?: string | null;
  venueOwnerUsername?: string | null;
  username: string;
  displayName?: string | null;
};

export function scoreSearchTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function scoreSearchText(s: SearchableScore, myUsername: string | null | undefined): string {
  return [
    s.machineName,
    s.venueName ? venueLabel(s.venueName, s.venueOwnerUsername, myUsername) : '',
    `@${s.username}`,
    s.displayName ?? '',
  ].join('\n').toLowerCase();
}

export function scoreMatchesSearch(s: SearchableScore, query: string, myUsername: string | null | undefined): boolean {
  const tokens = scoreSearchTokens(query);
  if (tokens.length === 0) return true;
  const text = scoreSearchText(s, myUsername);
  return tokens.every(t => text.includes(t));
}
