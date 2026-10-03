import type { ComparisonScope } from './comparisonScope';
import type { PodRef } from './myPods';

// The Stats page's tiles: the short label on the tile, the full name and a description for its
// InfoTip. The copy lives here rather than in the DB's `stats.description` because three tiles have
// no `stats` row (Venues Played, Plays / Visit, Scores Logged / Day), and that column describes the
// site-wide daily snapshot while the tiles follow the Compare scope. `{who}` is filled per scope.
// Wording checked against the api-server's statsCalc.ts (VISIT_GAP_MS, computeCurrentMonthCounts)
// and routes/stats.ts (daySpan) — change them together.

export type StatTileId =
  | 'plays' | 'visits' | 'machinesWithScore' | 'venuesPlayed'
  | 'playsPerVisit' | 'playsThisMonth' | 'visitsThisMonth' | 'scoresPerDay'
  | 'venues' | 'machinesInSystem';

export const STAT_TILES: Record<StatTileId, { label: string; name: string; description: string }> = {
  plays: {
    label: 'Plays', name: 'Plays',
    description: 'Every score logged by {who}, all time. Each score is one play.',
  },
  visits: {
    label: 'Visits', name: 'Visits',
    description: 'Separate trips to play by {who}, all time. Scores more than 6 hours apart start a new visit.',
  },
  machinesWithScore: {
    label: 'Machines w/ Score', name: 'Machines with a Score',
    description: 'Different machines with at least one score from {who}.',
  },
  venuesPlayed: {
    label: 'Venues Played', name: 'Venues Played',
    description: 'Different venues where {who} logged at least one score.',
  },
  playsPerVisit: {
    label: 'Plays / Visit', name: 'Plays per Visit',
    description: 'Total plays divided by total visits, for {who}.',
  },
  playsThisMonth: {
    label: 'Plays This Month', name: 'Plays This Month',
    description: 'Scores played by {who} so far this calendar month (Eastern time), by the date the game was played.',
  },
  visitsThisMonth: {
    label: 'Visits This Month', name: 'Visits This Month',
    description: 'Visits by {who} so far this calendar month (Eastern time), same 6-hour rule.',
  },
  scoresPerDay: {
    label: 'Scores Logged / Day', name: 'Scores Logged per Day',
    description: 'Scores logged by {who} divided by the days between the first and latest one logged (min. 1 day).',
  },
  venues: {
    label: 'Venues', name: 'Venues',
    description: 'Every venue in TiltTrack, public and private, including unplayed ones. Same in every view.',
  },
  machinesInSystem: {
    label: 'Machines in System', name: 'Machines in System',
    description: 'Every machine TiltTrack knows, including ones only seen on a synced Pinball Map roster.',
  },
};

// Who a scoped number is about, in words — for the subtitle, the trend modal, the play-style note
// and the tile descriptions.
export function whoLabel(scope: ComparisonScope, pod: PodRef | null): string {
  if (scope.kind === 'mine') return 'you';
  if (scope.kind === 'pod') return `you + ${pod?.name ?? 'your pod'}${scope.others ? ' + everyone else' : ''}`;
  if (scope.kind === 'friends') return `you + your friends${scope.others ? ' + everyone else' : ''}`;
  return 'all players';
}

export interface StatTileInfo { id: StatTileId; label: string; name: string; description: string }

/** A tile's label, full name and description, with `{who}` filled for the current Compare scope. */
export function statTileInfo(id: StatTileId, scope: ComparisonScope, pod: PodRef | null): StatTileInfo {
  const t = STAT_TILES[id];
  return { id, label: t.label, name: t.name, description: t.description.split('{who}').join(whoLabel(scope, pod)) };
}
