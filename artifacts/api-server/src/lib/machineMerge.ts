import {
  db, machines, scores, users, challenges, challengeScores, badges, userChallengeMachines,
  venueMachineHistory, venueInventory, type Machine,
} from '@workspace/db';
import { asc, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from './notify.js';
import { resolveCanonicalName } from './machineCanonical.js';
import { buildSearchIndex, searchIndex } from './machineSearch.js';
import { getStoredCatalog, type PinballMachine } from './pinballMap.js';
import { upsertMachineByName } from './machineUpsert.js';
import { retireMachineIfUnused } from './venueRepair.js';
import { opdbGroup } from './challengeRules.js';
import { logActivity, type ActivityInput } from './activity.js';
import { onScoreCreated, syncChallenge } from './challenges.js';

// Admin "Fix this machine" (POST /api/admin/machines/:id/merge, routes/adminMachines.ts): fold a
// mis-named machine row ("Jaws Pro Edition", an AI read saved verbatim) into the right one ("JAWS
// (Pro)") — every reference moved, then the source row deleted, in ONE transaction.
//
// Everything that references machines(id) is discovered from pg_constraint (machineForeignKeys), so a
// new FK can't be silently missed: a reference from a table this file doesn't know how to move
// refuses the merge (409 unknown_references). Today's FKs, and what happens to each:
//   scores.machine_id                  — moved (the point of the exercise).
//   venue_machine_history.machine_id   — merged per unique (venue, machine): earliest first-seen,
//                                         latest last-seen, still there if either row says so.
//   venue_inventory.machine_id         — merged per unique (venue, machine): the current stint wins
//                                         (both current → earlier start; both ended → later end).
//   user_challenge_machines.machine_id — moved; a user who already picks the target just loses the
//                                         duplicate pick, so the 3-pick cap can't be exceeded.
//   challenges.machine_id              — re-pointed; see "Challenges" below.
// Plus one reference with no FK: badge rules (badges.rule -> machine -> machineId) — re-pointed.
//
// Challenges: a challenge on the source is the same game on the target, so it's re-pointed
// (match_group kept; a 'game'-mode challenge with no group — the source had no OPDB id — takes the
// target's group, which is what "any model" meant). Locked scores (challenge_scores) move with their
// machine and keep counting. One case is refused: a source score locked into a challenge on ANOTHER
// machine through its OPDB group that the target isn't in — it would silently stop matching
// (409 locked_scores_would_stop_counting). After the commit every re-pointed challenge is re-synced
// (syncChallenge) and every moved score that wasn't already locked goes through onScoreCreated —
// exactly what the per-score repair does — so a score that now matches a challenge on the target
// counts, races resolve and opponents are told. Both never block the merge (it's committed by then).
//
// Badge rules are re-pointed, not refused: the rule meant this physical machine, and a refusal would
// leave a junk row that can never be fixed from the UI. Nothing already awarded changes (badges never
// revoke); moved scores can earn a rule badge on its next trigger / the admin's "Backfill now".
//
// Never calls Pinball Map: the catalog is the stored copy (getStoredCatalog), at any age.

export class MachineMergeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Run one SQL statement and get its rows — lets the one-off cleanup script (raw postgres.js) share this code. */
export type RunSql = (q: SQL) => Promise<Record<string, any>[]>;

const rowsOf = (r: unknown): Record<string, any>[] =>
  Array.isArray(r) ? r : ((r as { rows?: Record<string, any>[] })?.rows ?? []);

export const runOn = (ex: Executor): RunSql => async q => rowsOf(await ex.execute(q));

export interface MachineFk { table: string; column: string }
const fkKey = (f: MachineFk) => `${f.table}.${f.column}`;

/** The references a merge knows how to move. */
export const MOVABLE_REFS = new Set([
  'scores.machine_id', 'venue_machine_history.machine_id', 'venue_inventory.machine_id',
  'user_challenge_machines.machine_id', 'challenges.machine_id',
]);
export const BADGE_RULE_REF = 'badges.rule.machine';

/** Every FK column that references machines(id), from the catalogue. */
export async function machineForeignKeys(run: RunSql): Promise<MachineFk[]> {
  const rows = await run(sql`
    SELECT cl.relname AS "table", att.attname AS "column"
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
     WHERE con.contype = 'f' AND con.confrelid = 'public.machines'::regclass
     ORDER BY 1, 2`);
  return rows.map(r => ({ table: String(r.table), column: String(r.column) }));
}

/** Rows referencing `id`, per FK column, plus badge rules (`badges.rule.machine`). */
export async function machineRefCounts(run: RunSql, id: number, fks: MachineFk[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const f of fks) {
    const [r] = await run(sql`SELECT count(*)::int AS n FROM ${sql.identifier(f.table)} WHERE ${sql.identifier(f.column)} = ${id}`);
    out[fkKey(f)] = Number(r?.n ?? 0);
  }
  const [b] = await run(sql`SELECT count(*)::int AS n FROM badges WHERE (rule -> 'machine' ->> 'machineId') = ${String(id)}`);
  out[BADGE_RULE_REF] = Number(b?.n ?? 0);
  return out;
}

export interface DependentsMerged {
  historyMoved: number;
  historyMerged: number;
  inventoryMoved: number;
  inventoryMerged: number;
  picksMoved: number;
  picksDropped: number;
}

/**
 * Moves venue_machine_history, venue_inventory and user_challenge_machines from `fromId` to `toId`,
 * merging rows that would collide on their unique (venue, machine) / (user, machine) keys. Shared
 * with cleanup-machine-dupes.ts. Call inside a transaction.
 */
export async function mergeMachineDependents(run: RunSql, fromId: number, toId: number): Promise<DependentsMerged> {
  // venue_machine_history: same machine under two names at one venue → one row, earliest first-seen,
  // latest last-seen, and still there if either row says so.
  const histMerged = await run(sql`
    UPDATE venue_machine_history t
       SET first_seen_at = LEAST(t.first_seen_at, s.first_seen_at),
           last_seen_at  = GREATEST(t.last_seen_at, s.last_seen_at),
           removed_at    = CASE WHEN t.removed_at IS NULL OR s.removed_at IS NULL THEN NULL
                                ELSE GREATEST(t.removed_at, s.removed_at) END
      FROM venue_machine_history s
     WHERE s.machine_id = ${fromId} AND t.machine_id = ${toId} AND t.venue_id = s.venue_id
    RETURNING t.id`);
  await run(sql`
    DELETE FROM venue_machine_history s
     WHERE s.machine_id = ${fromId}
       AND EXISTS (SELECT 1 FROM venue_machine_history t WHERE t.machine_id = ${toId} AND t.venue_id = s.venue_id)`);
  const histMoved = await run(sql`UPDATE venue_machine_history SET machine_id = ${toId} WHERE machine_id = ${fromId} RETURNING id`);

  // venue_inventory: the current stint wins; both current → the earlier start; both ended → the
  // later end (the same rule as venueMerge.ts). `pick` = take the source row's stint.
  const invMerged = await run(sql`
    WITH pairs AS (
      SELECT t.id AS tid, s.added_at, s.added_by_id, s.removed_at, s.removed_by_id,
             CASE
               WHEN t.removed_at IS NULL AND s.removed_at IS NULL THEN s.added_at < t.added_at
               WHEN t.removed_at IS NULL THEN false
               WHEN s.removed_at IS NULL THEN true
               ELSE s.removed_at > t.removed_at
             END AS pick
        FROM venue_inventory t
        JOIN venue_inventory s ON s.venue_id = t.venue_id AND s.machine_id = ${fromId}
       WHERE t.machine_id = ${toId}
    )
    UPDATE venue_inventory t
       SET added_at = CASE WHEN p.pick THEN p.added_at ELSE t.added_at END,
           added_by_id = CASE WHEN p.pick THEN p.added_by_id ELSE t.added_by_id END,
           removed_at = CASE WHEN p.pick THEN p.removed_at ELSE t.removed_at END,
           removed_by_id = CASE WHEN p.pick THEN p.removed_by_id ELSE t.removed_by_id END
      FROM pairs p
     WHERE t.id = p.tid
    RETURNING t.id`);
  await run(sql`
    DELETE FROM venue_inventory s
     WHERE s.machine_id = ${fromId}
       AND EXISTS (SELECT 1 FROM venue_inventory t WHERE t.machine_id = ${toId} AND t.venue_id = s.venue_id)`);
  const invMoved = await run(sql`UPDATE venue_inventory SET machine_id = ${toId} WHERE machine_id = ${fromId} RETURNING id`);

  // user_challenge_machines: PK (user, machine). Dropping a duplicate pick never adds one, so the
  // 3-pick cap holds.
  const picksDropped = await run(sql`
    DELETE FROM user_challenge_machines s
     WHERE s.machine_id = ${fromId}
       AND EXISTS (SELECT 1 FROM user_challenge_machines t WHERE t.machine_id = ${toId} AND t.user_id = s.user_id)
    RETURNING s.user_id`);
  const picksMoved = await run(sql`UPDATE user_challenge_machines SET machine_id = ${toId} WHERE machine_id = ${fromId} RETURNING user_id`);

  return {
    historyMoved: histMoved.length, historyMerged: histMerged.length,
    inventoryMoved: invMoved.length, inventoryMerged: invMerged.length,
    picksMoved: picksMoved.length, picksDropped: picksDropped.length,
  };
}

// ── preview ──────────────────────────────────────────────────────────────────

export interface MachineBrief {
  /** null = a catalog title with no TiltTrack row yet — the merge creates it. */
  id: number | null;
  name: string;
  manufacturer: string | null;
  year: number | null;
  imageUrl: string | null;
  opdbId: string | null;
}

export type MergeBlockerCode = 'same_machine' | 'unknown_references' | 'locked_scores_would_stop_counting';

export interface MachineMergePreview {
  source: MachineBrief;
  target: MachineBrief;
  /** The canonicalizer says these are the same title. False → the merge needs `confirmDifferentTitle`. */
  titlesMatch: boolean;
  scoreCount: number;
  players: Array<{ userId: number; username: string; scoreCount: number }>;
  history: { rows: number; merged: number };
  inventory: { rows: number; merged: number };
  picks: { rows: number; dropped: number };
  challenges: Array<{ id: number; status: string; type: string }>;
  /** Source scores that count toward a challenge (they stay locked, on the target). */
  lockedScores: number;
  badges: Array<{ id: number; name: string; status: string }>;
  /** Reference counts per FK column (+ badge rules) — every table, for the confirm dialog. */
  refs: Record<string, number>;
  blocker: { code: MergeBlockerCode; message: string; challengeIds?: number[]; refs?: Record<string, number> } | null;
}

export interface MergeInput {
  targetId?: unknown;
  targetName?: unknown;
  confirmDifferentTitle?: unknown;
  expectedScoreCount?: unknown;
}

interface ResolvedTarget {
  row: Machine | null;
  name: string;
  catalogEntry: PinballMachine | null;
}

const brief = (m: Machine): MachineBrief => ({
  id: m.id, name: m.name, manufacturer: m.manufacturer, year: m.year, imageUrl: m.imageUrl, opdbId: m.opdbId,
});
const briefFromTarget = (t: ResolvedTarget): MachineBrief => t.row ? brief(t.row) : {
  id: null, name: t.name,
  manufacturer: t.catalogEntry?.manufacturer ?? null, year: t.catalogEntry?.year ?? null,
  imageUrl: t.catalogEntry?.opdb_img ?? null, opdbId: t.catalogEntry?.opdb_id ?? null,
};

/** Same title per the shared canonicalizer ("Jaws Pro Edition" = "JAWS (Pro)", Pro ≠ Premium). */
export function titlesMatch(sourceName: string, targetName: string): boolean {
  return resolveCanonicalName(sourceName, { catalog: [{ name: targetName }] }) !== null;
}

async function loadMachine(ex: Executor, id: number): Promise<Machine | null> {
  const [m] = await ex.select().from(machines).where(eq(machines.id, id)).limit(1);
  return m ?? null;
}

function parseId(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The target: an existing row by id, or a name — an existing row's exact name, else a Pinball Map
 * catalog title (via the canonicalizer, against the STORED catalog). A name that is neither is
 * refused: this never mints a free-typed machine row.
 */
async function resolveTarget(ex: Executor, input: MergeInput, catalog: PinballMachine[] | null): Promise<ResolvedTarget> {
  if (input.targetId != null && input.targetId !== '') {
    const id = parseId(input.targetId);
    if (id == null) throw new MachineMergeError(400, 'invalid_target', 'targetId must be a machine id');
    const row = await loadMachine(ex, id);
    if (!row) throw new MachineMergeError(404, 'target_not_found', 'That machine doesn’t exist');
    return { row, name: row.name, catalogEntry: null };
  }
  const name = typeof input.targetName === 'string' ? input.targetName.trim().slice(0, 200) : '';
  if (!name) throw new MachineMergeError(400, 'target_required', 'Pick the machine to merge into');
  const [exact] = await ex.select().from(machines).where(eq(machines.name, name)).limit(1);
  if (exact) return { row: exact, name: exact.name, catalogEntry: null };
  const ci = await ex.select().from(machines).where(sql`lower(${machines.name}) = lower(${name})`).limit(2);
  if (ci.length === 1) return { row: ci[0], name: ci[0].name, catalogEntry: null };
  const match = catalog ? resolveCanonicalName(name, { catalog }) : null;
  if (!match) {
    throw new MachineMergeError(400, 'target_unknown', 'Pick an existing machine or a Pinball Map catalog title');
  }
  const [row] = await ex.select().from(machines).where(eq(machines.name, match.name)).limit(1);
  return { row: row ?? null, name: match.name, catalogEntry: match.entry };
}

const BLOCKER_MESSAGES: Record<MergeBlockerCode, string> = {
  same_machine: 'A machine can’t be merged into itself',
  unknown_references: 'Something this merge doesn’t know how to move references this machine — it needs a developer',
  locked_scores_would_stop_counting:
    'A score on this machine counts toward a challenge on another model of the game that the target isn’t part of — moving it would change that challenge',
};

async function buildPlan(ex: Executor, source: Machine, target: ResolvedTarget, fks: MachineFk[]): Promise<MachineMergePreview> {
  const tgt = briefFromTarget(target);
  const tid = target.row?.id ?? null;

  const players = (await ex
    .select({ userId: scores.userId, username: users.username, scoreCount: count() })
    .from(scores).innerJoin(users, eq(users.id, scores.userId))
    .where(eq(scores.machineId, source.id))
    .groupBy(scores.userId, users.username))
    .map(p => ({ ...p, scoreCount: Number(p.scoreCount) }))
    .sort((a, b) => b.scoreCount - a.scoreCount || a.username.localeCompare(b.username));

  const overlap = async (table: typeof venueMachineHistory | typeof venueInventory) => {
    const rows = await ex.select({ venueId: table.venueId, machineId: table.machineId }).from(table)
      .where(inArray(table.machineId, tid != null ? [source.id, tid] : [source.id]));
    const src = rows.filter(r => r.machineId === source.id).map(r => r.venueId);
    const tgtVenues = new Set(rows.filter(r => r.machineId === tid).map(r => r.venueId));
    return { rows: src.length, merged: src.filter(v => tgtVenues.has(v)).length };
  };
  const history = await overlap(venueMachineHistory);
  const inventory = await overlap(venueInventory);

  const pickRows = await ex.select({ userId: userChallengeMachines.userId, machineId: userChallengeMachines.machineId })
    .from(userChallengeMachines)
    .where(inArray(userChallengeMachines.machineId, tid != null ? [source.id, tid] : [source.id]));
  const srcPickers = pickRows.filter(r => r.machineId === source.id).map(r => r.userId);
  const tgtPickers = new Set(pickRows.filter(r => r.machineId === tid).map(r => r.userId));

  const challengeRows = await ex.select({ id: challenges.id, status: challenges.status, type: challenges.type })
    .from(challenges).where(eq(challenges.machineId, source.id)).orderBy(asc(challenges.id));

  const locked = await ex
    .select({ challengeId: challengeScores.challengeId, scoreId: challengeScores.scoreId, machineId: challenges.machineId, matchGroup: challenges.matchGroup })
    .from(challengeScores)
    .innerJoin(scores, eq(scores.id, challengeScores.scoreId))
    .innerJoin(challenges, eq(challenges.id, challengeScores.challengeId))
    .where(eq(scores.machineId, source.id));
  const targetGroup = opdbGroup(tgt.opdbId);
  const stranded = locked.filter(l =>
    l.machineId !== source.id && l.machineId !== tid && !(l.matchGroup && l.matchGroup === targetGroup));

  const badgeRows = (await ex.select({ id: badges.id, name: badges.name, status: badges.status }).from(badges)
    .where(sql`(${badges.rule} -> 'machine' ->> 'machineId') = ${String(source.id)}`)
    .orderBy(asc(badges.id)));

  const refs = await machineRefCounts(runOn(ex), source.id, fks);
  const unknown = Object.fromEntries(Object.entries(refs).filter(([k, n]) => n > 0 && k !== BADGE_RULE_REF && !MOVABLE_REFS.has(k)));

  let blocker: MachineMergePreview['blocker'] = null;
  if (tid === source.id || (tid == null && target.name === source.name)) {
    blocker = { code: 'same_machine', message: BLOCKER_MESSAGES.same_machine };
  } else if (Object.keys(unknown).length) {
    blocker = { code: 'unknown_references', message: BLOCKER_MESSAGES.unknown_references, refs: unknown };
  } else if (stranded.length) {
    blocker = {
      code: 'locked_scores_would_stop_counting', message: BLOCKER_MESSAGES.locked_scores_would_stop_counting,
      challengeIds: [...new Set(stranded.map(s => s.challengeId))].sort((a, b) => a - b),
    };
  }

  return {
    source: brief(source),
    target: tgt,
    titlesMatch: titlesMatch(source.name, tgt.name),
    scoreCount: players.reduce((n, p) => n + p.scoreCount, 0),
    players,
    history,
    inventory,
    picks: { rows: srcPickers.length, dropped: srcPickers.filter(u => tgtPickers.has(u)).length },
    challenges: challengeRows.map(c => ({ id: c.id, status: String(c.status), type: String(c.type) })),
    lockedScores: new Set(locked.map(l => l.scoreId)).size,
    badges: badgeRows.map(b => ({ id: b.id, name: b.name, status: String(b.status) })),
    refs,
    blocker,
  };
}

/** POST …/merge with dryRun: what the merge would do. Reads only. */
export async function previewMachineMerge(sourceId: number, input: MergeInput): Promise<MachineMergePreview> {
  const source = await loadMachine(db, sourceId);
  if (!source) throw new MachineMergeError(404, 'machine_not_found', 'Machine not found');
  const catalog = await getStoredCatalog();
  const target = await resolveTarget(db, input, catalog);
  return buildPlan(db, source, target, await machineForeignKeys(runOn(db)));
}

// ── apply ────────────────────────────────────────────────────────────────────

export interface MachineMergeResult {
  source: { id: number; name: string };
  target: { id: number; name: string };
  targetCreated: boolean;
  scoresMoved: number;
  players: MachineMergePreview['players'];
  dependents: DependentsMerged;
  challengesRepointed: number[];
  badgesRepointed: number[];
  /** Challenges re-synced after the commit, and moved scores re-run through onScoreCreated. */
  recount: { challengesSynced: number; scoresChecked: number; errors: number };
}

/**
 * Folds `sourceId` into the target in one transaction (both machine rows locked FOR UPDATE in id
 * order, then the source's scores and challenges), re-checking everything the preview said against
 * the locked rows. Any failure rolls the whole merge back. Challenge counting runs after the commit.
 */
export async function applyMachineMerge(
  sourceId: number,
  input: MergeInput,
  meta: Pick<ActivityInput, 'actorUserId' | 'ip' | 'userAgent'>,
): Promise<MachineMergeResult> {
  const catalog = await getStoredCatalog();
  const expected = input.expectedScoreCount == null ? null : Number(input.expectedScoreCount);
  if (expected != null && !Number.isInteger(expected)) throw new MachineMergeError(400, 'invalid_expected_count', 'expectedScoreCount must be a whole number');

  const out = await db.transaction(async tx => {
    const source0 = await loadMachine(tx, sourceId);
    if (!source0) throw new MachineMergeError(404, 'machine_not_found', 'Machine not found');
    let target = await resolveTarget(tx, input, catalog);
    if (target.row?.id === source0.id || (!target.row && target.name === source0.name)) {
      throw new MachineMergeError(400, 'same_machine', BLOCKER_MESSAGES.same_machine);
    }
    let targetCreated = false;
    if (!target.row) {
      // A catalog title with no row yet: created from the stored catalog only (no Pinball Map call).
      const row = await upsertMachineByName(target.name, { catalog, ex: tx });
      if (row.id === source0.id) throw new MachineMergeError(400, 'same_machine', BLOCKER_MESSAGES.same_machine);
      target = { ...target, row };
      targetCreated = true;
    }

    const ids = [source0.id, target.row!.id].sort((a, b) => a - b);
    const locked = await tx.select().from(machines).where(inArray(machines.id, ids)).orderBy(asc(machines.id)).for('update');
    const source = locked.find(m => m.id === source0.id);
    const tRow = locked.find(m => m.id === target.row!.id);
    if (!source || !tRow) throw new MachineMergeError(409, 'machine_gone', 'One of these machines no longer exists — reload the page');
    target = { ...target, row: tRow };
    await tx.select({ id: scores.id }).from(scores).where(eq(scores.machineId, source.id)).for('update');
    await tx.select({ id: challenges.id }).from(challenges).where(eq(challenges.machineId, source.id)).orderBy(asc(challenges.id)).for('update');

    const plan = await buildPlan(tx, source, target, await machineForeignKeys(runOn(tx)));
    if (plan.blocker) {
      throw new MachineMergeError(plan.blocker.code === 'same_machine' ? 400 : 409, plan.blocker.code, plan.blocker.message, {
        ...(plan.blocker.challengeIds ? { challengeIds: plan.blocker.challengeIds } : {}),
        ...(plan.blocker.refs ? { refs: plan.blocker.refs } : {}),
      });
    }
    if (!plan.titlesMatch && input.confirmDifferentTitle !== true) {
      throw new MachineMergeError(409, 'titles_differ',
        `“${source.name}” and “${tRow.name}” don’t look like the same title — confirm to merge anyway`);
    }
    if (expected != null && expected !== plan.scoreCount) {
      throw new MachineMergeError(409, 'merge_stale', 'Scores on this machine changed since the preview — check it again', { scoreCount: plan.scoreCount });
    }

    const lockedBefore = new Set((await tx.select({ scoreId: challengeScores.scoreId }).from(challengeScores)
      .innerJoin(scores, eq(scores.id, challengeScores.scoreId)).where(eq(scores.machineId, source.id))).map(r => r.scoreId));

    // 1. Scores.
    const moved = await tx.update(scores).set({ machineId: tRow.id }).where(eq(scores.machineId, source.id))
      .returning({ id: scores.id, userId: scores.userId });

    // 2. History, inventory, challenge picks.
    const dependents = await mergeMachineDependents(runOn(tx), source.id, tRow.id);

    // 3. Challenges on the source → the target (see the header).
    const targetGroup = opdbGroup(tRow.opdbId);
    const repointed = await tx.select({ id: challenges.id, matchMode: challenges.matchMode, matchGroup: challenges.matchGroup })
      .from(challenges).where(eq(challenges.machineId, source.id)).orderBy(asc(challenges.id));
    for (const c of repointed) {
      await tx.update(challenges).set({
        machineId: tRow.id,
        matchGroup: c.matchGroup ?? (c.matchMode === 'game' ? targetGroup : null),
      }).where(eq(challenges.id, c.id));
    }

    // 4. Badge rules naming the source.
    const badgeRows = await tx.select({ id: badges.id, rule: badges.rule }).from(badges)
      .where(sql`(${badges.rule} -> 'machine' ->> 'machineId') = ${String(source.id)}`).for('update');
    for (const b of badgeRows) {
      const rule = { ...(b.rule ?? {}) } as Record<string, any>;
      const m = { ...(rule.machine ?? {}) };
      const group = m.matchMode === 'group' ? (m.matchGroup ?? targetGroup ?? null) : null;
      rule.machine = { ...m, machineId: tRow.id, name: tRow.name, matchGroup: group };
      await tx.update(badges).set({ rule, updatedAt: new Date() }).where(eq(badges.id, b.id));
    }

    // 5. The source goes. Anything still pointing at it is a bug in this file — roll everything back.
    const left = await machineRefCounts(runOn(tx), source.id, await machineForeignKeys(runOn(tx)));
    const remaining = Object.entries(left).filter(([, n]) => n > 0);
    if (remaining.length) throw new Error(`machine merge ${source.id} → ${tRow.id}: references remain (${remaining.map(([k, n]) => `${k}=${n}`).join(', ')})`);
    if (!(await retireMachineIfUnused(source.id, tx))) throw new Error(`machine merge ${source.id} → ${tRow.id}: source not retired`);

    const result: Omit<MachineMergeResult, 'recount'> = {
      source: { id: source.id, name: source.name },
      target: { id: tRow.id, name: tRow.name },
      targetCreated,
      scoresMoved: moved.length,
      players: plan.players,
      dependents,
      challengesRepointed: repointed.map(c => c.id),
      badgesRepointed: badgeRows.map(b => b.id),
    };
    await logActivity({
      type: 'admin.machine_merged', ...meta, targetType: 'machine', targetId: tRow.id,
      payload: {
        fromMachineId: source.id, fromName: source.name, toMachineId: tRow.id, toName: tRow.name, targetCreated,
        titlesMatched: plan.titlesMatch, scoresMoved: moved.length, players: plan.players.length,
        ...dependents, challengeIds: result.challengesRepointed, badgeIds: result.badgesRepointed,
        lockedScores: plan.lockedScores,
      },
    }, { tx });
    return { result, moved, lockedBefore };
  });

  // After the commit: challenge standings. Neither step can undo the merge, so failures are logged.
  const recount = { challengesSynced: 0, scoresChecked: 0, errors: 0 };
  for (const id of out.result.challengesRepointed) {
    try {
      await syncChallenge(id);
      recount.challengesSynced++;
    } catch (err) {
      recount.errors++;
      console.error(`Machine merge: re-syncing challenge ${id} failed:`, err);
    }
  }
  for (const s of out.moved) {
    if (out.lockedBefore.has(s.id)) continue; // already counted where it counts; its challenge was re-synced above
    await onScoreCreated({ id: s.id, userId: s.userId }); // never throws
    recount.scoresChecked++;
  }
  return { ...out.result, recount };
}

// ── candidates ───────────────────────────────────────────────────────────────

export interface MergeCandidate {
  name: string;
  /** The TiltTrack row, or null for a catalog title nobody has logged yet. */
  machineId: number | null;
  scoreCount: number;
  inCatalog: boolean;
  manufacturer: string | null;
  year: number | null;
  imageUrl: string | null;
}

export interface MergeCandidates {
  source: MachineBrief & { scoreCount: number };
  suggestion: (MergeCandidate & { confidence: string }) | null;
  results: MergeCandidate[];
  catalogAvailable: boolean;
}

/**
 * GET …/merge-candidates?q= — the canonicalizer's suggestion for this machine (stored catalog first,
 * then the other machine rows) plus a search over existing machines and the stored catalog.
 */
export async function mergeCandidates(sourceId: number, q: string): Promise<MergeCandidates> {
  const source = await loadMachine(db, sourceId);
  if (!source) throw new MachineMergeError(404, 'machine_not_found', 'Machine not found');
  const catalog = await getStoredCatalog();
  const rows = (await db.select().from(machines)).filter(m => m.id !== source.id);
  const byLower = new Map(rows.map(m => [m.name.toLowerCase(), m]));
  const catalogByLower = new Map<string, PinballMachine>();
  for (const c of catalog ?? []) if (!catalogByLower.has(c.name.toLowerCase())) catalogByLower.set(c.name.toLowerCase(), c);

  const candidate = (name: string): MergeCandidate => {
    const row = byLower.get(name.toLowerCase()) ?? null;
    const cat = catalogByLower.get(name.toLowerCase()) ?? null;
    return {
      name: row?.name ?? name,
      machineId: row?.id ?? null,
      scoreCount: 0,
      inCatalog: !!cat,
      manufacturer: row?.manufacturer ?? cat?.manufacturer ?? null,
      year: row?.year ?? cat?.year ?? null,
      imageUrl: row?.imageUrl ?? cat?.opdb_img ?? null,
    };
  };

  let suggestion: MergeCandidates['suggestion'] = null;
  const fromCatalog = catalog ? resolveCanonicalName(source.name, { catalog }) : null;
  if (fromCatalog && fromCatalog.name !== source.name) {
    suggestion = { ...candidate(fromCatalog.name), confidence: fromCatalog.confidence };
  } else {
    const fromRows = resolveCanonicalName(source.name, { catalog: rows });
    if (fromRows) suggestion = { ...candidate(fromRows.name), confidence: fromRows.confidence };
  }

  const results: MergeCandidate[] = [];
  const query = q.trim().slice(0, 100);
  if (query) {
    const seen = new Set<string>();
    const add = (name: string) => {
      const k = name.toLowerCase();
      if (seen.has(k) || k === source.name.toLowerCase()) return;
      seen.add(k);
      results.push(candidate(name));
    };
    for (const m of searchIndex(buildSearchIndex(rows), query, 8)) add(m.name);
    if (catalog) for (const c of searchIndex(catalogIndexFor(catalog), query, 8)) add(c.name);
  }

  const ids = [...results, ...(suggestion ? [suggestion] : [])].map(c => c.machineId).filter((x): x is number => x != null);
  const [srcCount] = await db.select({ n: count() }).from(scores).where(eq(scores.machineId, source.id));
  if (ids.length) {
    const counts = await db.select({ machineId: scores.machineId, n: count() }).from(scores)
      .where(inArray(scores.machineId, ids)).groupBy(scores.machineId);
    const byId = new Map(counts.map(c => [c.machineId, Number(c.n)]));
    for (const c of [...results, ...(suggestion ? [suggestion] : [])]) if (c.machineId != null) c.scoreCount = byId.get(c.machineId) ?? 0;
  }
  return { source: { ...brief(source), scoreCount: Number(srcCount?.n ?? 0) }, suggestion, results, catalogAvailable: !!catalog };
}

const catalogIndexes = new WeakMap<PinballMachine[], ReturnType<typeof buildSearchIndex<PinballMachine>>>();
function catalogIndexFor(catalog: PinballMachine[]) {
  let idx = catalogIndexes.get(catalog);
  if (!idx) {
    idx = buildSearchIndex(catalog);
    catalogIndexes.set(catalog, idx);
  }
  return idx;
}

export { parseId as parseMachineId };
