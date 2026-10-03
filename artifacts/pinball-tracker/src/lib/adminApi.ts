import { useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import { request, type Challenge } from './api';

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
    /** AI model calls (ai_usage) over the last 30 days; null = couldn't be read. */
    ai: AiUsageSummary | null;
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

/** One provider + model, last 30 days ("today" = the New York day, like the overview's other counts). */
export interface AiUsageLine {
  provider: string; model: string;
  callsToday: number; calls30d: number; errorsToday: number; errors30d: number;
  inputToday: number; outputToday: number; input30d: number; output30d: number;
  costToday: number; cost30d: number;
  /** Calls with no price on file — the cost shown is then a floor. */
  unpriced30d: number;
  lastAt: string | null;
}

export interface AiUsageSummary {
  totals: Omit<AiUsageLine, 'provider' | 'model'>;
  byModel: AiUsageLine[];
}

export type RetentionTier ='high_volume' | 'standard' | 'admin';

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
  /** `color` = what it's drawn in (its series' color for a tier); `ownColor` = its own column. */
  id: number; key: string; name: string; description: string; icon: string; color: string; ownColor: string;
  seriesId: number | null;
  imageVersion: number | null; hasImage: boolean;
  kind: BadgeKind; metric: string | null; threshold: number | null; rule: BadgeRule | null;
  retroactive: boolean; status: BadgeStatus;
  availableFrom: string | null; availableTo: string | null; activatedAt: string | null;
  sortOrder: number; createdAt: string; updatedAt: string;
  requirement: string; earnedCount: number; metricAvailable: boolean; activationBlocker: string | null;
}

/** A badge series (ladder). One color for every tier; `sortOrder` shares the top-level order with singles. */
export interface AdminBadgeSeries {
  id: number; key: string; name: string; color: string; sortOrder: number; badgeCount: number;
  /** How the tiers' descriptions read, with {N} for the threshold ("Posted {N} scores."); null = none. */
  descriptionTemplate: string | null;
  /** What its tiers with a threshold count — one metric per series. null = none yet (any metric may be first). */
  metric: string | null;
  /** Its tiers with a threshold already count different metrics (from before the rule) — never auto-fixed. */
  metricConflict: SeriesMetricConflict | null;
}

/** A series whose metric tiers disagree (badgeSeries.seriesMetricConflict on the api-server). */
export interface SeriesMetricConflict {
  seriesMetric: string; seriesMetricLabel: string;
  metrics: Array<{ metric: string; label: string; badges: Array<{ id: number; name: string }> }>;
  offenders: Array<{ id: number; name: string; metric: string; label: string }>;
  message: string;
}

/** "Add tier" on a series: the new badge's prefill (GET /admin/badge-series/:id/new-tier). */
export interface NewTierDraft {
  seriesId: number;
  /** null = an empty series — keep the editor's defaults. */
  kind: BadgeKind | null;
  metric: string | null; threshold: number | null; rule: BadgeRule | null; icon: string | null; color: string;
  description: string; descriptionFrom: 'template' | 'copied' | 'none';
  /** Suggested from the top tier's key when free, else ''. */
  key: string;
  /** The Ns the suggested threshold stepped up from. */
  basedOn: number[];
}

export type BadgeSeriesInput = { name?: string; color?: string; descriptionTemplate?: string | null };

/** One draggable row of /admin/badges: a whole series or a single badge. */
export type BadgeOrderItem = { type: 'series' | 'badge'; id: number };

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
  /** null = a single. Omitted on create = the metric's series, when it has exactly one. */
  seriesId: number | null;
  newSeries: { name: string; color: string };
}>;

