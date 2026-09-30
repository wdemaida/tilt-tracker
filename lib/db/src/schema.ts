import { pgTable, serial, bigserial, text, bigint, timestamp, real, integer, pgEnum, uniqueIndex, index, primaryKey, date, boolean, jsonb, varchar, numeric, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const scoreTypeEnum = pgEnum('score_type', ['casual', 'tournament']);
export const userRoleEnum = pgEnum('user_role', ['admin', 'user']);
export const venuePrivacyEnum = pgEnum('venue_privacy', ['full', 'city_state', 'hidden']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  clerkId: text('clerk_id').unique().notNull(),
  username: text('username').unique().notNull(),
  displayName: text('display_name').notNull(),
  role: userRoleEnum('role').default('user').notNull(),
  pinballMapToken: text('pinball_map_token'),
  pinballMapUsername: text('pinball_map_username'),
  // The email Pinball Map returned from auth_details — PM's write endpoints need it alongside the
  // token (user_email + user_token, exact-case match). Never sent to the browser. (migrate18)
  pinballMapEmail: text('pinball_map_email'),
  // Admin "disable account" (migrate19). Set = requireAppUser answers 403 account_disabled and the
  // user is banned in Clerk so they can't sign in; null = active. Admins can't be disabled.
  disabledAt: timestamp('disabled_at'),
  disabledReason: text('disabled_reason'),
  disabledById: integer('disabled_by_id'),
  // When "Challenge locations" were first seeded from this user's history (migrate22). Seeding runs
  // once: after that a removed venue stays removed, and new candidates are only suggested.
  challengeVenuesSeededAt: timestamp('challenge_venues_seeded_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const machines = pgTable('machines', {
  id: serial('id').primaryKey(),
  name: text('name').unique().notNull(),
  opdbId: text('opdb_id'),
  ipdbId: text('ipdb_id'),
  variant: text('variant'),
  manufacturer: text('manufacturer'),
  year: integer('year'),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const venues = pgTable('venues', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  latitude: real('latitude'),
  longitude: real('longitude'),
  address: text('address'),
  hereId: text('here_id').unique(),
  pinballMapId: integer('pinball_map_id'),
  pmMachineCount: integer('pm_machine_count'),
  ownerId: integer('owner_id').references(() => users.id),
  // Who first put this venue into TiltTrack, as distinct from ownerId (which means "this is that
  // user's residence" and drives address privacy). A venue created by the photo-upload flow has no
  // owner but does have a creator — and the creator is who gets to repair its HERE/Pinball Map
  // linkage later, so an unresolved venue isn't stuck waiting on an admin.
  createdById: integer('created_by_id').references(() => users.id),
  isResidence: boolean('is_residence').default(false).notNull(),
  privacyTier: venuePrivacyEnum('privacy_tier').default('full').notNull(),
  city: text('city'),
  state: text('state'),
  cityLat: real('city_lat'),
  cityLng: real('city_lng'),
  // IANA zone name for where this venue physically is ("America/Chicago"), from HERE's `show=tz`.
  // A score is displayed in its venue's zone so the time always reads as the clock on the wall said
  // — and, more importantly, the venue's zone is what a photo's zone-less EXIF wall clock gets
  // interpreted in, which is the only way to store the right instant when you upload after
  // travelling home. Never store a UTC offset here: an offset is wrong for half the year.
  timezone: text('timezone'),
  // The Edit Venue dialog's "Show my machines/scores publicly" switch (migrate12.ts). Only takes
  // effect on a private venue (residence or restricted tier — see venueActivity.ts): when false,
  // nobody but the owner, admins and each score's own author sees the venue's machine inventory or
  // the scores logged there. A public venue's scores are never hideable by whoever created its row.
  showMachinesAndScores: boolean('show_machines_and_scores').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const scores = pgTable('scores', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id).notNull(),
  machineId: integer('machine_id').references(() => machines.id).notNull(),
  score: bigint('score', { mode: 'number' }).notNull(),
  playedAt: timestamp('played_at').notNull(),
  type: scoreTypeEnum('type').default('casual').notNull(),
  venueId: integer('venue_id').references(() => venues.id),
  venueName: text('venue_name'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  photoUrl: text('photo_url'),
  photoThumbnail: text('photo_thumbnail'),
  // Full-size photo on Cloudflare R2 (migrate17). The key is private — never sent to clients;
  // lists expose `hasFullPhoto`, and GET /api/scores/:id/photo signs a short-lived URL.
  photoKey: text('photo_key'),
  photoBytes: integer('photo_bytes'),
  photoWidth: integer('photo_width'),
  photoHeight: integer('photo_height'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const venueMachineHistory = pgTable('venue_machine_history', {
  id: serial('id').primaryKey(),
  venueId: integer('venue_id').references(() => venues.id).notNull(),
  machineId: integer('machine_id').references(() => machines.id).notNull(),
  firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  removedAt: timestamp('removed_at'),
}, (table) => ({
  venueMachineUnique: uniqueIndex('venue_machine_history_venue_machine_idx').on(table.venueId, table.machineId),
}));

// Owner-managed machine inventory for private (home) venues, which can't use a Pinball Map roster
// (a PM listing would publish where the venue is). One row per venue+machine: `removedAt` null means
// it's there now; set means it left, and re-adding clears it and restarts `addedAt`. Kept apart
// from venue_machine_history on purpose: that table is derived from Pinball Map, is re-diffed
// against PM's roster (which would mark every owner-added machine removed), and is only served to
// viewers who may see the PM linkage — this one is governed by showMachinesAndScores instead.
export const venueInventory = pgTable('venue_inventory', {
  id: serial('id').primaryKey(),
  venueId: integer('venue_id').references(() => venues.id).notNull(),
  machineId: integer('machine_id').references(() => machines.id).notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
  addedById: integer('added_by_id').references(() => users.id),
  removedAt: timestamp('removed_at'),
  removedById: integer('removed_by_id').references(() => users.id),
}, (table) => ({
  venueMachineUnique: uniqueIndex('venue_inventory_venue_machine_idx').on(table.venueId, table.machineId),
}));

export type VenueInventory = typeof venueInventory.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
export type Score = typeof scores.$inferSelect;
export type NewScore = typeof scores.$inferInsert;
// Local copy of a Pinball Map location's machine roster, keyed by *their* location id so every
// call site shares one entry. Pinball Map asks that request volume track how often their data
// changes rather than how often our pages are viewed — this is what keeps that true: a venue page
// view reads this row, and only a stale (or forced) read goes out to their API.
export const pmLocationCache = pgTable('pm_location_cache', {
  pmLocationId: integer('pm_location_id').primaryKey(),
  machines: jsonb('machines').notNull(),
  // Location fields (id, name, lat, lon, street, city, state, zip, country) from the same
  // /locations/:id.json response as the roster (migrate20). Null on rows cached before it existed.
  location: jsonb('location'),
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
});

export type PmLocationCache = typeof pmLocationCache.$inferSelect;

// Pinball Map's machine catalog (machines.json), shared by every process — one row keyed 'machines'
// (migrate16). data/fetched_at are null until the first successful fetch; last_error(_at) is the
// negative cache for a failed refresh. See artifacts/api-server/src/lib/pinballMap.ts.
export const pmCatalogCache = pgTable('pm_catalog_cache', {
  key: text('key').primaryKey(),
  data: jsonb('data'),
  fetchedAt: timestamp('fetched_at'),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at'),
});

export type VenueMachineHistory = typeof venueMachineHistory.$inferSelect;
export type NewVenueMachineHistory = typeof venueMachineHistory.$inferInsert;

// Defines each trackable stat by a stable key — lets StatHistory reference an id instead of a
// hardcoded name, so a stat can be renamed/described from the admin UI without touching history rows.
export const stats = pgTable('stats', {
  id: serial('id').primaryKey(),
  key: text('key').unique().notNull(),
  label: text('label').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// One row per stat per calendar day (site-wide, not per-user) — written by the 1am ET daily
// snapshot job. periodDate is the America/New_York calendar date the value covers.
export const statHistory = pgTable('stat_history', {
  id: serial('id').primaryKey(),
  statId: integer('stat_id').references(() => stats.id).notNull(),
  value: integer('value').notNull(),
  periodDate: date('period_date').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  statDateUnique: uniqueIndex('stat_history_stat_id_period_date_idx').on(table.statId, table.periodDate),
}));

// Pods — a private grouping of other users, owned by one user, used to compare scores against
// "just these people". Fully private: only the owner ever sees a pod, its name or its members, and
// members are never told (see src/routes/pods.ts on the api-server). Names are unique per owner,
// case-insensitive (expression index on lower(name)); different owners may reuse a name. `color` is
// the owner's chosen `#rrggbb`, lowercase — validated server-side by normalizePodColor().
// A future `visibility` column (default 'private') would slot in here; nothing reads one today.
export const pods = pgTable('pods', {
  id: serial('id').primaryKey(),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  color: varchar('color', { length: 7 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  ownerIdx: index('pods_owner_id_idx').on(table.ownerId),
  ownerNameUnique: uniqueIndex('pods_owner_lower_name_idx').on(table.ownerId, sql`lower(${table.name})`),
}));

// One row per (pod, member). The composite primary key is the unique(pod_id, user_id) constraint.
export const podMembers = pgTable('pod_members', {
  podId: integer('pod_id').references(() => pods.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  addedAt: timestamp('added_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'pod_members_pkey', columns: [table.podId, table.userId] }),
  userIdx: index('pod_members_user_id_idx').on(table.userId),
}));

// Friends (feature/friends, phase 1) — mutual, consent-based relationships between two users.
// ONE row per unordered pair: the unique index is on (least, greatest) of the two ids, so A→B and
// B→A can never both exist. `requester_id` is whoever sent the current request — roles flip on the
// row when the other side later asks (see src/lib/friendRules.ts on the api-server).
// `decline_count` is the pair's history and survives role flips; once it reaches 3 the person who
// was declined can't ask again. Unfriending deletes the row outright. migrate14.ts also adds CHECKs
// (status values, requester <> addressee) that Drizzle doesn't model here.
export const friendships = pgTable('friendships', {
  id: serial('id').primaryKey(),
  requesterId: integer('requester_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  addresseeId: integer('addressee_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: text('status').$type<'pending' | 'accepted' | 'declined'>().notNull(),
  declineCount: integer('decline_count').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  respondedAt: timestamp('responded_at'),
}, (table) => ({
  pairUnique: uniqueIndex('friendships_pair_idx').on(
    sql`least(${table.requesterId}, ${table.addresseeId})`,
    sql`greatest(${table.requesterId}, ${table.addresseeId})`,
  ),
  requesterIdx: index('friendships_requester_id_idx').on(table.requesterId),
  addresseeIdx: index('friendships_addressee_id_idx').on(table.addresseeId),
}));

// The in-app inbox. Generic on purpose: `kind` names the event ('friend_request', 'friend_accepted'
// today; challenge kinds later) and `payload` carries whatever that kind needs to render and link
// (ids and display names at the time of the event). Only ever served to `user_id` themselves.
export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  readAt: timestamp('read_at'),
}, (table) => ({
  userReadIdx: index('notifications_user_id_read_at_idx').on(table.userId, table.readAt),
}));

// Challenges (feature/challenges, phase 2) — two or more accepted friends agree on a machine, a type
// and a window, then go play. The rules are pure, in src/lib/challengeRules.ts on the api-server;
// orchestration is src/lib/challenges.ts. migrate15.ts also adds CHECKs (enum values, min_plays
// 3–10, race needs a target, average needs min_plays) that Drizzle doesn't model here.
// `startsAt` null = "starts when accepted" (set on acceptance). `matchGroup` is the OPDB group id
// ("GbPde") captured at creation for match_mode 'game'; null means exact machine only.
// `visibility` is reserved ('participants') — nothing reads it yet.
export type ChallengeType = 'high_score' | 'race' | 'most_improved' | 'average';
// 'countered' (migrate22): the invitee couldn't get to the machine and answered with a counter-offer
// — a new challenge whose countered_from_id points back here.
export type ChallengeStatus = 'pending' | 'active' | 'resolved' | 'declined' | 'cancelled' | 'expired' | 'countered';
export type ChallengeResponse = 'pending' | 'accepted' | 'declined' | 'countered';
// Why an invitee said no (migrate22). A counter-offer stores 'cant_reach' too.
export type ChallengeDeclineReason = 'cant_reach' | 'no_thanks';
// 'abandoned' = a race / average nobody finished (not a win, loss, tie or no-show; breaks a win streak).
export type ChallengeOutcome = 'win' | 'loss' | 'tie' | 'forfeit' | 'no_show' | 'abandoned';
export const challenges = pgTable('challenges', {
  id: serial('id').primaryKey(),
  creatorId: integer('creator_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  type: text('type').$type<ChallengeType>().notNull(),
  machineId: integer('machine_id').references(() => machines.id).notNull(),
  matchMode: text('match_mode').$type<'game' | 'exact'>().default('game').notNull(),
  matchGroup: text('match_group'),
  venueId: integer('venue_id').references(() => venues.id),
  targetScore: bigint('target_score', { mode: 'number' }),
  minPlays: integer('min_plays'),
  startsAt: timestamp('starts_at'),
  endsAt: timestamp('ends_at').notNull(),
  status: text('status').$type<ChallengeStatus>().default('pending').notNull(),
  void: boolean('void').default(false).notNull(),
  visibility: text('visibility').default('participants').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at'),
  // Admin override (migrate19): an admin voided this challenge. status is then 'cancelled', every
  // participant's outcome/rank/result is cleared (so it drops out of records) and its score locks
  // are released. The pre-void state is kept in the admin.challenge_voided activity event.
  adminCancelledAt: timestamp('admin_cancelled_at'),
  adminCancelledById: integer('admin_cancelled_by_id'),
  adminCancelReason: text('admin_cancel_reason'),
  // A counter-offer's original (migrate22). The original's status is then 'countered'; chains of
  // counters are allowed, each pointing at the one before.
  counteredFromId: integer('countered_from_id').references((): AnyPgColumn => challenges.id, { onDelete: 'set null' }),
}, (table) => ({
  statusEndsIdx: index('challenges_status_ends_at_idx').on(table.status, table.endsAt),
  creatorIdx: index('challenges_creator_id_idx').on(table.creatorId),
  counteredFromIdx: index('challenges_countered_from_id_idx').on(table.counteredFromId),
}));

// One row per (challenge, participant) — the creator included (accepted at creation). Groups later
// just means more rows. `baselineScore` is frozen at acceptance for most_improved; `resultValue` and
// `rank` are written at resolution (live standings are computed, not stored).
export const challengeParticipants = pgTable('challenge_participants', {
  challengeId: integer('challenge_id').references(() => challenges.id, { onDelete: 'cascade' }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  response: text('response').$type<ChallengeResponse>().default('pending').notNull(),
  // Set with response 'declined' ('cant_reach' / 'no_thanks') or 'countered' (always 'cant_reach').
  declineReason: text('decline_reason').$type<ChallengeDeclineReason>(),
  outcome: text('outcome').$type<ChallengeOutcome>(),
  baselineScore: bigint('baseline_score', { mode: 'number' }),
  resultValue: numeric('result_value'),
  rank: integer('rank'),
  respondedAt: timestamp('responded_at'),
  endingSoonNotifiedAt: timestamp('ending_soon_notified_at'),
}, (table) => ({
  pk: primaryKey({ name: 'challenge_participants_pkey', columns: [table.challengeId, table.userId] }),
  userIdx: index('challenge_participants_user_id_idx').on(table.userId),
}));

// The scores that counted toward a challenge (written whenever standings are computed). A score with
// a row here is locked: PATCH/DELETE /api/scores/:id answer 409 score_locked_by_challenge, and the
// FK (no ON DELETE action) makes the database refuse a delete too.
export const challengeScores = pgTable('challenge_scores', {
  challengeId: integer('challenge_id').references(() => challenges.id, { onDelete: 'cascade' }).notNull(),
  scoreId: integer('score_id').references(() => scores.id).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'challenge_scores_pkey', columns: [table.challengeId, table.scoreId] }),
  scoreIdx: index('challenge_scores_score_id_idx').on(table.scoreId),
}));

// Challenge preferences (migrate22) — what a friend's create form recommends for this user.
// "Challenge me on": up to 3 exact machines (the API enforces the max), ordered by `position`.
export const userChallengeMachines = pgTable('user_challenge_machines', {
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  machineId: integer('machine_id').references(() => machines.id, { onDelete: 'cascade' }).notNull(),
  position: integer('position').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'user_challenge_machines_pkey', columns: [table.userId, table.machineId] }),
}));

// "Challenge locations": venues this user can get to. 'auto' = seeded once from their history
// (users.challenge_venues_seeded_at), 'added' = picked by hand. A private venue's machines are never
// shown grouped under its name — see src/lib/challengeReach.ts on the api-server.
export const userChallengeVenues = pgTable('user_challenge_venues', {
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  venueId: integer('venue_id').references(() => venues.id, { onDelete: 'cascade' }).notNull(),
  source: text('source').$type<'auto' | 'added'>().default('added').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'user_challenge_venues_pkey', columns: [table.userId, table.venueId] }),
}));

// The admin activity log (migrate19) — append-only, one row per thing that happened, written only
// through logActivity() in artifacts/api-server/src/lib/activity.ts (which never fails a request).
// `actorUserId` null = the system (cron, or a webhook for a user with no profile yet).
// `subjectUserId` is the other user an event is about (the friend-request addressee, the disabled
// user); `targetType` + `targetId` name the object ('score', 'challenge', 'pod', 'friendship',
// 'notification', 'venue', 'machine', 'user', 'clerk_user') — text, so a Clerk id fits. `svixId`
// makes Clerk webhook deliveries idempotent (unique; NULLs don't collide). No secrets in `payload`.
export const activityEvents = pgTable('activity_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  subjectUserId: integer('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
  targetType: text('target_type'),
  targetId: text('target_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  svixId: text('svix_id').unique('activity_events_svix_id_key'),
}, (table) => ({
  createdIdx: index('activity_events_created_at_idx').on(table.createdAt),
  actorIdx: index('activity_events_actor_idx').on(table.actorUserId, table.id),
  subjectIdx: index('activity_events_subject_idx').on(table.subjectUserId, table.id),
  typeIdx: index('activity_events_type_idx').on(table.type, table.id),
  targetIdx: index('activity_events_target_idx').on(table.targetType, table.targetId, table.id),
  // Retention purge, high-volume tier: type = ANY(...) AND created_at < cutoff (migrate21).
  typeCreatedIdx: index('activity_events_type_created_idx').on(table.type, table.createdAt),
}));

// Admin-editable server-side settings (migrate21). Defaults live in code (e.g. activityRetention.ts),
// so an empty table = every default; a row only exists once an admin saved something or a job
// recorded state (photo_orphans_last_run). Generic key/value so more settings can move here later.
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  updatedById: integer('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
});

