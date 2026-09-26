// Lists (and with --delete, removes) full-size photo objects in R2 that no score references and that
// are older than 24 hours. Orphans come from uploads whose confirm never arrived (tab closed between
// the PUT and the confirm), a failed best-effort delete after a score delete or photo replace, or a
// score deleted by code that forgot to delete its photo. The 24h floor keeps an in-flight upload
// (PUT done, confirm pending) from ever being swept.
//
// Dry run by default. Runs against whatever DATABASE_URL + R2_* the .env points at — the bucket and
// the database must be the SAME environment (dev DB with the dev bucket, prod with prod), or every
// object looks orphaned. The script refuses the two mismatched combinations it can recognise.
//
//   cd artifacts/api-server && npx tsx cleanup-photo-orphans.ts            # list only
//   cd artifacts/api-server && npx tsx cleanup-photo-orphans.ts --delete   # actually delete
//
// No cron yet — run by hand now and then (see CLAUDE.md, "Full-size score photos").

import 'dotenv/config';
import { getPhotoStore, findOrphans, PHOTO_KEY_PREFIX, missingR2Vars } from './src/lib/photoStore.js';

const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const DEV_BUCKET = 'tilttrack-photos-dev';

const doDelete = process.argv.includes('--delete');
const missing = missingR2Vars();
if (missing.length) {
  console.error(`R2 not configured (missing ${missing.join(', ')}).`);
  process.exit(1);
}
const isDevDb = new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT);
const isDevBucket = process.env.R2_BUCKET === DEV_BUCKET;
if (isDevDb !== isDevBucket) {
  console.error(`Refusing to run: database is ${isDevDb ? 'dev' : 'not dev'} but bucket is ${isDevBucket ? 'dev' : 'not dev'} — every object would look orphaned.`);
  process.exit(1);
}

const { db, scores } = await import('@workspace/db');
const { isNotNull } = await import('drizzle-orm');

const store = getPhotoStore()!;
const rows = await db.select({ key: scores.photoKey }).from(scores).where(isNotNull(scores.photoKey));
const referenced = new Set(rows.map(r => r.key!));

const objects: Array<{ key: string; lastModified: Date | null; size: number }> = [];
let next: string | undefined;
do {
  const page = await store.list(PHOTO_KEY_PREFIX, next);
  objects.push(...page.objects);
  next = page.next;
} while (next);

const orphans = findOrphans(objects, referenced, Date.now());
const bytes = objects.filter(o => orphans.includes(o.key)).reduce((n, o) => n + o.size, 0);
console.log(`${objects.length} objects under ${PHOTO_KEY_PREFIX} in ${store.bucket}; ${referenced.size} referenced by scores; ${orphans.length} orphans older than 24h (${(bytes / 1024 / 1024).toFixed(1)}MB).`);
for (const key of orphans) console.log(`  ${doDelete ? 'delete' : 'orphan'}  ${key}`);

if (doDelete) {
  let failed = 0;
  for (const key of orphans) {
    try { await store.delete(key); } catch (err: any) { failed++; console.error(`  failed ${key}: ${err?.message ?? err}`); }
  }
  console.log(`Deleted ${orphans.length - failed}, failed ${failed}.`);
} else if (orphans.length) {
  console.log('Dry run — pass --delete to remove them.');
}
process.exit(0);
