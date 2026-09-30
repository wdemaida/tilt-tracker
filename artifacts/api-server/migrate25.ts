// Badge series (feature/badge-series). See src/lib/badgeSeries.ts.
//
//  badge_series        — one row per ladder ("Scores": First Ball → Regular → Centurion → Wizard Mode).
//                        A series has ONE color: every tier renders in badge_series.color, so the tiers
//                        can't drift apart. `sort_order` places the whole series in the same ordering
//                        space as single badges (badges.sort_order) — the profile shelf, the /badges
//                        catalog and /admin/badges all read that one order.
//  badges.series_id    — nullable FK, ON DELETE SET NULL (deleting a series turns its tiers back into
//                        singles). Within a series the tiers order by their own badges.sort_order —
//                        one key; a tier with a threshold is seated by its N on every write, rule/manual
//                        tiers wherever the admin drags them.
//  badge_series.description_template
//                      — how the tiers' descriptions read, with {N} for the threshold ("Posted {N}
//                        scores."). "Add tier" fills a new tier's description from it.
//
// First run of the description_template step (the column didn't exist before this run) also:
//   - seeds each series' template from its tiers (deriveSeriesTemplate: the lowest tier with a
//     threshold whose description contains that number exactly once, "1,000" or "1000" → {N}; the
//     lowest usually, the next one when it's worded "your first …"; none → null, and Add tier copies
//     the top tier's description instead), and
//   - renumbers each series' tiers 10, 20, 30, … in the order they showed until now (metric tiers by
//     threshold, then rule/manual tiers by sort_order), so the one-key order starts out identical.
// The column's existence is the marker: later runs never touch templates or tier order again (an
// admin's cleared template or dragged tier stays put). A series this script creates on a later run
// (its badges appeared since) gets both steps too.
//
// Seeds the series for the starter metric ladders (migrate23's keys) and assigns them — but only when
// the series doesn't exist yet, so a re-run never re-attaches a badge an admin has since moved out of
// its series. A series is created only if at least one of its badges exists and none of them is
// already in a series. Its color is taken from its lowest tier's current color on this DB (so colors
// edited in /admin/badges survive), its sort_order from the lowest sort_order among its tiers (so the
// shared order is unchanged). Single badges (losses-10, ties-1, abandoned-5, friend-request-1,
// friends-accepted-5, every rule/manual badge) stay unseried.
//
// Purely additive (IF NOT EXISTS / ON CONFLICT DO NOTHING) and idempotent — safe to re-run.
// migrate24 is reserved by feature/group-challenges; this doesn't depend on it.
//
//   cd artifacts/api-server && npx tsx migrate25.ts

import 'dotenv/config';
import postgres from 'postgres';
import { deriveSeriesTemplate } from './src/lib/badgeSeries.js'; // pure — no DB, no other imports

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/badge-series. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate25.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} }); // re-runs print "already exists" notices

// [series key, name, badge keys lowest tier first]
const SERIES: Array<[string, string, string[]]> = [
  ['scores', 'Scores', ['scores-1', 'scores-10', 'scores-100', 'scores-1000']],
  ['machines', 'Machines', ['machines-10', 'machines-50', 'machines-100']],
  ['venues', 'Venues', ['venues-5', 'venues-25']],
  ['challenge-wins', 'Challenge wins', ['wins-1', 'wins-5', 'wins-25']],
  ['win-streaks', 'Win streaks', ['win-streak-3', 'win-streak-10', 'win-streak-25']],
  ['loss-streaks', 'Loss streaks', ['loss-streak-3', 'loss-streak-10', 'loss-streak-25']],
  ['sign-ins', 'Sign-ins', ['logins-7', 'logins-30', 'logins-100']],
];

