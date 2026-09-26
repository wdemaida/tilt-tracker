// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/photoOrphans.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PhotoStore } from './photoStore.js';
import {
  sweepPhotoOrphans, envMismatch, orphanSweepDue, publicOrphanResult, runPhotoOrphanSweep,
  ORPHAN_RUN_INTERVAL_MS, type OrphanSweepDeps,
} from './photoOrphans.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const H = 3_600_000;
const key = (scoreId: number, n: number) => `scores/${scoreId}/${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000.jpg`;

interface Obj { key: string; lastModified: Date | null; size: number }

/** A fake bucket: pages of `pageSize`, records deletes, can fail chosen keys. */
function fakeStore(objects: Obj[], pageSize = 3, failKeys: string[] = []) {
  const live = new Map(objects.map(o => [o.key, o]));
  const deleted: string[] = [];
  const listCalls: Array<string | undefined> = [];
  const store: PhotoStore = {
    bucket: 'fake-bucket',
    presignPut: async () => '', presignGet: async () => '', head: async () => null,
    async delete(k) {
      if (failKeys.includes(k)) throw new Error('simulated R2 failure');
      live.delete(k);
      deleted.push(k);
    },
    async list(prefix, token) {
      listCalls.push(token);
      const all = objects.filter(o => o.key.startsWith(prefix));
      const start = token ? Number(token) : 0;
      const page = all.slice(start, start + pageSize);
      return { objects: page, next: start + pageSize < all.length ? String(start + pageSize) : undefined };
    },
  };
  return { store, deleted, listCalls, live };
}

function deps(store: PhotoStore, referenced: string[], referencedLater: string[] = []): OrphanSweepDeps & { rechecks: string[][] } {
  const rechecks: string[][] = [];
  return {
    store,
    rechecks,
    referencedKeys: async () => new Set(referenced),
    referencedAmong: async keys => { rechecks.push(keys); return new Set(keys.filter(k => referenced.includes(k) || referencedLater.includes(k))); },
  };
}

const old = (k: string, size = 100): Obj => ({ key: k, lastModified: new Date(NOW - 48 * H), size });
const fresh = (k: string): Obj => ({ key: k, lastModified: new Date(NOW - 2 * H), size: 100 });

test('selection: unreferenced + older than 24h only; fresh uploads and referenced keys are kept', async () => {
  const objs = [old(key(1, 1)), old(key(2, 2)), fresh(key(3, 3)), old(key(4, 4)), { key: key(5, 5), lastModified: null, size: 1 }];
  const f = fakeStore(objs);
  const r = await sweepPhotoOrphans(deps(f.store, [key(2, 2)]), { dryRun: false, now: NOW });
  assert.deepEqual(f.deleted.sort(), [key(1, 1), key(4, 4)].sort());
  assert.equal(r.listed, 5);
  assert.equal(r.referenced, 1);
  assert.equal(r.orphans, 2);
  assert.equal(r.deleted, 2);
  assert.equal(r.capped, false);
});

test('24h cutoff is exclusive and injectable', async () => {
  const exactly24 = { key: key(1, 1), lastModified: new Date(NOW - 24 * H), size: 1 };
  const f = fakeStore([exactly24]);
  assert.equal((await sweepPhotoOrphans(deps(f.store, []), { dryRun: true, now: NOW })).orphans, 0);
  const g = fakeStore([fresh(key(1, 1))]);
  const r = await sweepPhotoOrphans(deps(g.store, []), { dryRun: false, now: NOW, minAgeMs: 0 });
  assert.equal(r.deleted, 1);
  assert.equal(r.minAgeHours, 0);
});

test('dry run deletes nothing and does not re-check', async () => {
  const f = fakeStore([old(key(1, 1), 1000), old(key(2, 2), 24)]);
  const d = deps(f.store, []);
  const r = await sweepPhotoOrphans(d, { dryRun: true, now: NOW });
  assert.equal(f.deleted.length, 0);
  assert.equal(d.rechecks.length, 0);
  assert.equal(r.orphans, 2);
  assert.equal(r.orphanBytes, 1024);
  assert.equal(r.deleted, 0);
  assert.deepEqual(r.sample, [key(1, 1), key(2, 2)]);
});

test('re-check right before deleting: a key confirmed mid-sweep is kept', async () => {
  const f = fakeStore([old(key(1, 1)), old(key(2, 2)), old(key(3, 3))]);
  const d = deps(f.store, [], [key(2, 2)]);
  const r = await sweepPhotoOrphans(d, { dryRun: false, now: NOW });
  assert.deepEqual(f.deleted.sort(), [key(1, 1), key(3, 3)].sort());
  assert.equal(r.skippedReferenced, 1);
  assert.equal(r.deleted, 2);
  assert.deepEqual(d.rechecks.flat().sort(), [key(1, 1), key(2, 2), key(3, 3)].sort());
});

test('pages through ListObjectsV2 with continuation tokens', async () => {
  const objs = Array.from({ length: 10 }, (_, i) => old(key(i + 1, i + 1)));
  const f = fakeStore(objs, 3);
  const r = await sweepPhotoOrphans(deps(f.store, []), { dryRun: false, now: NOW });
  assert.deepEqual(f.listCalls, [undefined, '3', '6', '9']);
  assert.equal(r.deleted, 10);
});