export type AppSetting = typeof appSettings.$inferSelect;

// Raw bytes (postgres.js hands bytea back as a Buffer).
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

// Badges (migrate23). One row per badge; every award goes through the engine in
// artifacts/api-server/src/lib/badges.ts. Kinds:
//   metric — `metric` (a key in badgeMetrics.ts) compared as value >= `threshold`
//   rule   — `rule` jsonb, the declarative score conditions of badgeRules.ts (never SQL or code)
//   manual — no rule; an admin grants it by hand
// `image` is the server-re-encoded 256x256 WebP (small, a few dozen at most — kept in the DB rather
// than R2 so it can be served with an immutable public cache); `imageVersion` is bumped on every
// upload and never reset, so `?v=` URLs never collide. No image = the lucide `icon` in `color`.
// `status`: draft → live (activateBadge, which backfills when `retroactive`) → retired (no new awards;
// earned ones stay). `activatedAt` is stamped on first activation: a forward-only rule badge counts
// only scores posted after it. `availableFrom`/`availableTo` (naive UTC, like every timestamp here)
// bound when it can be earned. migrate23 also adds CHECKs (kind/status values, metric needs a
// threshold, rule needs a rule) that Drizzle doesn't model here.
export type BadgeKind = 'metric' | 'rule' | 'manual';
export type BadgeStatus = 'draft' | 'live' | 'retired';

