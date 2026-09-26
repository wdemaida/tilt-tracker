const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

async function request<T>(path: string, init?: RequestInit, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (init?.headers) Object.assign(headers, init.headers);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // `body` carries the whole error payload — some responses attach structured detail the caller
    // needs, e.g. the duplicate-venue 409's `candidates`. `code`/`status` stay for existing callers.
    throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status, code: err.code, body: err });
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** A private venue's owner-managed machine list, as the server returns it. */
export interface VenueInventory {
  /** True once the owner has ever added a machine — from then on the list *is* the machine count. */
  managed: boolean;
  machines: Array<{ id: number; name: string; manufacturer: string | null; year: number | null; addedAt: string }>;
  former: Array<{ id: number; name: string; manufacturer: string | null; year: number | null; addedAt: string; removedAt: string }>;
}

/** A user as the pod member picker / member list shows them — public profile fields only. */
export interface PodUser {
  id: number;
  username: string;
  displayName: string;
}

/** One of the caller's pods, as `/api/pods` returns it. Only ever the caller's own. */
export interface Pod {
  id: number;
  name: string;
  /** `#rrggbb`, lowercase — render through podColorVars / PodChip, never raw. */
  color: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  members: Array<PodUser & { addedAt: string }>;
}

/**
 * The caller's relationship with another user, as the server computes it (friendRules.ts on the
 * api-server). There is deliberately no "declined": a declined request just reads as `none` to the
 * person who sent it, or `unavailable` once they've been declined 3 times.
 */
export type FriendRelationship = 'none' | 'outgoing' | 'incoming' | 'friends' | 'unavailable';

/** `GET /api/friends` — only ever the caller's own. */
export interface FriendsList {
  friends: Array<{ user: PodUser; since: string }>;
  incoming: Array<{ user: PodUser; requestedAt: string }>;
  outgoing: Array<{ user: PodUser; requestedAt: string }>;
}

