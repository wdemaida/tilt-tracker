// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/machineMerge.db.test.ts   (from artifacts/api-server)
//
// The admin machine merge ("Fix this machine") end to end against a real Postgres: an in-process
// PGlite (WASM — nothing is dialled; the dummy DATABASE_URL only satisfies @workspace/db's import-time
// check) built from the FULL Drizzle schema (drizzle-kit's generateMigration, resolved from
// @workspace/db's own dev dependency), so every real FK to machines(id) exists and is discovered.
// @workspace/db's `db` is pointed at a drizzle-on-PGlite instance and the real admin machines router
// runs on a throwaway express app. Covers: candidates (canonicalizer suggestion + search), dryRun writes
// nothing, refusals (same machine, titles differ, stale count, unknown FK, locked score that would stop
// counting), transaction rollback on a mid-merge failure, the full merge (scores, venue_machine_history
// and venue_inventory merged per venue, challenge picks deduped, challenges re-pointed and re-counted,
// badge rules re-pointed, source deleted, admin.machine_merged logged), a merge into a catalog title
// with no row yet, and the guard (guest 401 / user 403) on the real admin router.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { PGlite } = await import('@electric-sql/pglite');
const { drizzle } = await import('drizzle-orm/pglite');
const dbModule = await import('@workspace/db');
const { default: express } = await import('express');
const { setActivityGateForTests } = await import('./activity.js');
const { setAuthForTests } = await import('../middleware/requireAuth.js');
const { default: adminMachinesRouter } = await import('../routes/adminMachines.js');
const { default: adminRouter } = await import('../routes/admin.js');

// The whole schema, so the FK discovery sees exactly what production has.
const kit = createRequire(import.meta.resolve('@workspace/db'))('drizzle-kit/api') as {
  generateDrizzleJson: (s: Record<string, unknown>) => unknown;
  generateMigration: (a: unknown, b: unknown) => Promise<string[]>;
};
const ddl = await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(dbModule as unknown as Record<string, unknown>));

const pg = new PGlite();
for (const s of ddl) await pg.exec(s);

const H = 3600_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const CATALOG = [
  { id: 1, name: 'JAWS (Pro)', opdb_id: 'GrqZX-MD15K', ipdb_id: null, machine_group_id: null, manufacturer: 'Stern', year: 2024, opdb_img: 'https://img/jaws.jpg', machine_type: null, machine_display: null },
  { id: 2, name: 'JAWS (Premium)', opdb_id: 'GrqZX-MLzNP', ipdb_id: null, machine_group_id: null, manufacturer: 'Stern', year: 2024, opdb_img: null, machine_type: null, machine_display: null },
  { id: 3, name: 'No Good Gofers', opdb_id: 'GrknN-MQrdv', ipdb_id: null, machine_group_id: null, manufacturer: 'Williams', year: 1997, opdb_img: 'https://img/ngg.jpg', machine_type: null, machine_display: null },
  { id: 4, name: 'Medieval Madness', opdb_id: 'G5pe4-MePZv', ipdb_id: null, machine_group_id: null, manufacturer: 'Williams', year: 1997, opdb_img: null, machine_type: null, machine_display: null },
];

await pg.query(`INSERT INTO pm_catalog_cache (key, data, fetched_at) VALUES ('machines', $1::jsonb, now())`, [JSON.stringify(CATALOG)]);
await pg.exec(`
  INSERT INTO users (id, clerk_id, username, display_name, role) VALUES
    (1, 'c1', 'boss', 'Boss', 'admin'), (2, 'c2', 'alice', 'Alice', 'user'),
    (3, 'c3', 'bob', 'Bob', 'user'), (4, 'c4', 'cara', 'Cara', 'user');
  INSERT INTO machines (id, name, opdb_id, manufacturer, year) VALUES
    (10, 'Jaws Pro Edition', NULL, NULL, NULL),
    (11, 'JAWS (Pro)', 'GrqZX-MD15K', 'Stern', 2024),
    (12, 'No Good Gofers!', NULL, NULL, NULL),
    (13, 'Medieval Madness', 'G5pe4-MePZv', 'Williams', 1997),
    (14, 'Medieval Madness (Remake)', 'G5pe4-MkPRV', 'Chicago Gaming', 2015),
    (15, 'Attack from Mars', NULL, NULL, NULL);
  SELECT setval('machines_id_seq', 100);
  INSERT INTO venues (id, name, is_residence, privacy_tier, owner_id) VALUES
    (1, 'Bar A', false, 'full', NULL), (2, 'Bar B', false, 'full', NULL), (3, 'Alice Home', true, 'full', 2);
`);
// Scores. Alice's #1 on the AI-read row is inside both challenge windows and has a photo.
await pg.query(`
  INSERT INTO scores (id, user_id, machine_id, score, played_at, venue_id, venue_name, photo_thumbnail, created_at) VALUES
    (1, 2, 10, 50000000, $1, 1, 'Bar A', 'data:image/jpeg;base64,x', $2),
    (2, 2, 10, 20000000, $3, 1, 'Bar A', NULL, $3),
    (3, 3, 10, 30000000, $3, 2, 'Bar B', NULL, $3),
    (4, 3, 11, 40000000, $3, 1, 'Bar A', NULL, $3),
    (5, 2, 12, 9000000, $3, 1, 'Bar A', NULL, $3),
    (6, 4, 14, 7000000, $1, 1, 'Bar A', 'data:image/jpeg;base64,x', $2)`,
  [iso(now - 0.5 * H), iso(now - 0.2 * H), iso(now - 300 * H)]);
