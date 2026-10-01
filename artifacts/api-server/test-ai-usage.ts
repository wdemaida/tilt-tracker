// End-to-end check of the AI usage log (feature/ai-usage, migrate27) against the Neon DEV branch.
//
//   cd artifacts/api-server && npx tsx test-ai-usage.ts [path/to/photo.jpg]
//
// Makes ONE real Anthropic score read (about a cent) on the given JPEG (default: the main checkout's
// gitignored context-images/sample_pinball_drawing_1.jpg, relative to artifacts/api-server) plus one deliberately invalid request (rejected by
// the API, nothing billed), then checks both ai_usage rows — tokens, cost, user, ok/error — and the
// admin overview's summary over them. Deletes the rows it wrote. Dev branch only.

import 'dotenv/config';
import { readFileSync } from 'node:fs';

const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
if (!new URL(process.env.DATABASE_URL!).hostname.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}).`);
  process.exit(1);
}

const { db, users } = await import('@workspace/db');
const { sql } = await import('drizzle-orm');
const { extractScoreReads } = await import('./src/lib/anthropic.js');
const { aiUsageSummary } = await import('./src/routes/adminArea.js');
const { estimateCostUsd } = await import('./src/lib/aiUsage.js');

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const settle = () => new Promise(r => setTimeout(r, 1500)); // the insert is fire-and-forget

const [{ maxId }] = await db.execute(sql`SELECT coalesce(max(id), 0)::int AS "maxId" FROM ai_usage`) as any[];
const [user] = await db.select({ id: users.id, clerkId: users.clerkId }).from(users).limit(1);
const base64 = readFileSync(process.argv[2] ?? '../../context-images/sample_pinball_drawing_1.jpg').toString('base64');

try {
  // 1. A real read.
  const read = await extractScoreReads([{ base64, mimeType: 'image/jpeg' }], undefined, { clerkId: user.clerkId });
  await settle();
  const [row] = await db.execute(sql`
    SELECT provider, model, operation, input_tokens, output_tokens, ms, est_cost_usd::float8 AS cost, user_id, ok, error
      FROM ai_usage WHERE id > ${maxId} AND ok ORDER BY id DESC LIMIT 1`) as any[];
  console.log('row:', row);
  check(!!row, 'a successful read wrote an ai_usage row');
  if (row) {
    check(row.provider === 'anthropic' && row.model === 'claude-sonnet-4-6' && row.operation === 'score_read', 'provider / model / operation');
    check(row.input_tokens === read.usage.inputTokens && row.output_tokens === read.usage.outputTokens, 'tokens match the API usage');
    check(Math.abs(row.cost - estimateCostUsd(row.model, row.input_tokens, row.output_tokens)!) < 1e-9, `cost = $${row.cost}`);
    check(row.user_id === user.id, 'user resolved from the Clerk id');
    check(row.ok === true && row.error === null, 'ok, no error');
  }

  // 2. A request the API rejects (not an image) — recorded as a failure, then rethrown.
  let threw = false;
  try {
    await extractScoreReads([{ base64: Buffer.from('not an image').toString('base64'), mimeType: 'image/jpeg' }], undefined, { clerkId: user.clerkId });
  } catch { threw = true; }
  await settle();
  const [bad] = await db.execute(sql`
    SELECT ok, error, input_tokens, est_cost_usd::float8 AS cost FROM ai_usage WHERE id > ${maxId} AND NOT ok ORDER BY id DESC LIMIT 1`) as any[];
  console.log('failed row:', bad);
  check(threw, 'the API error still reaches the caller');
  check(!!bad && bad.ok === false && /^4\d\d /.test(bad.error ?? ''), `failure recorded (${bad?.error})`);

  // 3. The admin overview's summary sees both.
  const summary = await aiUsageSummary();
  console.log('summary totals:', summary?.totals);
  check(!!summary && summary.totals.callsToday >= 2 && summary.totals.errorsToday >= 1, 'summary counts today\'s calls and errors');
  check(!!summary && summary.byModel.some(m => m.model === 'claude-sonnet-4-6'), 'summary breaks down by model');
} finally {
  const gone = await db.execute(sql`DELETE FROM ai_usage WHERE id > ${maxId} RETURNING id`) as any[];
  console.log(`cleaned up ${gone.length} ai_usage row(s)`);
}

console.log(failures ? `${failures} FAILURE(S)` : 'all checks passed');
process.exit(failures ? 1 : 0);
