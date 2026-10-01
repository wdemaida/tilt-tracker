import './pinUtc.js'; // first: process.env.TZ = 'UTC' (see pinUtc.ts)
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as dsql } from 'drizzle-orm';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

const sql = postgres(connectionString);
export const db = drizzle(sql, { schema });

/** Session zones that make `now()`-as-text, `::timestamp` casts and `AT TIME ZONE` defaults read as UTC. */
export function isUtcZone(name: string | null | undefined): boolean {
  return !!name && /^(utc|gmt|etc\/utc|etc\/gmt|etc\/universal|universal|zulu|etc\/zulu|uct|etc\/uct|z)$/i.test(name.trim());
}

/**
 * The database session's TimeZone (Neon's default is GMT). Every column is timestamptz, so a
 * non-UTC session no longer changes what's stored — only how raw SQL renders timestamps as text and
 * how a naive value would be cast. Checked at startup and on the admin health page anyway, because
 * nothing in the app chose it deliberately.
 */
export async function dbSessionTimeZone(): Promise<{ timeZone: string; utc: boolean }> {
  const rows = await db.execute(dsql`SELECT current_setting('TimeZone') AS tz`) as unknown as Array<{ tz: string }>;
  const timeZone = String(rows[0]?.tz ?? '');
  return { timeZone, utc: isUtcZone(timeZone) };
}

export * from './schema.js';
