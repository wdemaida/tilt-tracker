import { runActivityRetention, type RetentionRunResult } from './activityRetention.js';
import { runScheduledOrphanSweep, publicOrphanResult } from './photoOrphans.js';

// Daily housekeeping, run by POST /api/cron/challenge-sweep right after runChallengeSweep() (whose
// last step is the 30-day read-notification retention). Kept out of runChallengeSweep itself so
// test-challenges.ts can run the challenge sweep without purging the dev activity log or touching R2.
//
//   1. activity-log retention — every day (activityRetention.ts), logs system.activity_retention
//   2. photo orphan sweep     — weekly: a real run only once 7 days have passed since the last
//                               deleting run (photoOrphans.ts), logs system.photo_orphans
//
// Each step is isolated: a failure is reported in the result and never fails the sweep route.

export interface HousekeepingResult {
  activityRetention: Omit<RetentionRunResult, 'settings'> | { error: string };
  photoOrphans:
    | { ran: true; result: ReturnType<typeof publicOrphanResult> }
    | { ran: false; reason: string; detail?: string; lastDeleteRunAt?: string | null }
    | { error: string };
}

export async function runDailyHousekeeping(now = Date.now()): Promise<HousekeepingResult> {
  let activityRetention: HousekeepingResult['activityRetention'];
  try {
    const { settings: _s, ...r } = await runActivityRetention();
    activityRetention = r;
  } catch (err: any) {
    console.error('Housekeeping: activity retention failed:', err);
    activityRetention = { error: err?.message ?? String(err) };
  }

  let photoOrphans: HousekeepingResult['photoOrphans'];
  try {
    const o = await runScheduledOrphanSweep(now);
    photoOrphans = o.ran ? { ran: true, result: publicOrphanResult(o.result) } : o;
  } catch (err: any) {
    console.error('Housekeeping: photo orphan sweep failed:', err);
    photoOrphans = { error: err?.message ?? String(err) };
  }
  return { activityRetention, photoOrphans };
}