test('delete cap: stops at maxDeletes and reports capped', async () => {
  const objs = Array.from({ length: 10 }, (_, i) => old(key(i + 1, i + 1)));
  const f = fakeStore(objs, 3);
  const r = await sweepPhotoOrphans(deps(f.store, []), { dryRun: false, now: NOW, maxDeletes: 4 });
  assert.equal(r.deleted, 4);
  assert.equal(f.deleted.length, 4);
  assert.equal(r.capped, true);
  assert.ok(f.listCalls.length <= 2, 'stops listing once it has enough');
});

test('delete cap exactly met on the last page is not "capped"', async () => {
  const f = fakeStore([old(key(1, 1)), old(key(2, 2))], 5);
  const r = await sweepPhotoOrphans(deps(f.store, []), { dryRun: false, now: NOW, maxDeletes: 2 });
  assert.equal(r.deleted, 2);
  assert.equal(r.capped, false);
});

test('page cap', async () => {
  const objs = Array.from({ length: 10 }, (_, i) => old(key(i + 1, i + 1)));
  const f = fakeStore(objs, 3);
  const r = await sweepPhotoOrphans(deps(f.store, []), { dryRun: true, now: NOW, maxPages: 2 });
  assert.equal(r.listed, 6);
  assert.equal(r.capped, true);
});

test('re-check runs in batches of 100', async () => {
  const objs = Array.from({ length: 250 }, (_, i) => old(key(i + 1, i + 1)));
  const f = fakeStore(objs, 1000);
  const d = deps(f.store, []);
  await sweepPhotoOrphans(d, { dryRun: false, now: NOW });
  assert.deepEqual(d.rechecks.map(b => b.length), [100, 100, 50]);
  assert.equal(f.deleted.length, 250);
});

test('a failed delete is counted, the rest continue', async () => {
  const f = fakeStore([old(key(1, 1)), old(key(2, 2)), old(key(3, 3))], 3, [key(2, 2)]);
  const r = await sweepPhotoOrphans(deps(f.store, []), { dryRun: false, now: NOW });
  assert.equal(r.deleted, 2);
  assert.equal(r.failed, 1);
});

test('prefix must stay under scores/', async () => {
  const f = fakeStore([]);
  await assert.rejects(sweepPhotoOrphans(deps(f.store, []), { dryRun: true, prefix: 'other/' }), /prefix/);
  const r = await sweepPhotoOrphans(deps(fakeStore([old(key(1, 1)), old(key(2, 2))]).store, []), { dryRun: true, now: NOW, prefix: 'scores/2/' });
  assert.equal(r.orphans, 1);
});

test('publicOrphanResult: no photo keys, score ids instead', async () => {
  const r = await sweepPhotoOrphans(deps(fakeStore([old(key(7, 1)), old(key(9, 2))]).store, []), { dryRun: true, now: NOW });
  const pub = publicOrphanResult(r);
  assert.ok(!('sample' in pub));
  assert.deepEqual(pub.sampleScoreIds, [7, 9]);
  assert.ok(!JSON.stringify(pub).includes('.jpg'));
});

test('envMismatch: dev DB needs the dev bucket and vice versa', () => {
  const dev = 'postgres://u:p@ep-late-mouse-at8antth.c-9.us-east-1.aws.neon.tech/db';
  const prod = 'postgres://u:p@ep-wispy-mode-ateylfp9.us-east-1.aws.neon.tech/db';
  assert.equal(envMismatch(dev, 'tilttrack-photos-dev'), null);
  assert.equal(envMismatch(prod, 'tilttrack-photos'), null);
  assert.match(envMismatch(dev, 'tilttrack-photos')!, /every object/);
  assert.match(envMismatch(prod, 'tilttrack-photos-dev')!, /every object/);
  assert.match(envMismatch(undefined, 'tilttrack-photos-dev')!, /not dev/);
});

test('orphanSweepDue: weekly, with 12h slack for cron jitter', () => {
  assert.equal(orphanSweepDue(null, NOW), true);
  assert.equal(orphanSweepDue('garbage', NOW), true);
  assert.equal(orphanSweepDue(new Date(NOW - 1 * 24 * H), NOW), false);
  assert.equal(orphanSweepDue(new Date(NOW - 6 * 24 * H), NOW), false);
  assert.equal(orphanSweepDue(new Date(NOW - ORPHAN_RUN_INTERVAL_MS + 11 * H), NOW), true);
  assert.equal(orphanSweepDue(new Date(NOW - ORPHAN_RUN_INTERVAL_MS - H).toISOString(), NOW), true);
});

test('runPhotoOrphanSweep: skips gracefully when R2 is not configured', async () => {
  const o = await runPhotoOrphanSweep({ dryRun: false, trigger: 'admin', store: null });
  assert.deepEqual(o, { ran: false, reason: 'r2_not_configured' });
});

test('runPhotoOrphanSweep: refuses a DB/bucket environment mismatch before listing anything', async () => {
  const f = fakeStore([old(key(1, 1))]);
  const store = { ...f.store, bucket: 'tilttrack-photos-dev' };
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://x:x@localhost:1/x';
  try {
    const o = await runPhotoOrphanSweep({ dryRun: false, trigger: 'admin', store });
    assert.equal(o.ran, false);
    if (!o.ran) assert.equal(o.reason, 'env_mismatch');
    assert.equal(f.listCalls.length, 0);
  } finally {
    process.env.DATABASE_URL = saved;
  }
});
