// Run: npx tsx --test src/lib/aiUsage.test.ts   (from artifacts/api-server)
// aiUsage.ts imports @workspace/db, which throws without DATABASE_URL; postgres.js connects lazily
// and every test swaps the writer, so this dummy URL is never dialled.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const { estimateCostUsd, recordAiUsage, setAiUsageSinksForTests, foldAiUsage, AI_PRICES } = await import('./aiUsage.js');

const flush = () => new Promise(r => setImmediate(r));
const entry = {
  provider: 'anthropic', model: 'claude-sonnet-4-6', operation: 'score_read' as const,
  inputTokens: 1700, outputTokens: 600, ms: 2100, ok: true,
};

afterEach(() => setAiUsageSinksForTests());

test('cost: Sonnet 4.6 at $3 / $15 per million tokens', () => {
  assert.deepEqual(AI_PRICES['claude-sonnet-4-6'], { inputPerM: 3, outputPerM: 15 });
  // 1,700 × 3 + 600 × 15 = 14,100 µ$ → $0.0141
  assert.equal(estimateCostUsd('claude-sonnet-4-6', 1700, 600), 0.0141);
  assert.equal(estimateCostUsd('claude-sonnet-4-6', 0, 0), 0);
  assert.equal(estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000), 18);
  // Rounded to the column's 6 decimals.
  assert.equal(estimateCostUsd('claude-sonnet-4-6', 1, 0), 0.000003);
});

test('cost: an unknown model is null, not zero', () => {
  assert.equal(estimateCostUsd('some-other-vendor-ocr', 1000, 1000), null);
});

test('recordAiUsage writes one row with the cost and logs one [AI] line', async () => {
  const rows: any[] = [];
  const lines: string[] = [];
  setAiUsageSinksForTests(async row => { rows.push(row); }, l => lines.push(l));
  recordAiUsage({ ...entry, clerkId: 'user_abc' });
  await flush();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estCostUsd, 0.0141);
  assert.equal(rows[0].clerkId, 'user_abc');
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].error, null);
  assert.deepEqual(lines, ['[AI] anthropic claude-sonnet-4-6 score_read 1700/600 tokens 2100ms']);
});

test('recordAiUsage: failures are recorded with their reason; junk token counts become 0', async () => {
  const rows: any[] = [];
  const lines: string[] = [];
  setAiUsageSinksForTests(async row => { rows.push(row); }, l => lines.push(l));
  recordAiUsage({ ...entry, operation: 'display_windows', inputTokens: NaN, outputTokens: -5, ok: false, error: '529 OverloadedError' });
  await flush();
  assert.equal(rows[0].inputTokens, 0);
  assert.equal(rows[0].outputTokens, 0);
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].error, '529 OverloadedError');
  assert.match(lines[0], /FAILED \(529 OverloadedError\)$/);
});

test('recordAiUsage never throws or rejects into the caller — async writer failure', async () => {
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    setAiUsageSinksForTests(async () => { throw new Error('relation "ai_usage" does not exist'); }, () => {});
    assert.equal(recordAiUsage(entry), undefined);
    await flush();
    assert.equal(errors.length, 1);
  } finally {
    console.error = orig;
  }
});

test('recordAiUsage never throws — synchronous writer and logger failures', async () => {
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    setAiUsageSinksForTests(() => { throw new Error('sync boom'); }, () => {});
    assert.doesNotThrow(() => recordAiUsage(entry));
    await flush();
    setAiUsageSinksForTests(async () => {}, () => { throw new Error('log boom'); });
    assert.doesNotThrow(() => recordAiUsage(entry));
    await flush();
    assert.equal(errors.length, 2);
  } finally {
    console.error = orig;
  }
});

test('recordAiUsage does not wait on the insert', () => {
  let resolveWrite!: () => void;
  let wrote = false;
  setAiUsageSinksForTests(() => new Promise<void>(r => { resolveWrite = () => { wrote = true; r(); }; }), () => {});
  const t0 = Date.now();
  recordAiUsage(entry);
  assert.ok(Date.now() - t0 < 50);
  assert.equal(wrote, false);
  resolveWrite?.();
});

test('foldAiUsage totals the per-model lines', () => {
  const line = (over: Record<string, unknown>) => ({
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    callsToday: 0, calls30d: 0, errorsToday: 0, errors30d: 0,
    inputToday: 0, outputToday: 0, input30d: 0, output30d: 0,
    costToday: 0, cost30d: 0, unpriced30d: 0, lastAt: null, ...over,
  });
  const s = foldAiUsage([
    line({ callsToday: 2, calls30d: 10, errors30d: 1, input30d: 17000, output30d: 6000, costToday: 0.0282, cost30d: 0.141, lastAt: '2026-10-01T12:00:00.000Z' }),
    line({ provider: 'other', model: 'x', calls30d: 3, unpriced30d: 3, lastAt: '2026-10-01T13:00:00.000Z' }),
  ]);
  assert.equal(s.totals.callsToday, 2);
  assert.equal(s.totals.calls30d, 13);
  assert.equal(s.totals.errors30d, 1);
  assert.equal(s.totals.input30d, 17000);
  assert.equal(s.totals.cost30d, 0.141);
  assert.equal(s.totals.unpriced30d, 3);
  assert.equal(s.totals.lastAt, '2026-10-01T13:00:00.000Z');
  assert.equal(s.byModel.length, 2);
  assert.deepEqual(foldAiUsage([]).totals.calls30d, 0);
  assert.equal(foldAiUsage([]).totals.lastAt, null);
});