/** One inbox entry. `payload` depends on `kind`; the friend kinds carry who it's about. */
export interface AppNotification {
  id: number;
  kind:
    | 'friend_request' | 'friend_accepted'
    | 'challenge_received' | 'challenge_accepted' | 'challenge_declined' | 'challenge_cancelled'
    | 'challenge_opponent_scored' | 'challenge_ending_soon' | 'challenge_result'
    | (string & {});
  /** Challenge kinds add challengeId, challengeType, machineName (+ score / outcome / void per kind). */
  payload: {
    userId?: number; username?: string; displayName?: string;
    challengeId?: number; challengeType?: string; machineName?: string;
    score?: number; outcome?: string; void?: boolean;
  } & Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

/** `GET /api/venues/search` — see venueSearch.ts on the api-server. */
export interface VenueSearchResult {
  tiltTrack: Array<{
    id: number; name: string; address: string | null; venueLat: number | null; venueLng: number | null;
    hereId: string | null; pinballMapId: number | null; timezone: string | null; distance: number | null;
    isPrivate: boolean; matchedBy: 'name' | 'place';
  }>;
  places: Array<{
    hereId: string; name: string; address: string; venueLat: number | null; venueLng: number | null;
    timezone: string | null; distance: number | null;
  }>;
  /** What biased the HERE half: the client's location, the user's last venue, a default, or none (too short). */
  anchor: 'client' | 'history' | 'default' | 'none';
}

/** GET /venues/:id/repair/merge-preview — what merging this venue into another would move. */
export interface VenueMergePreview {
  source: { id: number; name: string };
  target: { id: number; name: string; address: string | null };
  scoreCount: number;
  myScoreCount: number;
  /** Who has scores at the source — admins only; null for everyone else. */
  players: Array<{ username: string; scoreCount: number }> | null;
  otherPlayerCount: number;
  otherScoreCount: number;
  historyRows: number;
  historyOverlap: number;
  inventoryRows: number;
  inventoryOverlap: number;
  /** What the target will take from the source because it had none ("HERE link", "address", …). */
  adopts: string[];
  canMerge: boolean;
  blocker: string | null;
  blockerMessage: string | null;
}

export interface VenueMergeResult {
  sourceId: number;
  targetId: number;
  targetName: string;
  scoresMoved: number;
  historyMoved: number;
  historyMerged: number;
  inventoryMoved: number;
  inventoryMerged: number;
  adopted: string[];
}

// ── Challenges (lib/challenges.ts + challengeRules.ts on the api-server) ──────────────────────

export type ChallengeType = 'high_score' | 'race' | 'most_improved' | 'average';
export type ChallengeStatus = 'pending' | 'active' | 'resolved' | 'declined' | 'cancelled' | 'expired';
export type ChallengePhase = 'pending' | 'scheduled' | 'live' | 'ended' | 'resolved' | 'declined' | 'cancelled' | 'expired';
export type ChallengeResponse = 'pending' | 'accepted' | 'declined';
/** `abandoned`: a race nobody beat, or an average nobody qualified for — no winner, no loser. */
export type ChallengeOutcome = 'win' | 'loss' | 'tie' | 'forfeit' | 'no_show' | 'abandoned' | (string & {});

export interface ChallengeParticipant {
  user: PodUser;
  isCreator: boolean;
  response: ChallengeResponse;
  respondedAt: string | null;
  /** Final once resolved ('forfeit' as soon as they withdraw). */
  outcome: ChallengeOutcome | null;
  rank: number | null;
  resultValue: number | null;
  baselineScore: number | null;
  /** Live standing, once the window has started; null before. */
  standing: {
    resultValue: number | null;
    countingCount: number;
    bestScore: number | null;
    qualified: boolean;
    liveRank: number | null;
    reachedTargetAt: string | null;
  } | null;
  /** Detail only: the scores that count, newest upload first. */
  scores?: Array<{ id: number; score: number; playedAt: string; createdAt: string; venueId: number | null; venueName: string | null; venueTimezone: string | null }>;
}

/** GET /api/challenges/venue-options — a public venue that has the challenge's machine. */
export interface ChallengeVenueOption { id: number; name: string; city: string | null; state: string | null }

export interface Challenge {
  id: number;
  type: ChallengeType;
  status: ChallengeStatus;
  phase: ChallengePhase;
  void: boolean;
  /** A race nobody finished / an average nobody qualified for. Older servers omit it (derive from outcomes). */
  abandoned?: boolean;
  matchMode: 'game' | 'exact';
  matchGroup: string | null;
  machine: { id: number; name: string; imageUrl: string | null };
  venue: { id: number; name: string } | null;
  targetScore: number | null;
  minPlays: number | null;
  startsAt: string | null;
  endsAt: string;
  createdAt: string;
  resolvedAt: string | null;
  creatorId: number;
  timeLeftMs: number | null;
  startsInMs: number | null;
  me: { response: ChallengeResponse; outcome: ChallengeOutcome | null; canAccept: boolean; canDecline: boolean; canCancel: boolean; canForfeit: boolean };
  opponent: PodUser | null;
  participants: ChallengeParticipant[];
}

interface RecordCounts {
  played: number;
  wins: number;
  losses: number;
  ties: number;
  forfeits: number;
  noShows: number;
  /** Newer servers only. */
  abandoned?: number;
}

export interface ChallengeRecord extends RecordCounts {
  user: PodUser;
  voids: number;
  currentStreak: number;
  bestStreak: number;
  /** Your own record: every opponent. Someone else's: only their record against you. */
  headToHead: Array<RecordCounts & { opponent: PodUser }>;
}

export interface CreateChallengeBody {
  friendId?: number;
  friendUsername?: string;
  type: ChallengeType;
  machineId: number;
  matchMode?: 'game' | 'exact';
  venueId?: number;
  targetScore?: number;
  minPlays?: number;
  /** Omit to start when they accept. */
  startsAt?: string;
  endsAt: string;
}

export function createApi(getToken: () => Promise<string | null>) {
  const tok = () => getToken();

  return {
    // Every read sends the viewer's token when there is one (null when signed out), not only the
    // `mine` variants: what a listing contains depends on who's asking — a home venue's owner (and
    // each score's author) sees scores there that others don't. See venueActivity.ts on the server.
    scores: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/scores?mine=true' : '/scores', undefined, await tok()),
      create: async (body: Record<string, unknown>) =>
        request<any>('/scores', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      // `venueId` attaches a venue to a score that was logged without one — see ScoreVenuePicker.
      patch: async (id: number, body: { score?: number; type?: string; playedAt?: string; machineId?: number; venueId?: number | null }) =>
        request(`/scores/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/scores/${id}`, { method: 'DELETE' }, await tok()),

      // Per-score repair — venue linkage state plus ranked machine candidates for this one score.
      repair: {
        status: async (id: number) =>
          request<any>(`/scores/${id}/repair`, undefined, await tok()),
        machine: async (id: number, body: { pmName: string; pmManufacturer?: string | null; pmYear?: number | null }) =>
          request<any>(`/scores/${id}/repair/machine`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
      },
    },
    machines: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/machines?mine=true' : '/machines', undefined, await tok()),
      // `scopeQuery` comes from lib/comparisonScope.ts ('' | '?mine=true' | '?pod=<id>[&others=1]' |
      // '?friends=1[&others=1]'). A pod scope 404s `pod_not_found` unless the pod is the caller's own.
      get: async (name: string, scopeQuery = '') =>
        request<any>(`/machines/${encodeURIComponent(name)}${scopeQuery}`, undefined, await tok()),
      search: (q: string) => request<any[]>(`/machines/search?q=${encodeURIComponent(q)}`),
      // Count + median of recorded scores — drives the "may be missing digits" check on AddScorePage.
      scoreStats: (name: string) =>
        request<{ machineId: number | null; machineName: string | null; count: number; median: number | null }>(
          `/machines/score-stats?name=${encodeURIComponent(name)}`),
      upsert: async (body: Record<string, unknown>) =>
        request<any>('/machines', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      patch: async (id: number, body: { name?: string; manufacturer?: string; year?: number | null }) =>
        request(`/machines/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/machines/${id}`, { method: 'DELETE' }, await tok()),
    },
    users: {
      me: async () => request<any | null>('/users/me', undefined, await tok()),
      setup: async (body: { username: string; displayName: string }) =>
        request('/users/setup', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      get: async (username: string) => request<any>(`/users/${username}`, undefined, await tok()),
    },
    // Pods — the caller's own private groupings. Signed-in only; every call is scoped to pods the
    // caller owns, and a pod they don't own is a 404. Always use through useApi() — the static `api`
    // export has no token and every pods call would 401.
    pods: {
      list: async () => request<Pod[]>('/pods', undefined, await tok()),
      create: async (body: { name: string; color?: string }) =>
        request<Pod>('/pods', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      update: async (id: number, body: { name?: string; color?: string }) =>
        request<Pod>(`/pods/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request<void>(`/pods/${id}`, { method: 'DELETE' }, await tok()),
      addMember: async (id: number, userId: number) =>
        request<Pod>(`/pods/${id}/members`, { method: 'POST', body: JSON.stringify({ userId }) }, await tok()),
      removeMember: async (id: number, userId: number) =>
        request<Pod>(`/pods/${id}/members/${userId}`, { method: 'DELETE' }, await tok()),
      searchUsers: async (q: string) =>
        request<PodUser[]>(`/pods/user-search?q=${encodeURIComponent(q)}`, undefined, await tok()),
    },
    // Friends — signed-in only, always the caller's own relationships. Use through useApi().
    // Actions are keyed by the OTHER user's id. `send` answers `result`: 'sent' | 'resent' (still
    // pending, re-notified) | 'accepted' (they had asked you) | 'already_friends'; a 403
    // `request_unavailable` means the decline cap — show it as unavailable, never as "declined".
    friends: {
      list: async () => request<FriendsList>('/friends', undefined, await tok()),
      search: async (q: string) =>
        request<Array<PodUser & { relationship: FriendRelationship }>>(`/friends/search?q=${encodeURIComponent(q)}`, undefined, await tok()),
      with: async (username: string) =>
        request<{ user: PodUser; relationship: FriendRelationship | 'self' }>(`/friends/with/${encodeURIComponent(username)}`, undefined, await tok()),
      send: async (userId: number) =>
        request<{ result: 'sent' | 'resent' | 'accepted' | 'already_friends'; relationship: FriendRelationship }>(
          '/friends/requests', { method: 'POST', body: JSON.stringify({ userId }) }, await tok()),
      accept: async (userId: number) =>
        request<{ relationship: FriendRelationship }>(`/friends/requests/${userId}/accept`, { method: 'POST' }, await tok()),
      decline: async (userId: number) =>
        request<{ relationship: FriendRelationship }>(`/friends/requests/${userId}/decline`, { method: 'POST' }, await tok()),
      cancel: async (userId: number) =>
        request<{ relationship: FriendRelationship }>(`/friends/requests/${userId}`, { method: 'DELETE' }, await tok()),
      remove: async (userId: number) =>
        request<{ relationship: FriendRelationship }>(`/friends/${userId}`, { method: 'DELETE' }, await tok()),
    },
    // The in-app inbox — only ever the caller's own. Keyset-paged: pass `nextBefore` back as `before`.
    notifications: {
      list: async (before?: number, limit = 30) =>
        request<{ items: AppNotification[]; nextBefore: number | null }>(
          `/notifications?limit=${limit}${before ? `&before=${before}` : ''}`, undefined, await tok()),
      unreadCount: async () => request<{ count: number }>('/notifications/unread-count', undefined, await tok()),
      markRead: async (id: number) =>
        request<{ id: number; readAt: string }>(`/notifications/${id}/read`, { method: 'POST' }, await tok()),
      markAllRead: async () => request<{ updated: number }>('/notifications/read-all', { method: 'POST' }, await tok()),
      // "Clear all" — deletes every notification of the caller's, read or not.
      clearAll: async () => request<{ deleted: number }>('/notifications', { method: 'DELETE' }, await tok()),
    },
    // Challenges — signed-in only; a challenge is visible to its participants alone (anyone else
    // gets 404 challenge_not_found). Use through useApi(). Errors carry `.code` — see
    // challengeErrorText() in lib/challenges.ts for the friendly copy.
    challenges: {
      list: async (status: 'pending' | 'active' | 'history' | 'all' = 'all') =>
        request<Challenge[]>(`/challenges?status=${status}`, undefined, await tok()),
      get: async (id: number) => request<Challenge>(`/challenges/${id}`, undefined, await tok()),
      create: async (body: CreateChallengeBody) =>
        request<Challenge>('/challenges', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      // Public venues a challenge on this machine can be locked to (they have it, per Pinball Map,
      // machine history or a score there). The server re-checks on create (machine_not_at_venue).
      venueOptions: async (machineId: number, matchMode: 'game' | 'exact') =>
        request<ChallengeVenueOption[]>(`/challenges/venue-options?machineId=${machineId}&matchMode=${matchMode}`, undefined, await tok()),
      act: async (id: number, action: 'accept' | 'decline' | 'cancel' | 'forfeit') =>
        request<Challenge>(`/challenges/${id}/${action}`, { method: 'POST' }, await tok()),
      // No username = your own record (head-to-head vs everyone).
      record: async (username?: string) =>
        request<ChallengeRecord>(username ? `/challenges/record/${encodeURIComponent(username)}` : '/challenges/record', undefined, await tok()),
    },
    stats: {
      // `scope` is scopeQuery(scope) from lib/comparisonScope ('' = everyone).
      get: async (scope = '') => request<any>(`/stats${scope}`, undefined, await tok()),
      // Snapshots ('snapshot') for All and the site-wide keys; rebuilt from the scope's scores ('live') otherwise.
      history: async (key: string, days = 90, scope = '') =>
        request<{ label: string; description: string | null; source: 'snapshot' | 'live'; points: { periodDate: string; value: number }[] }>(
          `/stats/history/${key}?days=${days}${scope.replace('?', '&')}`, undefined, await tok()
        ),
    },
    venues: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/venues?mine=true' : '/venues', undefined, await tok()),
      machines: async (id: number) => request<any>(`/venues/${id}/machines`, undefined, await tok()),
      pmMachines: (pmId: number) => request<any>(`/venues/pm-machines/${pmId}`),
      // The Pinball Map listing a venue-step pick is, resolved lazily on pick (never per search
      // result): a HERE place by its own coordinates + name, or a TiltTrack venue by id (the server
      // uses its coordinates, and answers null for a private venue). Same matching rule as the
      // nearby suggestions. `pinballMapId: null` = no match; the machine step then stays as before.
      pmMatch: async (q: { venueId: number } | { lat: number; lng: number; name: string }) =>
        request<{ pinballMapId: number | null; name?: string; url?: string; machineCount?: number | null; linked?: boolean }>(
          'venueId' in q
            ? `/venues/pm-match?venueId=${q.venueId}`
            : `/venues/pm-match?lat=${q.lat}&lng=${q.lng}&name=${encodeURIComponent(q.name)}`,
          undefined, await tok(),
        ),
      // Private venues (homes) whose name matches exactly — name only, never a location. How a
      // friend finds someone's home venue to log a score there.
      exact: async (name: string) =>
        request<Array<{ id: number; name: string; isPrivate: true }>>(
          `/venues/exact?name=${encodeURIComponent(name)}`, undefined, await tok(),
        ),
      // Same suggestion list a photo's GPS produces, for the device's current position — the Add
      // Score fallback when no photo had location. Lookup only: the server stores nothing. POSTed
      // (not a query string, which lands in access logs) and rounded to 4 decimals (~11m) first —
      // plenty to find the venue you're standing in, and no more precise than that needs.
      nearby: async (lat: number, lng: number) =>
        request<{ venues: any[] }>('/upload/nearby-venues', {
          method: 'POST',
          body: JSON.stringify({ lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 }),
        }, await tok()),
      // `at` only biases the suggestions (it may be the device's position). It rides in the query
      // string, so it's rounded to 3 decimals (~110m) — ample for a bias, and less precise in logs.
      addressAutocomplete: (q: string, at?: { lat: number; lng: number }) =>
        request<Array<{ id: string; label: string; lat: number | null; lng: number | null }>>(
          `/venues/address-autocomplete?q=${encodeURIComponent(q)}${at ? `&lat=${Math.round(at.lat * 1e3) / 1e3}&lng=${Math.round(at.lng * 1e3) / 1e3}` : ''}`
        ),
      // Add Score venue search: TiltTrack venues by any word + HERE places by name, a place that
      // already is a venue folded into it. `at` biases HERE and yields distances; rounded to 3
      // decimals (~110m) since it rides in the query string, like addressAutocomplete's.
      search: async (q: string, at?: { lat: number; lng: number }) =>
        request<VenueSearchResult>(
          `/venues/search?q=${encodeURIComponent(q)}${at ? `&lat=${Math.round(at.lat * 1e3) / 1e3}&lng=${Math.round(at.lng * 1e3) / 1e3}` : ''}`,
          undefined, await tok(),
        ),
      // `scopeQuery` comes from lib/comparisonScope.ts ('' | '?mine=true' | '?pod=<id>[&others=1]').
      // Scope narrows `scores` only; `venue` and `totals` are the same in every scope. A pod scope
      // 404s `pod_not_found` unless the pod is the caller's own.
      scores: async (id: number, scopeQuery = '') =>
        request<any>(`/venues/${id}/scores${scopeQuery}`, undefined, await tok()),
      // Rejects with a 409 (`code: 'duplicate_venue'`, plus `candidates`) when a venue of the same
      // name already exists within 250m. Re-send with `allowDuplicate: true` once the user confirms
      // it really is a different place.
      create: async (body: { name: string; address: string; isResidence?: boolean; privacyTier?: 'full' | 'city_state' | 'hidden'; allowDuplicate?: boolean }) =>
        request<any>('/venues', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      patch: async (id: number, body: { name?: string; address?: string | null; isResidence?: boolean; privacyTier?: 'full' | 'city_state' | 'hidden'; showMachinesAndScores?: boolean }) =>
        request(`/venues/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      // Owner-managed machines at a private (home) venue — owner or admin only. `name` is a machine
      // from the catalog search (`machines.search`); anything not in the catalog is refused.
      inventory: {
        add: async (id: number, body: { name: string } | { machineId: number }) =>
          request<{ added: boolean; inventory: VenueInventory }>(`/venues/${id}/inventory`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
        remove: async (id: number, machineId: number) =>
          request<{ removed: boolean; inventory: VenueInventory }>(`/venues/${id}/inventory/${machineId}`, { method: 'DELETE' }, await tok()),
      },
      delete: async (id: number) =>
        request(`/venues/${id}`, { method: 'DELETE' }, await tok()),

      // Venue repair — for venues that never resolved to a HERE place or a Pinball Map location on
      // upload. All of these require auth: the backend allows an admin, the venue's owner, or
      // whoever added the venue.
      repair: {
        status: async (id: number) =>
          request<any>(`/venues/${id}/repair`, undefined, await tok()),
        resolveHere: async (id: number) =>
          request<any>(`/venues/${id}/repair/here`, { method: 'POST', body: '{}' }, await tok()),
        attachHere: async (id: number, body: { hereId: string; latitude?: number | null; longitude?: number | null }) =>
          request<any>(`/venues/${id}/repair/here/attach`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
        // For a venue with no address at all (typed in by name with location services off): search
        // Pinball Map and HERE by name, optionally near a city, then write the chosen place.
        placeSearch: async (id: number, q: string, near?: string) =>
          request<any>(
            `/venues/${id}/repair/place-search?q=${encodeURIComponent(q)}${near ? `&near=${encodeURIComponent(near)}` : ''}`,
            undefined, await tok(),
          ),
        resolvePlace: async (id: number, body:
          | { source: 'pm'; pinballMapId: number }
          | { source: 'here'; hereId: string }
          | { source: 'manual'; street: string; city: string; state?: string; postalCode?: string; country?: string; confirm?: boolean; acceptImprecise?: boolean }) =>
          request<any>(`/venues/${id}/repair/place`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
        pmCandidates: async (id: number, q?: string) =>
          request<any>(`/venues/${id}/repair/pm-candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`, undefined, await tok()),
        pmLink: async (id: number, pinballMapId: number) =>
          request<any>(`/venues/${id}/repair/pm-link`, { method: 'POST', body: JSON.stringify({ pinballMapId }) }, await tok()),
        resyncPreview: async (id: number) =>
          request<any>(`/venues/${id}/repair/resync-preview`, undefined, await tok()),
        resyncApply: async (id: number, merges: Array<Record<string, unknown>>) =>
          request<any>(`/venues/${id}/repair/resync-apply`, { method: 'POST', body: JSON.stringify({ merges }) }, await tok()),
        // Fold this (duplicate) venue into another one: preview what moves, then confirm. The
        // confirm echoes the previewed score count so a stale preview is refused (409 merge_stale).
        mergePreview: async (id: number, intoVenueId: number) =>
          request<VenueMergePreview>(`/venues/${id}/repair/merge-preview?into=${intoVenueId}`, undefined, await tok()),
        merge: async (id: number, intoVenueId: number, expectedScoreCount: number) =>
          request<VenueMergeResult>(`/venues/${id}/repair/merge`, {
            method: 'POST', body: JSON.stringify({ intoVenueId, expectedScoreCount }),
          }, await tok()),
      },
    },
    pinballmap: {
      getToken: async () =>
        request<{ hasToken: boolean; pmUsername: string | null }>('/pinballmap/token', undefined, await tok()),
      auth: async (email: string, password: string) =>
        request<{ token: string; username: string }>(
          '/pinballmap/auth',
          { method: 'POST', body: JSON.stringify({ email, password }) },
          await tok()
        ),
      submitScore: async (body: { venueId: number; machineName: string; score: number; userToken?: string }) =>
        request('/pinballmap/submit-score', { method: 'POST', body: JSON.stringify(body) }, await tok()),
    },
    admin: {
      users: async () => request<any[]>('/admin/users', undefined, await tok()),
      health: async () => request<any>('/admin/health', undefined, await tok()),
      updateUser: async (id: number, data: { role?: string; displayName?: string; username?: string }) =>
        request<any>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, await tok()),
      stats: async () => request<any[]>('/admin/stats', undefined, await tok()),
      statHistory: async (days = 60) => request<any[]>(`/admin/stats/history?days=${days}`, undefined, await tok()),
      updateStat: async (id: number, body: { label?: string; description?: string }) =>
        request<any>(`/admin/stats/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      deleteStat: async (id: number) =>
        request(`/admin/stats/${id}`, { method: 'DELETE' }, await tok()),
      runStatSnapshot: async () =>
        request<{ periodDate: string; values: Record<string, number> }>('/admin/stats/snapshot', { method: 'POST' }, await tok()),
      // Always targets the local loopback API directly (not BASE) — Drizzle Studio can only ever
      // run on the machine driving this browser, whether the page itself is served from
      // localhost:5174 or the deployed tilttrack.vercel.app.
      startDrizzleStudio: async () => {
        const token = await tok();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        let res: Response;
        try {
          res = await fetch('http://localhost:3001/api/admin/drizzle-studio/start', { method: 'POST', headers });
        } catch {
          throw new Error('Could not reach your local API server on port 3001 — start it with "npx tsx watch src/index.ts" from artifacts/api-server first.');
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status });
        }
        return res.json() as Promise<{ status: 'starting' | 'already-running' }>;
      },
    },
    // One request for every photo of a score (1–3). Each photo's client-extracted GPS/timestamp goes
    // in the JSON `meta` field, index-aligned with `photos` (see prepareUploadImage.ts) — HEIC
    // conversion and the client-side downscale both strip EXIF, so that data can't be recovered
    // server-side from the uploaded files. When absent the server tries its own extraction.
    upload: async (images: Array<{ file: Blob; filename?: string; latitude?: number | null; longitude?: number | null; exifDatetime?: string | null; heicFailed?: boolean }>) => {
      const token = await tok();
      const form = new FormData();
      // A lone HEIC the browser couldn't convert is the camera original — too big for the set path's
      // per-image limit, so it goes up the legacy single-`photo` way to the server's own HEIC decode.
      const legacy = images.length === 1 && !!images[0].heicFailed;
      images.forEach((img, i) => form.append(legacy ? 'photo' : 'photos', img.file, img.filename ?? `photo-${i + 1}.jpg`));
      form.append('meta', JSON.stringify(images.map(img => ({
        latitude: img.latitude ?? null,
        longitude: img.longitude ?? null,
        exifDatetime: img.exifDatetime ?? null,
      }))));

      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE}/upload${legacy ? '' : '?set=1'}`, { method: 'POST', body: form, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw Object.assign(new Error(err.error ?? 'Upload failed'), { status: res.status });
      }
      return res.json();
    },
  };
}

// Unauthenticated singleton for public-only queries (no token needed)
export const api = createApi(async () => null);