const report: string[] = [];
const [{ had }] = await sql`
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'badge_series' AND column_name = 'description_template') AS had`;
const firstTemplateRun = !had;
await sql.begin(async tx => {
  const created: number[] = [];
  await tx`
    CREATE TABLE IF NOT EXISTS badge_series (
      id          serial PRIMARY KEY,
      key         text NOT NULL UNIQUE,
      name        text NOT NULL,
      color       varchar(7) NOT NULL DEFAULT '#f59e0b',
      sort_order  integer NOT NULL DEFAULT 0,
      created_at  timestamp NOT NULL DEFAULT now(),
      updated_at  timestamp NOT NULL DEFAULT now()
    )`;
  await tx`ALTER TABLE badges ADD COLUMN IF NOT EXISTS series_id integer REFERENCES badge_series(id) ON DELETE SET NULL`;
  await tx`CREATE INDEX IF NOT EXISTS badges_series_id_idx ON badges (series_id)`;

  for (const [key, name, keys] of SERIES) {
    const [exists] = await tx`SELECT id FROM badge_series WHERE key = ${key}`;
    if (exists) { report.push(`${key}: exists (#${exists.id}), left alone`); continue; }
    const tiers = await tx`
      SELECT id, key, color, sort_order, series_id, threshold FROM badges
      WHERE key IN ${tx(keys)} ORDER BY threshold NULLS LAST, id`;
    if (!tiers.length) { report.push(`${key}: no badges with those keys, skipped`); continue; }
    if (tiers.some(t => t.series_id != null)) { report.push(`${key}: a tier is already in a series, skipped`); continue; }
    // The lowest tier by the ladder's own order (keys are listed lowest first).
    const lowest = [...tiers].sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))[0];
    const sortOrder = Math.min(...tiers.map(t => Number(t.sort_order)));
    const [s] = await tx`
      INSERT INTO badge_series (key, name, color, sort_order) VALUES (${key}, ${name}, ${lowest.color}, ${sortOrder})
      ON CONFLICT (key) DO NOTHING RETURNING id`;
    if (!s) { report.push(`${key}: created concurrently, left alone`); continue; }
    await tx`UPDATE badges SET series_id = ${s.id} WHERE id IN ${tx(tiers.map(t => t.id))} AND series_id IS NULL`;
    created.push(s.id);
    report.push(`${key}: #${s.id} ${lowest.color} order ${sortOrder} ← ${tiers.map(t => t.key).join(', ')}`);
  }

  await tx`ALTER TABLE badge_series ADD COLUMN IF NOT EXISTS description_template text`;
  const targets = firstTemplateRun
    ? (await tx`SELECT id FROM badge_series ORDER BY id`).map(r => Number(r.id))
    : created;
  if (!targets.length) report.push('description_template: already set up — templates and tier order left alone');
  for (const id of targets) {
    const [s] = await tx`SELECT key, description_template FROM badge_series WHERE id = ${id}`;
    const tiers = await tx`SELECT id, key, kind, threshold, description, sort_order FROM badges WHERE series_id = ${id}`;
    // The order these tiers showed before the one-key rule: metric tiers by threshold, then the rest
    // by sort_order, then id.
    const hasN = (t: any) => t.kind === 'metric' && t.threshold != null;
    const legacy = [...tiers].sort((a, b) =>
      (hasN(a) === hasN(b) ? 0 : hasN(a) ? -1 : 1)
      || (hasN(a) && hasN(b) ? Number(a.threshold) - Number(b.threshold) : 0)
      || Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
    let renumbered = 0;
    for (const [i, t] of legacy.entries()) {
      if (Number(t.sort_order) === (i + 1) * 10) continue;
      await tx`UPDATE badges SET sort_order = ${(i + 1) * 10} WHERE id = ${t.id}`;
      renumbered++;
    }
    let tpl: string | null = s.description_template;
    if (tpl == null) {
      tpl = deriveSeriesTemplate(tiers.map(t => ({ kind: t.kind, threshold: t.threshold == null ? null : Number(t.threshold), description: t.description })));
      if (tpl) await tx`UPDATE badge_series SET description_template = ${tpl} WHERE id = ${id}`;
    }
    report.push(`${s.key}: tiers ${legacy.map(t => t.key).join(' → ')} (${renumbered} renumbered); template ${tpl ? JSON.stringify(tpl) : 'none (Add tier copies the top tier’s description)'}`);
  }
});

for (const line of report) console.log(`  ${line}`);
const [counts] = await sql`
  SELECT (SELECT count(*) FROM badge_series)::int AS series,
         (SELECT count(*) FROM badges WHERE series_id IS NOT NULL)::int AS tiers,
         (SELECT count(*) FROM badges WHERE series_id IS NULL)::int AS singles`;
console.log(`migrate25: badge_series ready (${counts.series} series, ${counts.tiers} tiers, ${counts.singles} single badges)`);
await sql.end();
