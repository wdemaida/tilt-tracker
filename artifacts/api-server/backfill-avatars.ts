// One-time backfill of users.image_url from Clerk (after migrate30). Run once at deploy; afterwards the
// user.updated webhook, POST /api/users/me/avatar/sync and GET /me's 24 h lazy resync keep it current
// (src/lib/profileAvatar.ts).
//
// Pages through Clerk's WHOLE user list (getUserList, 100 per call, by offset) with NO filters, and
// matches users to our rows by clerk_id locally. Deliberately no `userId` / `emailAddress` filter:
// Clerk's list filters can return the full, unfiltered list when nothing matches (see the
// email_address[] gotcha), and adopting the wrong person's photo is exactly the failure to avoid.
// A Clerk user with no TiltTrack profile is skipped. Only users with has_image are written — a user
// without a photo of their own keeps image_url null. Writes go through the same guarded update as the
// webhook (applyAvatar), stamped with when this run read the page, so a newer webhook or resync is
// never overwritten. Idempotent: re-running re-applies only where Clerk has newer state.
//
//   cd artifacts/api-server && npx tsx backfill-avatars.ts --dry-run   # counts only, no writes
//   cd artifacts/api-server && npx tsx backfill-avatars.ts             # write
//
// Uses DATABASE_URL and CLERK_SECRET_KEY from .env — check which database it names before running.

import 'dotenv/config';

const dryRun = process.argv.includes('--dry-run');
if (!process.env.CLERK_SECRET_KEY) {
  console.error('CLERK_SECRET_KEY is not set.');
  process.exit(1);
}

const { createClerkClient } = await import('@clerk/express');
const { db, users } = await import('@workspace/db');
const { applyAvatar } = await import('./src/lib/profileAvatar.js');
const { avatarFromClerk } = await import('./src/lib/profileFields.js');

console.log(`Database host: ${new URL(process.env.DATABASE_URL!).hostname}${dryRun ? ' (dry run — no writes)' : ''}`);

const ours = new Map((await db.select({ id: users.id, clerkId: users.clerkId, imageUrl: users.imageUrl }).from(users)).map(u => [u.clerkId, u]));
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const PAGE = 100;
const seen = new Set<string>();
let clerkUsers = 0, noProfile = 0, noPhoto = 0, written = 0, unchanged = 0, skippedNewer = 0;

for (let offset = 0; ; offset += PAGE) {
  const readAt = new Date();
  const page = await clerk.users.getUserList({ limit: PAGE, offset, orderBy: '+created_at' });
  for (const u of page.data) {
    if (seen.has(u.id)) continue; // a sign-up between pages can shift one row across a boundary
    seen.add(u.id);
    clerkUsers++;
    const row = ours.get(u.id);
    if (!row) { noProfile++; continue; }
    const imageUrl = avatarFromClerk(u);
    if (!imageUrl) { noPhoto++; continue; }
    if (dryRun) {
      if (row.imageUrl === imageUrl) unchanged++; else written++;
      continue;
    }
    const r = await applyAvatar(u.id, imageUrl, readAt);
    if (!r.applied) skippedNewer++;
    else if (r.changed) written++;
    else unchanged++;
  }
  if (page.data.length < PAGE) break;
}

console.log(`Clerk users: ${clerkUsers} (of ${ours.size} TiltTrack users) — no TiltTrack profile: ${noProfile}, no photo of their own: ${noPhoto}`);
console.log(`${dryRun ? 'Would write' : 'Wrote'}: ${written}, already current: ${unchanged}${dryRun ? '' : `, skipped (newer state already stored): ${skippedNewer}`}`);
process.exit(0);
