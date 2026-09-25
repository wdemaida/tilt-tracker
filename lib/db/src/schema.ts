import { pgTable, serial, text, bigint, timestamp, real, integer, pgEnum, uniqueIndex, date, boolean, jsonb } from 'drizzle-orm/pg-core';

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
  fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
});

export type PmLocationCache = typeof pmLocationCache.$inferSelect;

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

export type Stat = typeof stats.$inferSelect;
export type NewStat = typeof stats.$inferInsert;
export type StatHistory = typeof statHistory.$inferSelect;
export type NewStatHistory = typeof statHistory.$inferInsert;