await pg.exec(`SELECT setval('scores_id_seq', 100)`);
await pg.query(`
  INSERT INTO venue_machine_history (venue_id, machine_id, first_seen_at, last_seen_at, removed_at) VALUES
    (1, 10, $1, $2, $2),
    (1, 11, $2, $3, NULL),
    (2, 10, $1, $2, NULL)`, [iso(now - 900 * H), iso(now - 500 * H), iso(now - 10 * H)]);
// Inventory at Alice's home: the target row ended, the source row is current → the source's stint wins.
await pg.query(`
  INSERT INTO venue_inventory (venue_id, machine_id, added_at, added_by_id, removed_at, removed_by_id) VALUES
    (3, 11, $1, 2, $2, 2),
    (3, 10, $3, 2, NULL, NULL)`, [iso(now - 900 * H), iso(now - 800 * H), iso(now - 100 * H)]);
// "Challenge me on": Alice picks both (the duplicate goes), Bob only the source (moved).
await pg.exec(`
  INSERT INTO user_challenge_machines (user_id, machine_id, position) VALUES (2, 10, 0), (2, 11, 1), (3, 10, 0);
`);
// Challenges: #1 on the source (game mode, no group — the source has no OPDB id), alice v bob;
// #2 on the target, alice v cara; #3 on Medieval Madness by OPDB group, with cara's Remake score locked in.
await pg.query(`
  INSERT INTO challenges (id, creator_id, type, machine_id, match_mode, match_group, starts_at, ends_at, status) VALUES
    (1, 2, 'high_score', 10, 'game', NULL, $1, $2, 'active'),
    (2, 2, 'high_score', 11, 'exact', NULL, $1, $2, 'active'),
    (3, 4, 'high_score', 13, 'game', 'G5pe4', $1, $2, 'active')`, [iso(now - H), iso(now + 72 * H)]);
await pg.exec(`
  INSERT INTO challenge_participants (challenge_id, user_id, response, responded_at) VALUES
    (1, 2, 'accepted', now()), (1, 3, 'accepted', now()),
    (2, 2, 'accepted', now()), (2, 4, 'accepted', now()),
    (3, 4, 'accepted', now()), (3, 3, 'accepted', now());
  INSERT INTO challenge_scores (challenge_id, score_id) VALUES (3, 6);
  INSERT INTO badges (id, key, name, kind, status, rule) VALUES
    (1, 'shark', 'Shark Week', 'rule', 'live', '{"machine":{"machineId":10,"matchMode":"group","matchGroup":null,"name":"Jaws Pro Edition"}}'),
    (2, 'other', 'Other', 'rule', 'draft', '{"machine":{"machineId":13,"matchMode":"exact","matchGroup":null,"name":"Medieval Madness"}}');
`);

// Point @workspace/db's `db` at PGlite. The lib modules hold the same object, so this reaches them.
const pgdb = drizzle(pg, { schema: dbModule });
const realDb = dbModule.db as any;
for (const m of ['select', 'selectDistinct', 'selectDistinctOn', 'insert', 'update', 'delete', 'execute', 'transaction'] as const) {
  realDb[m] = (pgdb as any)[m].bind(pgdb);
}
setActivityGateForTests(() => true);