// Badge series (migrate25) — a ladder of tiers ("Scores": First Ball → Regular → Centurion → Wizard
// Mode). A series has ONE color: every tier renders in `color` (a tier's own badges.color is ignored
// while it's in a series), so the tiers can't drift. `sortOrder` places the whole series in the same
// ordering space as single badges' badges.sort_order. Within a series, metric tiers are ordered by
// threshold, rule/manual tiers by their own sort_order (src/lib/badgeSeries.ts).
export const badgeSeries = pgTable('badge_series', {
  id: serial('id').primaryKey(),
  key: text('key').unique().notNull(),
  name: text('name').notNull(),
  color: varchar('color', { length: 7 }).default('#f59e0b').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const badges = pgTable('badges', {
  id: serial('id').primaryKey(),
  key: text('key').unique().notNull(),
  name: text('name').notNull(),
  description: text('description').default('').notNull(),
  icon: text('icon').default('award').notNull(),
  color: varchar('color', { length: 7 }).default('#f59e0b').notNull(),
  image: bytea('image'),
  imageVersion: integer('image_version').default(0).notNull(),
  kind: text('kind').$type<BadgeKind>().notNull(),
  metric: text('metric'),
  threshold: integer('threshold'),
  rule: jsonb('rule').$type<Record<string, unknown>>(),
  retroactive: boolean('retroactive').default(false).notNull(),
  status: text('status').$type<BadgeStatus>().default('draft').notNull(),
  availableFrom: timestamp('available_from'),
  availableTo: timestamp('available_to'),
  activatedAt: timestamp('activated_at'),
  sortOrder: integer('sort_order').default(0).notNull(),
  // migrate25: the series this badge is a tier of (null = a single badge).
  seriesId: integer('series_id').references(() => badgeSeries.id, { onDelete: 'set null' }),
  createdById: integer('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  statusIdx: index('badges_status_idx').on(table.status),
  seriesIdx: index('badges_series_id_idx').on(table.seriesId),
}));

// Who has which badge. A badge is earned once (the primary key); a yearly badge is a new badge row
// each year. Source columns say what earned it (all nullable): the score that completed a rule, the
// challenge that resolved it (phase 3), or the admin who granted it. `note` is shown on the profile.
export const userBadges = pgTable('user_badges', {
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  badgeId: integer('badge_id').references(() => badges.id, { onDelete: 'cascade' }).notNull(),
  earnedAt: timestamp('earned_at').defaultNow().notNull(),
  sourceScoreId: integer('source_score_id').references(() => scores.id, { onDelete: 'set null' }),
  sourceChallengeId: integer('source_challenge_id').references(() => challenges.id, { onDelete: 'set null' }),
  grantedById: integer('granted_by_id').references(() => users.id, { onDelete: 'set null' }),
  note: text('note'),
}, (table) => ({
  pk: primaryKey({ name: 'user_badges_pkey', columns: [table.userId, table.badgeId] }),
  badgeIdx: index('user_badges_badge_id_idx').on(table.badgeId),
}));

// Event-sourced badge metrics whose sources are deleted or purged elsewhere (friendships are deleted
// on unfriend; activity_events has retention). One row per (user, metric, ref) — `ref` makes a metric
// idempotent and hard to farm (a login day's ref is its America/New_York date; a friend request's is
// the recipient's id). A metric's value is COUNT(*). Written regardless of activity-retention settings.
export const userMetricMarks = pgTable('user_metric_marks', {
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  metric: text('metric').notNull(),
  ref: text('ref').notNull(),
  at: timestamp('at').defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ name: 'user_metric_marks_pkey', columns: [table.userId, table.metric, table.ref] }),
  metricIdx: index('user_metric_marks_metric_idx').on(table.metric, table.userId),
}));

export type Badge = typeof badges.$inferSelect;
export type BadgeSeries = typeof badgeSeries.$inferSelect;
export type UserBadge = typeof userBadges.$inferSelect;
export type UserMetricMark = typeof userMetricMarks.$inferSelect;

export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;

export type Challenge = typeof challenges.$inferSelect;
export type ChallengeParticipant = typeof challengeParticipants.$inferSelect;

export type Friendship = typeof friendships.$inferSelect;
export type Notification = typeof notifications.$inferSelect;

export type Pod = typeof pods.$inferSelect;
export type NewPod = typeof pods.$inferInsert;
export type PodMember = typeof podMembers.$inferSelect;

export type Stat = typeof stats.$inferSelect;
export type NewStat = typeof stats.$inferInsert;
export type StatHistory = typeof statHistory.$inferSelect;
export type NewStatHistory = typeof statHistory.$inferInsert;