// Site content (Admin > Config > Welcome page). The spec comes from the server (CONTENT_SPEC in
// api-server src/lib/siteContent.ts) and the editor builds its form from it.
export type ContentTextKind = 'plain' | 'inline' | 'markdown' | 'url' | 'email' | 'icon';
export interface ContentTextSpec { type: 'text'; kind: ContentTextKind; label: string; max: number; required: boolean; help?: string }
export interface ContentListSpec { type: 'list'; label: string; itemLabel: string; min: number; max: number; fields: Record<string, ContentTextSpec> }
export type ContentFieldSpec = ContentTextSpec | ContentListSpec;
export interface ContentSectionSpec { title: string; help?: string; fields: Record<string, ContentFieldSpec> }
export interface ContentSection {
  key: string;
  spec: ContentSectionSpec;
  /** The stored override; null = the page shows its built-in default. */
  value: Record<string, unknown> | null;
  updatedAt: string | null;
  updatedBy: UserRef | null;
}

// Announcements (/api/admin/announcements, routes/adminAnnouncements.ts on the api-server). Plain
// text; the link is an in-app path ({username} = each recipient's), validated by the server.
export type AnnouncementAudience = 'all' | 'users';
export interface AnnouncementDraft {
  title: string; body: string; link: string | null;
  audience: AnnouncementAudience;
  /** Only for audience 'users'. */
  userIds?: number[];
}
export interface AnnouncementLimits {
  titleMax: number; bodyMax: number; linkMax: number; maxPicked: number; linkRoots: string[]; sendsPerHour: number;
}
export interface AnnouncementSkipped { id: number; username: string | null; reason: 'disabled' | 'unknown' }
export interface AnnouncementDuplicate { announcementId: string; at: string; reason: 'request' | 'recent' }
export interface AnnouncementPreview {
  normalized: { title: string; body: string; link: string | null };
  audience: AnnouncementAudience;
  recipientCount: number;
  sample: UserRef[];
  skipped: AnnouncementSkipped[];
  duplicateOf: AnnouncementDuplicate | null;
}
export interface AnnouncementSendResult { announcementId: string; sent: number; skipped: AnnouncementSkipped[] }
export interface AnnouncementHistoryItem {
  id: number; announcementId: string; sentAt: string; sentBy: UserRef | null;
  title: string; body: string; link: string | null; audience: AnnouncementAudience; recipientCount: number;
  /** Live: notifications still there (read ones go after 30 days; players can Clear all). */
  delivered: number; unread: number;
  retractedAt: string | null; retracted: number | null;
}

