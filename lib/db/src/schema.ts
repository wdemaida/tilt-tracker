import { pgTable, serial, text, bigint, timestamp, real, integer, pgEnum } from 'drizzle-orm/pg-core';

export const scoreTypeEnum = pgEnum('score_type', ['casual', 'tournament']);
export const userRoleEnum = pgEnum('user_role', ['admin', 'user']);

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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Machine = typeof machines.$inferSelect;
export type NewMachine = typeof machines.$inferInsert;
export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
export type Score = typeof scores.$inferSelect;
export type NewScore = typeof scores.$inferInsert;
