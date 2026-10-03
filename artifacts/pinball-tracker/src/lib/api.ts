import { APP_BUILD_ID } from './appVersion';

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export async function request<T>(path: string, init?: RequestInit, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (init?.headers) Object.assign(headers, init.headers);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Which build sent this — recorded on score.created, so a stale tab shows up in the activity log.
  headers['X-App-Version'] = APP_BUILD_ID;

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

/**
 * `GET /api/machines/:id/venues` — venues where scores on this machine have been logged (only scores
 * you may see), most recently played first. Others' private venues are never named: they only add
 * to `privateCount`. `home` = your own. `lastPlayedAt` is an ISO instant.
 */
export interface MachineVenues {
  machine: { id: number; name: string };
  venues: Array<{ id: number; name: string; address: string | null; home: boolean; scoreCount: number; lastPlayedAt: string }>;
  privateCount: number;
  /** venues.length + privateCount — the Machines page pill's number. */
  venueCount: number;
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
    | 'challenge_opponent_scored' | 'challenge_ending_soon' | 'challenge_result' | 'challenge_voided'
    | 'challenge_countered' | 'challenge_counter_accepted' | 'challenge_counter_rejected' | 'challenge_moved'
    | 'challenge_started' | 'challenge_missed'
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
/**
 * `countered`: a counter-offer on it was taken (everyone moved to the new machine) — or, for an older
 * row, it was answered with one. `proposed` / `rejected` / `lapsed`: a counter-offer row — a
 * suggestion to the challenger, open / not taken / closed on its own. The server maps those three
 * onto the old phases (pending / declined / expired), so read `status` to tell them apart.
 */
export type ChallengeStatus = 'pending' | 'active' | 'resolved' | 'declined' | 'cancelled' | 'expired' | 'countered'
  | 'proposed' | 'rejected' | 'lapsed';
export type ChallengePhase = 'pending' | 'scheduled' | 'live' | 'ended' | 'resolved' | 'declined' | 'cancelled' | 'expired' | 'countered';
/** `missed`: never answered — it started (or expired) without them. */
export type ChallengeResponse = 'pending' | 'accepted' | 'declined' | 'countered' | 'missed';
/**
 * Why an invitee said no. A counter-offer is always `cant_reach`; an older decline may have none.
 * `backed_out`: an accepted player left a group before it started — the server sets it, never a client.
 */
export type ChallengeDeclineReason = 'cant_reach' | 'no_thanks' | 'backed_out';
/** The reasons a decline body may give (the server 400s anything else, `backed_out` included). */
export type ChallengeDeclineChoice = Exclude<ChallengeDeclineReason, 'backed_out'>;
/** `abandoned`: a race nobody beat, or an average nobody qualified for — no winner, no loser. */
export type ChallengeOutcome = 'win' | 'loss' | 'tie' | 'forfeit' | 'no_show' | 'abandoned' | (string & {});

export interface ChallengeParticipant {
  user: PodUser;
  isCreator: boolean;
  response: ChallengeResponse;
  /** Newer servers only. */
  declineReason?: ChallengeDeclineReason | null;
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
  scores?: Array<{ id: number; score: number; playedAt: string; createdAt: string; venueId: number | null; venueName: string | null; venueTimezone: string | null; hasFullPhoto?: boolean; hasThumbnail?: boolean }>;
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
  /** This one is a counter-offer to that challenge. Newer servers only. */
  counteredFromId?: number | null;
  /** This one was countered: the counter-offer's id. Newer servers only. */
  counteredToId?: number | null;
  /** A counter-offer row (status proposed / rejected / lapsed) the challenger decides. Group servers only. */
  isProposal?: boolean;
  /** Who suggested it (a proposal, or a challenge that started as one). */
  proposedBy?: PodUser | null;
  /** Counter-offers on this challenge you may see: all of them for the challenger, your own for a proposer. */
  proposals?: ChallengeProposal[];
  /** Players still in it (accepted + not yet answered); once started, those who accepted. */
  playerCount?: number;
  maxPlayers?: number;
  timeLeftMs: number | null;
  startsInMs: number | null;
  /** Only from GET /api/admin/challenges/:id: an admin who isn't in it, reading it. `me` is then read-only (response null, every can* false). */
  adminView?: boolean;
  me: {
    /** null only in an admin view. */
    response: ChallengeResponse | null; outcome: ChallengeOutcome | null; canAccept: boolean; canDecline: boolean; canCounter?: boolean; canCancel: boolean; canForfeit: boolean;
    /** "Start with who's in" — the challenger, once someone accepted. */
    canStart?: boolean;
    /** A proposal waiting on you: accept = take it for everyone, decline = keep yours. */
    canDecideProposal?: boolean;
  };
  opponent: PodUser | null;
  participants: ChallengeParticipant[];
}

/** A counter-offer on a challenge (Challenge.proposals). */
export interface ChallengeProposal {
  id: number;
  status: ChallengeStatus;
  proposedBy: PodUser | null;
  type: ChallengeType;
  matchMode: 'game' | 'exact';
  machine: { id: number; name: string; imageUrl: string | null };
  venue: { id: number; name: string } | null;
  targetScore: number | null;
  minPlays: number | null;
  startsAt: string | null;
  endsAt: string;
  createdAt: string;
  decidedAt: string | null;
}

/** One machine the create form recommends for a friend (GET /api/challenges/recommendations/:username). */
export interface ChallengeRecommendation {
  machineId: number;
  name: string;
  variant: string | null;
  imageUrl: string | null;
  /** 1 = "Challenge me on", 2 = at a venue they can reach, 3 = played lately. */
  level: 1 | 2 | 3;
  /** Level 2: a public venue's name, or 'at home' (their own private venue). Never a private venue's name. */
  venueLabel?: string;
  /** You can reach it too (your "Challenge me on" machines or your challenge locations). */
  viewerCanReach: boolean;
  /** You only scored on it lately (not somewhere you can reach) — "You played it lately". */
  viewerPlayedLately?: boolean;
  /** Your best score on this exact machine. */
  viewerBest?: number;
  /** Group recommendations only: which of the friends can reach it, and how many. */
  reachedBy?: number[];
  coverage?: number;
  /** Group recommendations only: it's at these friends' own homes ("at @name's"). */
  atHomeOf?: number[];
}

// ── Last Resort area + Expand search (feature/last-resort) ──────────────────────────────────────
/** GET /api/challenges/recommendations/:username's `expand`: whether Expand search can find anything. */
export interface ChallengeExpandHint {
  /** Either of you has a Last Resort area. */
  available: boolean;
  /** …and you can reach fewer than 2 of the recommendations — show the prominent button. */
  suggested: boolean;
  /** You have an area. */
  mine: boolean;
  /** They have one. */
  theirs: boolean;
}

/** Your own Last Resort area (GET/PUT/DELETE /api/me/challenge-area). Never coordinates. */
export interface ChallengeArea {
  postalCode: string;
  radiusMiles: number;
  /** "Dennis, MA" */
  label: string | null;
  updatedAt: string;
}
export interface ChallengeAreaResponse { area: ChallengeArea | null; radiusChoices: number[] }

/** One of your spots in an Expand match: a Pinball Map location near you (link = attribution). */
export interface ChallengeAreaSpot { pmLocationId: number; name: string; city: string | null; miles: number; url: string }

/** One Expand search match: a machine (exact model) you and the friend can both get to. */
export interface ChallengeAreaMatch {
  /** Null when TiltTrack has no row for it yet — `expandMachine` creates it when picked. */
  machineId: number | null;
  pmMachineId: number;
  name: string;
  manufacturer: string | null;
  year: number | null;
  imageUrl: string | null;
  viewerBest?: number;
  /** Your side: your spots (nearest 3, with the total), or a recommendation level when you have no area. */
  mine: { kind: 'area'; spotCount: number; spots: ChallengeAreaSpot[] } | { kind: 'reach'; level: 1 | 2 | 3 };
  /** Their side: a count only (plus `theirPlace`), or a level — never where. */
  theirs: { kind: 'area'; spotCount: number } | { kind: 'reach'; level: 1 | 2 | 3 };
}

/** POST /api/challenges/recommendations/:username/expand */
export interface ChallengeExpandResult {
  user: PodUser;
  matches: ChallengeAreaMatch[];
  areas: { mine: 'ok' | 'none' | 'unavailable'; theirs: 'ok' | 'none' | 'unavailable' };
  /** Their area's city ("Portland, OR"), when their area was used. */
  theirPlace: string | null;
  /** When the Pinball Map data was fetched (ISO). */
  asOf: string | null;
  stale: boolean;
}

/** A machine on someone's "Challenge me on" list (profile + prefs). */
export interface ChallengeMeMachine { id: number; name: string; variant: string | null; imageUrl: string | null }

/** A venue in your own challenge-locations list or its suggestions. Only ever your own. */
export interface ChallengePrefVenue { id: number; name: string; isPrivate: boolean; isHome: boolean; source?: 'auto' | 'added' }

/** GET /api/me/challenge-venue-search — TiltTrack venues you could add (public, yours, or scored at). */
export interface ChallengeVenueHit { id: number; name: string; city: string | null; state: string | null; isPrivate: boolean; isHome: boolean }

/** GET/PUT /api/me/challenge-prefs */
export interface ChallengePrefs {
  machines: Array<ChallengeMeMachine & { manufacturer: string | null; year: number | null }>;
  venues: ChallengePrefVenue[];
  suggestions: ChallengePrefVenue[];
  limits: { machines: number; venues: number };
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
  /** Longest run of losses. Newer servers only. */
  bestLossStreak?: number;
  /** Your own record: every opponent. Someone else's: only their record against you. Pairwise by rank in groups. */
  headToHead: Array<RecordCounts & { opponent: PodUser }>;
}

export interface CreateChallengeBody {
  /** Up to 7 friends (8 players with you). */
  friendIds?: number[];
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

/** A signed, short-lived link to a score's full-size photo (GET /api/scores/:id/photo). */
/**
 * How a score fared in one of its author's challenges on the same machine — POST /api/scores and
 * PATCH /api/scores/:id return a list of these as `challenges` (older servers omit it). The server
 * decides with the same rules as the standings (challengeRules.ts scoreChallengeFits).
 */
export type ChallengeFitReason =
  | 'counted' | 'not_started'
  | 'wrong_venue' | 'no_photo' | 'played_before_start' | 'played_after_end'
  | 'posted_before_start' | 'posted_after_end' | 'not_visible' | 'played_in_future' | (string & {});
export interface ChallengeFit {
  challengeId: number;
  machineName: string;
  type: ChallengeType;
  status: 'counted' | 'not_counted' | 'not_started' | (string & {});
  reason: ChallengeFitReason;
  startsAt: string | null;
  endsAt: string;
  /** The venue a venue-locked challenge counts at. */
  venueName: string | null;
  /** The other accepted players' display names. */
  opponents: string[];
}

export interface FullPhotoLink {
  /** Signed R2 URL, or null for a thumbnail-only score (then `thumbnail` is its data URL). */
  url: string | null;
  width: number | null;
  height: number | null;
  expiresAt: string | null;
  thumbnail: string | null;
  /** The viewer owns the score and an upload would be accepted — the only gate for the upload button. */
  canUpload: boolean;
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
      // playedAtReason: required when an admin changes a photo/video (camera-recorded) played time.
      patch: async (id: number, body: { score?: number; type?: string; playedAt?: string; playedAtReason?: string; machineId?: number; venueId?: number | null }) =>
        request<{ id: number; playedAt: string; challenges?: ChallengeFit[] } & Record<string, unknown>>(`/scores/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/scores/${id}`, { method: 'DELETE' }, await tok()),

      // Per-score repair — venue linkage state plus ranked machine candidates for this one score.
      repair: {
        status: async (id: number) =>
          request<any>(`/scores/${id}/repair`, undefined, await tok()),
        machine: async (id: number, body: { pmName: string; pmManufacturer?: string | null; pmYear?: number | null }) =>
          request<any>(`/scores/${id}/repair/machine`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
      },

      // Full-size photo on Cloudflare R2 (see src/lib/fullSizePhoto.ts). `photo` works signed out
      // too — the server applies the same visibility rule as the score lists and signs a short-lived
      // URL; an <img> can't carry our bearer token, which is why this isn't a redirect.
      photo: async (id: number) =>
        request<FullPhotoLink>(`/scores/${id}/photo`, undefined, await tok()),
      photoUploadUrl: async (id: number) =>
        request<{ key: string; url: string; expiresIn: number }>(`/scores/${id}/photo/upload-url`, { method: 'POST' }, await tok()),
      photoConfirm: async (id: number, body: { key: string; width: number; height: number; variant?: 'full' | 'fallback'; fallbackReason?: string }) =>
        request<{ hasFullPhoto: true }>(`/scores/${id}/photo/confirm`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
      // A failed full-size upload, for the admin activity log (`photo.failed`) — see reportFullPhotoFailure.
      photoFailed: async (id: number, body: Record<string, unknown>) =>
        request<void>(`/scores/${id}/photo/failed`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
    },
    machines: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/machines?mine=true' : '/machines', undefined, await tok()),
      // `scopeQuery` comes from lib/comparisonScope.ts ('' | '?mine=true' | '?pod=<id>[&others=1]' |
      // '?friends=1[&others=1]'). A pod scope 404s `pod_not_found` unless the pod is the caller's own.
      get: async (name: string, scopeQuery = '') =>
        request<any>(`/machines/${encodeURIComponent(name)}${scopeQuery}`, undefined, await tok()),
      // Venues holding the machine (cached rosters + inventories only — no Pinball Map call).
      venues: async (id: number) =>
        request<MachineVenues>(`/machines/${id}/venues`, undefined, await tok()),
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
      // Self-service profile: display name only (the username is locked → 400 username_locked).
      // Field errors come back as `.code` (display_name_required / _too_long / _at) on the thrown error.
      updateMe: async (body: { displayName: string }) =>
        request<any>('/users/me', { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      // After Clerk's user.setProfileImage: re-read the photo from Clerk now (10/hour). Returns /me.
      syncAvatar: async () => request<any>('/users/me/avatar/sync', { method: 'POST' }, await tok()),
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
      // `decline` may say why ('cant_reach' | 'no_thanks') — stored, and passed on to the challenger.
      // An accepted player's decline is a back-out: stored as 'backed_out' whatever the body says.
      // On a proposal (you're the challenger): accept = take it for everyone, decline = keep yours.
      // `start` = "Start with who's in" (the challenger, once someone accepted).
      act: async (id: number, action: 'accept' | 'decline' | 'cancel' | 'forfeit' | 'start', body?: { reason?: ChallengeDeclineChoice }) =>
        request<Challenge>(`/challenges/${id}/${action}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, await tok()),
      // "Can't get to this one — how about this instead": a create body (no friend: it goes to the
      // original's creator). It's a suggestion to them: the original stays open until they take it
      // (then everyone moves to it) or keep theirs. The response's `counter` is that proposal.
      counter: async (id: number, body: Omit<CreateChallengeBody, 'friendId' | 'friendUsername' | 'friendIds'>) =>
        request<{ original: Challenge; counter: Challenge }>(`/challenges/${id}/counter`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
      // Machines to challenge this friend on, levels 1–3, each flagged when you can reach it too.
      // Friends only (403 not_friends). Never calls Pinball Map.
      recommendations: async (username: string) =>
        request<{ user: PodUser; recommendations: ChallengeRecommendation[]; expand?: ChallengeExpandHint }>(
          `/challenges/recommendations/${encodeURIComponent(username)}`, undefined, await tok()),
      // Last Resort "Expand search" — POST because it may ask Pinball Map (cached 7 days per area,
      // rate limited). Only ever on a tap. Friends only.
      expand: async (username: string) =>
        request<ChallengeExpandResult>(`/challenges/recommendations/${encodeURIComponent(username)}/expand`, { method: 'POST' }, await tok()),
      // Picking a match TiltTrack has no machine row for yet: the server makes it from its stored catalog.
      expandMachine: async (username: string, pmMachineId: number) =>
        request<{ id: number; name: string; imageUrl: string | null; manufacturer: string | null; year: number | null }>(
          `/challenges/recommendations/${encodeURIComponent(username)}/expand/machine`, { method: 'POST', body: JSON.stringify({ pmMachineId }) }, await tok()),
      // Your own Last Resort area: a US ZIP + radius. Owner-only.
      area: async () => request<ChallengeAreaResponse>('/me/challenge-area', undefined, await tok()),
      saveArea: async (body: { postalCode: string; radiusMiles: number }) =>
        request<ChallengeAreaResponse>('/me/challenge-area', { method: 'PUT', body: JSON.stringify(body) }, await tok()),
      clearArea: async () => request<ChallengeAreaResponse>('/me/challenge-area', { method: 'DELETE' }, await tok()),
      // Machines to challenge several friends on at once, ranked by how many of them can reach it.
      groupRecommendations: async (usernames: string[]) =>
        request<{ users: PodUser[]; recommendations: ChallengeRecommendation[] }>(
          `/challenges/recommendations?users=${usernames.map(encodeURIComponent).join(',')}`, undefined, await tok()),
      // Your own "Challenge me on" machines (max 3) and challenge locations. PUT replaces whichever
      // list is sent.
      prefs: async () => request<ChallengePrefs>('/me/challenge-prefs', undefined, await tok()),
      savePrefs: async (body: { machineIds?: number[]; venueIds?: number[] }) =>
        request<ChallengePrefs>('/me/challenge-prefs', { method: 'PUT', body: JSON.stringify(body) }, await tok()),
      searchVenues: async (q: string) =>
        request<ChallengeVenueHit[]>(`/me/challenge-venue-search?q=${encodeURIComponent(q)}`, undefined, await tok()),
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
      // Signed in only: the server serves ids linked to a venue, or ones it just returned to this
      // user (pm-match / nearby suggestions) — never an arbitrary id.
      pmMachines: async (pmId: number) => request<any>(`/venues/pm-machines/${pmId}`, undefined, await tok()),
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
      // `login` is the Pinball Map username OR email. The PM user token (and the email PM returns)
      // stay on the server; only the username comes back.
      auth: async (login: string, password: string) =>
        request<{ username: string }>(
          '/pinballmap/auth',
          { method: 'POST', body: JSON.stringify({ login, password }) },
          await tok()
        ),
      // Posts with the stored connection. A 401 with code `pm_reconnect_required` means the user
      // must connect (again) before posting.
      submitScore: async (body: { venueId: number; machineName: string; score: number }) =>
        request<{ success: true; machineName: string; xrefId: number; pmUsername: string | null }>(
          '/pinballmap/submit-score', { method: 'POST', body: JSON.stringify(body) }, await tok()
        ),
    },
    admin: {
      users: async () => request<any[]>('/admin/users', undefined, await tok()),
      health: async () => request<any>('/admin/health', undefined, await tok()),
      updateUser: async (id: number, data: { role?: string; displayName?: string; username?: string }) =>
        request<any>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, await tok()),
      stats: async () => request<any[]>('/admin/stats', undefined, await tok()),
      // Last 7 days only — the window is fixed server-side.
      statHistory: async () => request<any[]>('/admin/stats/history', undefined, await tok()),
      updateStat: async (id: number, body: { label?: string; description?: string }) =>
        request<any>(`/admin/stats/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      deleteStat: async (id: number) =>
        request(`/admin/stats/${id}`, { method: 'DELETE' }, await tok()),
      runStatSnapshot: async () =>
        request<{ periodDate: string; values: Record<string, number> }>('/admin/stats/snapshot', { method: 'POST' }, await tok()),
    },
    // One request for every photo of a score (1–3). Each photo's client-extracted GPS/timestamp goes
    // in the JSON `meta` field, index-aligned with `photos` (see prepareUploadImage.ts) — HEIC
    // conversion and the client-side downscale both strip EXIF, so that data can't be recovered
    // server-side from the uploaded files. When absent the server tries its own extraction.
    upload: async (images: Array<{ file: Blob; filename?: string; latitude?: number | null; longitude?: number | null; exifDatetime?: string | null; timeKind?: 'photo' | 'video'; heicFailed?: boolean }>) => {
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
        // A video frame's exifDatetime is its creationdate: the server signs it as a 'video' time.
        ...(img.timeKind === 'video' ? { timeKind: 'video' } : {}),
      }))));

      const headers: Record<string, string> = { 'X-App-Version': APP_BUILD_ID };
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
