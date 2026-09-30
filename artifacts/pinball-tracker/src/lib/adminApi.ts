import { useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import { request } from './api';

// The admin area's API (GET/POST/DELETE /api/admin/*). Every call is authenticated; the server
// refuses anyone who isn't an admin. Kept out of api.ts so the admin area is one self-contained set
// of files.

export interface UserRef { id: number; username: string; displayName: string }

export interface ClerkActivity { lastSignInAt: string | null; lastActiveAt: string | null; banned: boolean }

export interface Paged<T> { items: T[]; nextBefore: number | null }

export interface AdminOverview {
  counts: {
    users: number; disabled_users: number; new_users_7d: number;
    scores: number; scores_today: number; scores_7d: number; full_photos: number; thumbnails: number;
    friendships: number; pending_requests: number; pods: number;
    active_challenges: number; pending_challenges: number;
    notifications_today: number; notifications_unread: number;
    events: number; events_since: string | null;
  };
  activeUsers: { clerk7d: number | null; clerk30d: number | null; app7d: number; app30d: number };
  health: {
    pm: {
      mode: string; liveCallsToday: number; breakerOpenUntil: string | null; breakerReason: string | null;
      catalog: { machineCount: number; fetchedAt: string | null; stale: boolean; lastError: string | null } | null;
    };
    r2: { configured: boolean };
    clerkWebhook: { configured: boolean };
    clerkApi: { reachable: boolean };
    cron: {
      statSnapshot: string | null; challengeSweep: string | null;
      activityRetention: RetentionLastRun | null;
      photoOrphans: PhotoOrphanSummary;
    };
  };
}

export type RetentionTier = 'high_volume' | 'standard' | 'admin';

/** Per tier: -1 = keep forever, 0 = don't record (existing rows purged next run), 1–36500 = days. */
export interface RetentionSettings { highVolumeDays: number; standardDays: number; adminDays: number }

export interface RetentionLastRun {
  at: string;
  deleted: Record<RetentionTier, number> | null;
  total: number;
  capped: boolean;
  errors: number;
}

export interface RetentionView {
  settings: RetentionSettings;
  defaults: RetentionSettings;
  limits: Record<keyof RetentionSettings, { min: number; max: number; forever: number; off: number }>;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: UserRef | null;
  /** days: null = kept forever, 0 = not recorded (every row is eligible), N = days. */
  tiers: Array<{ tier: RetentionTier; days: number | null; rows: number; oldest: string | null; eligible: number }>;
  typesByTier: Record<RetentionTier, string[]>;
  defaultTier: RetentionTier;
  adminPrefix: string;
  lastRun: RetentionLastRun | null;
}

export interface PhotoOrphanSummary {
  lastRun: {
    at: string; trigger: 'cron' | 'admin' | 'cli'; dryRun: boolean; listed: number; orphans: number; orphanBytes: number;
    deleted: number; failed: number; skippedReferenced: number; capped: boolean;
  } | null;
  lastDeleteRunAt: string | null;
  nextDueAt: string | null;
  dueNow: boolean;
}

export interface PhotoOrphanStatus extends PhotoOrphanSummary { configured: boolean; envMismatch: string | null }

export interface PhotoOrphanRunResult {
  dryRun: boolean; bucket: string; minAgeHours: number; listed: number; referenced: number;
  orphans: number; orphanBytes: number; deleted: number; failed: number; skippedReferenced: number; capped: boolean;
  sampleScoreIds: number[]; ms: number;
}

export interface AdminUserRow extends UserRef {
  role: 'admin' | 'user';
  createdAt: string;
  pinballMapUsername: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  scoreCount: number;
  lastScoreAt: string | null;
  friendCount: number;
  clerk: ClerkActivity | null;
}

export interface ActivityEvent {
  id: number;
  createdAt: string;
  type: string;
  category: string;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, any>;
  ip: string | null;
  userAgent: string | null;
  actor: UserRef | null;
  subject: UserRef | null;
}

export interface AdminScore {
  id: number; score: number; playedAt: string; createdAt: string; type: string;
  venueId: number | null; venueName: string | null;
  photoThumbnail: string | null; hasFullPhoto: boolean; photoBytes: number | null;
  machine: { id: number; name: string };
  user: UserRef;
  lockedBy: number[];
}

export interface AdminChallenge {
  id: number; type: string; status: string; createdAt: string; startsAt: string | null; endsAt: string; resolvedAt: string | null;
  targetScore: number | null; minPlays: number | null;
  adminCancelledAt: string | null; adminCancelReason: string | null;
  machine: { id: number; name: string };
  venue: { id: number; name: string } | null;
  creator: UserRef;
  participants: Array<{ response: string; outcome: string | null; rank: number | null; user: UserRef }>;
}

export interface AdminFriendship {
  id: number; status: 'pending' | 'accepted' | 'declined'; declineCount: number; createdAt: string; respondedAt: string | null;
  requester: UserRef; addressee: UserRef;
}

export interface AdminNotification {
  id: number; kind: string; payload: Record<string, any>; createdAt: string; readAt: string | null; user: UserRef;
}

export interface AdminUserDetail {
  user: UserRef & {
    role: 'admin' | 'user'; createdAt: string; clerkUserId: string; pinballMapUsername: string | null; hasPmToken: boolean;
    disabledAt: string | null; disabledReason: string | null; disabledBy: UserRef | null;
  };
  clerk: ClerkActivity | null;
  clerkAvailable: boolean;
  counts: { scores: number; full_photos: number; notifications: number; unread_notifications: number; owned_venues: number };
  friendships: Array<{ id: number; status: string; declineCount: number; createdAt: string; respondedAt: string | null; outgoing: boolean; other: UserRef }>;
  pods: {
    owned: Array<{ id: number; name: string; color: string; createdAt: string; memberCount: number }>;
    memberOf: Array<{ podId: number; name: string; owner: UserRef }>;
  };
  challenges: AdminChallenge[];
  recentScores: AdminScore[];
  activity: Paged<ActivityEvent>;
}

export type ActionResponse = Record<string, any>;

// ── badges (/api/admin/badges, routes/adminBadges.ts on the api-server) ─────

export type BadgeKind = 'metric' | 'rule' | 'manual';
export type BadgeStatus = 'draft' | 'live' | 'retired';

/** The rule vocabulary (badgeRules.ts). Every condition present must hold. */
export interface BadgeRule {
  localDate?: { from: string; to: string };
  daysOfWeek?: number[];
  localTime?: { from: string; to: string };
  postedWithinHours?: number;
  machine?: { machineId: number; matchMode: 'group' | 'exact'; matchGroup?: string | null; name?: string };
  venueId?: number;
  city?: string;
  state?: string;
  minScore?: number;
  scoreType?: 'casual' | 'tournament';
  requiresPhoto?: boolean;
  count?: number;
  distinct?: 'none' | 'machine' | 'venue';
}

export interface AdminBadge {
  id: number; key: string; name: string; description: string; icon: string; color: string;
  imageVersion: number | null; hasImage: boolean;
  kind: BadgeKind; metric: string | null; threshold: number | null; rule: BadgeRule | null;
  retroactive: boolean; status: BadgeStatus;
  availableFrom: string | null; availableTo: string | null; activatedAt: string | null;
  sortOrder: number; createdAt: string; updatedAt: string;
  requirement: string; earnedCount: number; metricAvailable: boolean; activationBlocker: string | null;
}

export interface BadgeMetricInfo {
  key: string; label: string; description: string; source: 'derived' | 'marks'; triggers: string[]; available: boolean;
}

export interface BadgeHolder {
  earnedAt: string; note: string | null; sourceScoreId: number | null; sourceChallengeId: number | null;
  user: UserRef; grantedBy: UserRef | null;
}

export interface BadgePreview {
  kind: BadgeKind; retroactive: boolean; outsideWindow: boolean; total: number; newCount: number;
  qualifying: Array<{ user: UserRef; value: number | null; sourceScoreId: number | null; alreadyHas: boolean }>;
}

/** Create/PATCH body. Dates are ISO strings or null. */
/** PATCH's `backfill`: set when the edit turned retroactive on for a live badge (the server backfilled). */
export type BadgeBackfillResult = { awarded: number; skippedWindow: boolean } | { failed: true; error: string };

export type BadgeInput = Partial<{
  key: string; name: string; description: string; icon: string; color: string; kind: BadgeKind;
  metric: string | null; threshold: number | null; rule: BadgeRule | null; retroactive: boolean;
  availableFrom: string | null; availableTo: string | null; sortOrder: number;
}>;

function qs(params: Record<string, string | number | null | undefined | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function createAdminApi(getToken: () => Promise<string | null>) {
  const tok = () => getToken();
  const get = async <T,>(path: string) => request<T>(path, undefined, await tok());
  const post = async <T,>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, await tok());
  const del = async <T,>(path: string) => request<T>(path, { method: 'DELETE' }, await tok());
  const put = async <T,>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }, await tok());
  return {
    overview: () => get<AdminOverview>('/admin/overview'),
    users: (q = '', filter = 'all') => get<{ clerkAvailable: boolean; items: AdminUserRow[] }>(`/admin/users${qs({ q, filter: filter === 'all' ? null : filter })}`),
    user: (id: number) => get<AdminUserDetail>(`/admin/users/${id}`),
    updateUser: async (id: number, data: { role?: string; displayName?: string; username?: string }) =>
      request<any>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, await tok()),
    disableUser: (id: number, reason: string) => post<ActionResponse>(`/admin/users/${id}/disable`, { reason }),
    enableUser: (id: number) => post<ActionResponse>(`/admin/users/${id}/enable`),
    clearNotifications: (userId: number) => del<ActionResponse>(`/admin/users/${userId}/notifications`),
    activity: (f: { type?: string; category?: string; userId?: number | null; from?: string; to?: string; before?: number | null; limit?: number }) =>
      get<Paged<ActivityEvent>>(`/admin/activity${qs(f)}`),
    activityTypes: () => get<Record<string, string[]>>('/admin/activity/types'),
    friendships: (status: string | null, before?: number | null) =>
      get<Paged<AdminFriendship> & { summary: Array<{ status: string; n: number; declines: number }> }>(`/admin/friendships${qs({ status, before })}`),
    removeFriendship: (id: number) => del<ActionResponse>(`/admin/friendships/${id}`),
    challenges: (status: string | null, before?: number | null) => get<Paged<AdminChallenge>>(`/admin/challenges${qs({ status, before })}`),
    voidChallenge: (id: number, reason: string) => post<ActionResponse>(`/admin/challenges/${id}/void`, { reason }),
    notifications: (f: { userId?: number | null; unread?: boolean; before?: number | null }) =>
      get<Paged<AdminNotification> & { summary: { total: number; unread: number; today: number } }>(`/admin/notifications${qs({ userId: f.userId, unread: f.unread ? 1 : null, before: f.before })}`),
    deleteNotification: (id: number) => del<ActionResponse>(`/admin/notifications/${id}`),
    scores: (f: { userId?: number | null; photo?: string | null; before?: number | null }) => get<Paged<AdminScore>>(`/admin/scores${qs(f)}`),
    deleteScore: (id: number) => del<ActionResponse>(`/admin/scores/${id}`),
    deleteFullPhoto: (id: number) => del<ActionResponse>(`/admin/scores/${id}/photo`),
    deleteThumbnail: (id: number) => del<ActionResponse>(`/admin/scores/${id}/thumbnail`),
    retention: () => get<RetentionView>('/admin/settings/retention'),
    saveRetention: (s: RetentionSettings) => put<RetentionView>('/admin/settings/retention', s),
    photoOrphans: () => get<PhotoOrphanStatus>('/admin/photo-orphans'),
    runPhotoOrphans: (dryRun: boolean) => post<PhotoOrphanRunResult>('/admin/photo-orphans/run', { dryRun }),
    badges: () => get<{ items: AdminBadge[]; limits: Record<string, number>; image: { maxBytes: number; size: number; types: string[] } }>('/admin/badges'),
    badge: (id: number) => get<{ badge: AdminBadge; holders: BadgeHolder[] }>(`/admin/badges/${id}`),
    badgeMetrics: () => get<BadgeMetricInfo[]>('/admin/badges/metrics'),
    createBadge: (body: BadgeInput) => post<{ badge: AdminBadge }>('/admin/badges', body),
    updateBadge: async (id: number, body: BadgeInput) =>
      request<{ badge: AdminBadge; backfill?: BadgeBackfillResult | null }>(`/admin/badges/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
    uploadBadgeImage: async (id: number, file: File) => {
      const form = new FormData();
      form.append('image', file);
      return request<{ imageVersion: number; bytes: number }>(`/admin/badges/${id}/image`, { method: 'POST', body: form }, await tok());
    },
    deleteBadgeImage: (id: number) => del<{ imageVersion: null }>(`/admin/badges/${id}/image`),
    previewBadge: (id: number) => post<BadgePreview>(`/admin/badges/${id}/preview`),
    activateBadge: (id: number) => post<{ awarded: number; skippedWindow: boolean }>(`/admin/badges/${id}/activate`),
    backfillBadge: (id: number) => post<{ awarded: number; skippedWindow: boolean }>(`/admin/badges/${id}/backfill`),
    retireBadge: (id: number) => post<ActionResponse>(`/admin/badges/${id}/retire`),
    grantBadge: (id: number, userIds: number[], note: string) => post<{ granted: number; alreadyHad: number }>(`/admin/badges/${id}/grants`, { userIds, note }),
    revokeBadge: (id: number, userId: number, reason: string) => del<ActionResponse>(`/admin/badges/${id}/grants${qs({ userId, reason })}`),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

export function useAdminApi(): AdminApi {
  const { getToken } = useAuth();
  return useMemo(() => createAdminApi(getToken), [getToken]);
}