const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).appUser = { id: 1, role: 'admin' }; next(); });
app.use('/api/admin', adminMachinesRouter);
// The real guarded admin router, for the 401 / 403 checks.
setAuthForTests({
  resolveClerkId: req => (req.headers['x-test-clerk'] as string | undefined) ?? null,
  loadUser: async clerkId => clerkId === 'clerk_user'
    ? { id: 2, clerkId, username: 'alice', displayName: 'Alice', role: 'user', disabledAt: null } as any
    : undefined,
});
const guarded = express();
guarded.use(express.json());
guarded.use('/api/admin', adminRouter);
const server = app.listen(0);
const guardedServer = guarded.listen(0);
const port = (server.address() as AddressInfo).port;
const guardedPort = (guardedServer.address() as AddressInfo).port;
after(() => { server.close(); guardedServer.close(); setActivityGateForTests(null); });

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}/api/admin${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}
const q = async (text: string, params: unknown[] = []) => (await pg.query<any>(text, params)).rows;
const quiet = async <T>(fn: () => Promise<T>) => {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

/** Everything a merge could touch, for "nothing changed" checks. */
async function snapshot() {
  const out: Record<string, unknown> = {};
  for (const t of ['machines', 'scores', 'venue_machine_history', 'venue_inventory', 'user_challenge_machines',
    'challenges', 'challenge_scores', 'badges', 'activity_events', 'notifications']) {
    out[t] = await q(`SELECT * FROM ${t} ORDER BY 1, 2`);
  }
  return JSON.stringify(out);
}

test('candidates: the canonicalizer suggests the catalog title, search covers rows and the stored catalog', async () => {
  const jaws = await call('GET', '/machines/10/merge-candidates');
  assert.equal(jaws.status, 200);
  assert.equal(jaws.body.suggestion.name, 'JAWS (Pro)');
  assert.equal(jaws.body.suggestion.machineId, 11);
  assert.equal(jaws.body.suggestion.scoreCount, 1);
  assert.equal(jaws.body.source.scoreCount, 3);
  assert.equal(jaws.body.catalogAvailable, true);

  const gofers = await call('GET', '/machines/12/merge-candidates?q=gofers');
  assert.equal(gofers.body.suggestion.name, 'No Good Gofers');
  assert.equal(gofers.body.suggestion.machineId, null, 'a catalog title with no row yet');
  assert.ok(gofers.body.results.some((r: any) => r.name === 'No Good Gofers' && r.inCatalog), 'catalog hit');
  assert.ok(!gofers.body.results.some((r: any) => r.machineId === 12), 'never the source itself');

  const jawsSearch = await call('GET', '/machines/10/merge-candidates?q=jaws');
  const names = jawsSearch.body.results.map((r: any) => r.name);
  assert.ok(names.includes('JAWS (Pro)') && names.includes('JAWS (Premium)'), names.join(', '));
  assert.equal((await call('GET', '/machines/999/merge-candidates')).status, 404);
});

test('dryRun: the preview counts every reference and writes nothing', async () => {
  const before = await snapshot();
  const r = await call('POST', '/machines/10/merge', { targetId: 11, dryRun: true });
  assert.equal(r.status, 200);
  const p = r.body.preview;
  assert.equal(p.target.name, 'JAWS (Pro)');
  assert.equal(p.titlesMatch, true);
  assert.equal(p.scoreCount, 3);
  assert.deepEqual(p.players.map((x: any) => [x.username, x.scoreCount]), [['alice', 2], ['bob', 1]]);
  assert.deepEqual(p.history, { rows: 2, merged: 1 });
  assert.deepEqual(p.inventory, { rows: 1, merged: 1 });
  assert.deepEqual(p.picks, { rows: 2, dropped: 1 });
  assert.deepEqual(p.challenges.map((c: any) => c.id), [1]);
  assert.deepEqual(p.badges.map((b: any) => b.id), [1]);
  assert.equal(p.refs['scores.machine_id'], 3);
  assert.equal(p.refs['badges.rule.machine'], 1);
  assert.equal(p.blocker, null);
  assert.equal(await snapshot(), before, 'nothing written');
});

test('refusals: same machine, different title without confirm, stale count — nothing changes', async () => {
  const before = await snapshot();
  const same = await call('POST', '/machines/10/merge', { targetId: 10 });
  assert.equal(same.status, 400);
  assert.equal(same.body.code, 'same_machine');
  const differ = await call('POST', '/machines/10/merge', { targetId: 15 });
  assert.equal(differ.status, 409);
  assert.equal(differ.body.code, 'titles_differ');
  const differPreview = await call('POST', '/machines/10/merge', { targetId: 15, dryRun: true });
  assert.equal(differPreview.body.preview.titlesMatch, false);
  const stale = await call('POST', '/machines/10/merge', { targetId: 11, expectedScoreCount: 2 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'merge_stale');
  assert.equal(stale.body.scoreCount, 3);
  const unknownName = await call('POST', '/machines/10/merge', { targetName: 'Totally Made Up Machine' });
  assert.equal(unknownName.status, 400);
  assert.equal(unknownName.body.code, 'target_unknown');
  assert.equal(await snapshot(), before);
});

test('a locked score that would stop counting refuses the merge', async () => {
  // Cara's Remake score counts in challenge 3 (Medieval Madness, any model). JAWS isn't in that group.
  const before = await snapshot();
  const r = await call('POST', '/machines/14/merge', { targetId: 11, confirmDifferentTitle: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'locked_scores_would_stop_counting');
  assert.deepEqual(r.body.challengeIds, [3]);
  assert.equal(await snapshot(), before);
});

test('an FK this code does not know about refuses the merge', async () => {
  await pg.exec(`CREATE TABLE zz_machine_notes (id serial PRIMARY KEY, machine_id integer REFERENCES machines(id)); INSERT INTO zz_machine_notes (machine_id) VALUES (10);`);
  try {
    const before = await snapshot();
    const r = await call('POST', '/machines/10/merge', { targetId: 11 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'unknown_references');
    assert.deepEqual(r.body.refs, { 'zz_machine_notes.machine_id': 1 });
    assert.equal(await snapshot(), before);
  } finally {
    await pg.exec(`DROP TABLE zz_machine_notes`);
  }
});

test('a failure mid-merge rolls everything back', async () => {
  await pg.exec(`
    CREATE FUNCTION zz_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
    CREATE TRIGGER zz_refuse_delete BEFORE DELETE ON machines FOR EACH ROW EXECUTE FUNCTION zz_refuse_delete();`);
  try {
    const before = await snapshot();
    const r = await quiet(() => call('POST', '/machines/10/merge', { targetId: 11 }));
    assert.equal(r.status, 500);
    assert.equal(await snapshot(), before, 'scores, history, inventory, picks, challenges, badges and the log untouched');
  } finally {
    await pg.exec(`DROP TRIGGER zz_refuse_delete ON machines; DROP FUNCTION zz_refuse_delete();`);
  }
});

test('the merge: every reference moved or merged, challenges re-counted, source retired, logged', async () => {
  const r = await call('POST', '/machines/10/merge', { targetId: 11, expectedScoreCount: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.merged, true);
  assert.deepEqual(r.body.target, { id: 11, name: 'JAWS (Pro)' });
  assert.equal(r.body.scoresMoved, 3);
  assert.deepEqual(r.body.dependents, { historyMoved: 1, historyMerged: 1, inventoryMoved: 0, inventoryMerged: 1, picksMoved: 1, picksDropped: 1 });
  assert.deepEqual(r.body.challengesRepointed, [1]);
  assert.deepEqual(r.body.badgesRepointed, [1]);

  assert.deepEqual(await q(`SELECT id FROM machines WHERE id = 10`), [], 'source deleted');
  assert.deepEqual((await q(`SELECT id FROM scores WHERE machine_id = 11 ORDER BY id`)).map(x => x.id), [1, 2, 3, 4]);

  // History: venue 1 had both → one row, earliest first-seen, still there (the target's row is current).
  const hist = await q(`SELECT venue_id, machine_id, first_seen_at, removed_at FROM venue_machine_history ORDER BY venue_id`);
  assert.equal(hist.length, 2);
  assert.ok(hist.every(h => h.machine_id === 11));
  assert.equal(new Date(hist[0].first_seen_at).getTime(), new Date(iso(now - 900 * H)).getTime());
  assert.equal(hist[0].removed_at, null);
  assert.equal(hist[1].venue_id, 2);

  // Inventory: the source's current stint replaced the target's ended one.
  const inv = await q(`SELECT machine_id, added_at, removed_at FROM venue_inventory`);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].machine_id, 11);
  assert.equal(inv[0].removed_at, null);
  assert.equal(new Date(inv[0].added_at).getTime(), new Date(iso(now - 100 * H)).getTime());

  // Picks: alice keeps one (no duplicate), bob's moved.
  assert.deepEqual(await q(`SELECT user_id, machine_id FROM user_challenge_machines ORDER BY user_id`),
    [{ user_id: 2, machine_id: 11 }, { user_id: 3, machine_id: 11 }]);

  // Challenge 1 is on the target, with the target's OPDB group ('game' mode had none).
  const [c1] = await q(`SELECT machine_id, match_group FROM challenges WHERE id = 1`);
  assert.deepEqual(c1, { machine_id: 11, match_group: 'GrqZX' });
  // Re-counted: alice's photo score counts in #1 (re-pointed) and in #2 (already on the target).
  assert.deepEqual(await q(`SELECT challenge_id, score_id FROM challenge_scores WHERE score_id = 1 ORDER BY challenge_id`),
    [{ challenge_id: 1, score_id: 1 }, { challenge_id: 2, score_id: 1 }]);
  const told = await q(`SELECT user_id, kind FROM notifications WHERE kind = 'challenge_opponent_scored' ORDER BY user_id`);
  assert.deepEqual(told.map(n => n.user_id), [3, 4], 'bob (challenge 1) and cara (challenge 2) are told');
  assert.equal(r.body.recount.errors, 0);

  // Badge rule re-pointed, with the target's group; the other badge untouched.
  const [b1] = await q(`SELECT rule FROM badges WHERE id = 1`);
  assert.deepEqual(b1.rule.machine, { machineId: 11, matchMode: 'group', matchGroup: 'GrqZX', name: 'JAWS (Pro)' });
  const [b2] = await q(`SELECT rule FROM badges WHERE id = 2`);
  assert.equal(b2.rule.machine.machineId, 13);

  const [ev] = await q(`SELECT actor_user_id, target_type, target_id, payload FROM activity_events WHERE type = 'admin.machine_merged'`);
  assert.equal(ev.actor_user_id, 1);
  assert.equal(ev.target_type, 'machine');
  assert.equal(ev.target_id, '11');
  assert.equal(ev.payload.fromMachineId, 10);
  assert.equal(ev.payload.fromName, 'Jaws Pro Edition');
  assert.equal(ev.payload.toName, 'JAWS (Pro)');
  assert.equal(ev.payload.scoresMoved, 3);
  assert.deepEqual(ev.payload.challengeIds, [1]);
});

test('merging into a catalog title with no row creates it from the stored catalog', async () => {
  const preview = await call('POST', '/machines/12/merge', { targetName: 'No Good Gofers', dryRun: true });
  assert.equal(preview.body.preview.target.id, null);
  assert.equal(preview.body.preview.target.imageUrl, 'https://img/ngg.jpg');
  assert.equal(preview.body.preview.titlesMatch, true);
  const r = await call('POST', '/machines/12/merge', { targetName: 'No Good Gofers' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.targetCreated, true);
  const [row] = await q(`SELECT id, name, opdb_id, image_url, manufacturer, year FROM machines WHERE name = 'No Good Gofers'`);
  assert.equal(row.id, r.body.target.id);
  assert.deepEqual([row.opdb_id, row.image_url, row.manufacturer, row.year], ['GrknN-MQrdv', 'https://img/ngg.jpg', 'Williams', 1997]);
  assert.deepEqual((await q(`SELECT machine_id FROM scores WHERE id = 5`))[0], { machine_id: row.id });
  assert.deepEqual(await q(`SELECT id FROM machines WHERE id = 12`), []);
});

test('the shared statements also run as raw parameterised SQL (cleanup-machine-dupes.ts path)', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { mergeMachineDependents, machineForeignKeys, machineRefCounts } = await import('./machineMerge.js');
  const dialect = new PgDialect();
  const run = async (s: any) => {
    const { sql: text, params } = dialect.sqlToQuery(s);
    return (await pg.query<any>(text, params as any[])).rows;
  };
  await pg.exec(`
    INSERT INTO machines (id, name) VALUES (60, 'Pokemon (Pro)'), (61, 'Pokémon (Pro)');
    INSERT INTO venue_machine_history (venue_id, machine_id) VALUES (2, 60), (2, 61), (1, 60);
    INSERT INTO user_challenge_machines (user_id, machine_id) VALUES (4, 60);`);
  const fks = await machineForeignKeys(run);
  assert.ok(fks.some(f => f.table === 'scores' && f.column === 'machine_id'));
  const merged = await mergeMachineDependents(run, 60, 61);
  assert.deepEqual(merged, { historyMoved: 1, historyMerged: 1, inventoryMoved: 0, inventoryMerged: 0, picksMoved: 1, picksDropped: 0 });
  assert.ok(Object.values(await machineRefCounts(run, 60, fks)).every(n => n === 0));
});

test('guard: guests get 401 and ordinary users 403 on both routes', async () => {
  for (const [method, path] of [['GET', '/machines/11/merge-candidates'], ['POST', '/machines/11/merge']]) {
    const hit = (clerk?: string) => fetch(`http://localhost:${guardedPort}/api/admin${path}`, {
      method, headers: { 'content-type': 'application/json', ...(clerk ? { 'x-test-clerk': clerk } : {}) },
      body: method === 'POST' ? JSON.stringify({ targetId: 13, dryRun: true }) : undefined,
    });
    assert.equal((await hit()).status, 401, `${method} ${path} guest`);
    assert.equal((await hit('clerk_user')).status, 403, `${method} ${path} user`);
  }
});
