// Lists (and with --delete, removes) full-size photo objects in R2 that no score references and that
// are older than 24 hours. The logic lives in src/lib/photoOrphans.ts, which the daily challenge sweep
// also runs weekly (see CLAUDE.md, "Photo orphan sweep") and admins can run from /admin/config. This
// is the hand-run version: same selection, same pre-delete re-check, same 1,000-delete cap per run
// (run it again to continue), and it records the run as the "last run" the admin page shows.
//
// Dry run by default. Runs against whatever DATABASE_URL + R2_* the .env points at — the bucket and
// the database must be the SAME environment (dev DB with the dev bucket, prod with prod), or every
// object looks orphaned. The library refuses the two mismatched combinations it can recognise.
//
//   cd artifacts/api-server && npx tsx cleanup-photo-orphans.ts            # list only
//   cd artifacts/api-server && npx tsx cleanup-photo-orphans.ts --delete   # actually delete

import 'dotenv/config';
import { missingR2Vars } from './src/lib/photoStore.js';

const doDelete = process.argv.includes('--delete');
const missing = missingR2Vars();
if (missing.length) {
  console.error(`R2 not configured (missing ${missing.join(', ')}).`);
  process.exit(1);
}

const { runPhotoOrphanSweep } = await import('./src/lib/photoOrphans.js');
const outcome = await runPhotoOrphanSweep({ dryRun: !doDelete, trigger: 'cli', sampleSize: Number.POSITIVE_INFINITY });
if (!outcome.ran) {
  console.error(`Refusing to run: ${outcome.detail ?? outcome.reason}.`);
  process.exit(1);
}
const r = outcome.result;
console.log(`${r.listed} objects under ${r.prefix} in ${r.bucket}; ${r.referenced} referenced by scores; ${r.orphans} orphans older than ${r.minAgeHours}h (${(r.orphanBytes / 1024 / 1024).toFixed(1)}MB).`);
for (const key of r.sample) console.log(`  ${doDelete ? 'delete' : 'orphan'}  ${key}`);
if (doDelete) {
  console.log(`Deleted ${r.deleted}, failed ${r.failed}, kept ${r.skippedReferenced} referenced at the re-check.${r.capped ? ' Capped — run again for the rest.' : ''}`);
} else if (r.orphans) {
  console.log('Dry run — pass --delete to remove them.');
}
process.exit(0);