// Machine merge — "Fix this machine" on the machine page (/api/admin/machines/:id/*, routes/adminMachines.ts
// and lib/machineMerge.ts on the api-server). Targets come from the stored Pinball Map catalog or
// existing machine rows; the server never calls Pinball Map for this.
export interface MachineBrief {
  /** null = a catalog title with no TiltTrack row yet — the merge creates it. */
  id: number | null;
  name: string; manufacturer: string | null; year: number | null; imageUrl: string | null; opdbId: string | null;
}
export interface MergeCandidate {
  name: string; machineId: number | null; scoreCount: number; inCatalog: boolean;
  manufacturer: string | null; year: number | null; imageUrl: string | null;
}
export interface MergeCandidates {
  source: MachineBrief & { scoreCount: number };
  suggestion: (MergeCandidate & { confidence: string }) | null;
  results: MergeCandidate[];
  catalogAvailable: boolean;
}
export interface MergeTarget { targetId?: number; targetName?: string }
export interface MachineMergePreview {
  source: MachineBrief;
  target: MachineBrief;
  titlesMatch: boolean;
  scoreCount: number;
  players: Array<{ userId: number; username: string; scoreCount: number }>;
  history: { rows: number; merged: number };
  inventory: { rows: number; merged: number };
  picks: { rows: number; dropped: number };
  challenges: Array<{ id: number; status: string; type: string }>;
  lockedScores: number;
  badges: Array<{ id: number; name: string; status: string }>;
  refs: Record<string, number>;
  blocker: { code: string; message: string; challengeIds?: number[]; refs?: Record<string, number> } | null;
}
export interface MachineMergeResult {
  merged: true;
  source: { id: number; name: string };
  target: { id: number; name: string };
  targetCreated: boolean;
  scoresMoved: number;
  challengesRepointed: number[];
  badgesRepointed: number[];
  recount: { challengesSynced: number; scoresChecked: number; errors: number };
}

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
    /** Any challenge's full detail, read-only (`adminView: true`) — for one the admin isn't in. */
    challenge: (id: number) => get<Challenge>(`/admin/challenges/${id}`),
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
    badges: () => get<{ items: AdminBadge[]; series: AdminBadgeSeries[]; order: BadgeOrderItem[]; limits: Record<string, number>; image: { maxBytes: number; size: number; types: string[] } }>('/admin/badges'),
    reorderBadges: (items: BadgeOrderItem[]) => put<{ order: BadgeOrderItem[]; changed: number }>('/admin/badges/order', { items }),
    createBadgeSeries: (body: BadgeSeriesInput & { name: string; color: string }) => post<{ series: AdminBadgeSeries }>('/admin/badge-series', body),
    updateBadgeSeries: async (id: number, body: BadgeSeriesInput) =>
      request<{ series: AdminBadgeSeries }>(`/admin/badge-series/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
    /** Every tier of the series in the new order; tiers with a threshold must stay in ascending N. */
    reorderSeriesTiers: (id: number, ids: number[]) => put<{ ids: number[]; changed: number }>(`/admin/badge-series/${id}/order`, { ids }),
    newTierDraft: (id: number) => get<{ draft: NewTierDraft }>(`/admin/badge-series/${id}/new-tier`),
    deleteBadgeSeries: (id: number) => del<{ ok: true }>(`/admin/badge-series/${id}`),
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
    siteContent: () => get<{ sections: ContentSection[] }>('/admin/content'),
    /** 400 `invalid_content` carries per-field `errors` ({"steps.1.body": "…"}) on the thrown error's body. */
    saveSiteContent: (key: string, value: Record<string, unknown>) =>
      put<Omit<ContentSection, 'spec'>>(`/admin/content/${encodeURIComponent(key)}`, { value }),
    announcementLimits: () => get<AnnouncementLimits>('/admin/announcements/limits'),
    /** 400 `invalid_announcement` carries per-field `errors` ({title, body, link}) on the thrown error's body. */
    previewAnnouncement: (d: AnnouncementDraft) => post<AnnouncementPreview>('/admin/announcements/preview', d),
    /** 409 `recipient_count_changed` (recipientCount) / `duplicate_send` (duplicateOf); 429 `rate_limited`. */
    sendAnnouncement: (d: AnnouncementDraft & { confirmCount: number; requestId: string; allowDuplicate?: boolean }) =>
      post<AnnouncementSendResult>('/admin/announcements', d),
    announcements: (before?: number | null) => get<Paged<AnnouncementHistoryItem>>(`/admin/announcements${qs({ before })}`),
    retractAnnouncement: (announcementId: string) =>
      del<{ announcementId: string; removed: number }>(`/admin/announcements/${encodeURIComponent(announcementId)}`),
    mergeCandidates: (machineId: number, q = '') => get<MergeCandidates>(`/admin/machines/${machineId}/merge-candidates${qs({ q })}`),
    /** Reads only. A refusal is `preview.blocker`; a different title is `titlesMatch: false`. */
    previewMachineMerge: (machineId: number, target: MergeTarget) =>
      post<{ preview: MachineMergePreview }>(`/admin/machines/${machineId}/merge`, { ...target, dryRun: true }),
    /** 409 `titles_differ` (needs confirmDifferentTitle) / `merge_stale` / a blocker code. */
    mergeMachine: (machineId: number, body: MergeTarget & { expectedScoreCount: number; confirmDifferentTitle?: boolean }) =>
      post<MachineMergeResult>(`/admin/machines/${machineId}/merge`, body),
    resetSiteContent: (key: string) => del<Omit<ContentSection, 'spec'> & { removed: boolean }>(`/admin/content/${encodeURIComponent(key)}`),
  };
}

export type AdminApi = ReturnType<typeof createAdminApi>;

export function useAdminApi(): AdminApi {
  const { getToken } = useAuth();
  return useMemo(() => createAdminApi(getToken), [getToken]);
}
