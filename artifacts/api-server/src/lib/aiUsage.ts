import { db, aiUsage } from '@workspace/db';
import { sql } from 'drizzle-orm';

// AI usage log — one ai_usage row (migrate27) per model call, plus one `[AI] …` line, mirroring
// pmClient's `[PM live]`. Provider-neutral: whatever vendor reads the score photos records through
// recordAiUsage, and /admin's "AI (photo reads)" panel sums the table.
//
// Fire-and-forget. recordAiUsage returns nothing and never throws: a failed insert (DB down, table
// missing because migrate27 hasn't run) is one console.error, and the upload carries on untouched.

export type AiOperation = 'score_read' | 'display_windows';

export interface AiUsageEntry {
  provider: string;
  model: string;
  operation: AiOperation;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  error?: string | null;
  /** The signed-in user's Clerk id; resolved to users.id inside the insert (no extra lookup). */
  clerkId?: string | null;
}

/** Who a model call is made for — threaded from the route into the provider module. */
export interface AiCallContext { clerkId?: string | null }

/**
 * USD per million tokens. Anthropic first-party rates from the claude-api skill's model table
 * (cached 2026-09-25). Update when a model is added or repriced; a model not listed logs a null cost.
 * Cache reads/writes aren't used by the score reads, so only plain input/output is priced.
 */
export const AI_PRICES: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
};

/** Estimated cost in USD, rounded to the column's 6 decimals; null when the model isn't priced. */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = AI_PRICES[model];
  if (!p) return null;
  const usd = (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export interface AiUsageRow {
  provider: string; model: string; operation: string;
  inputTokens: number; outputTokens: number; ms: number;
  estCostUsd: number | null; ok: boolean; error: string | null; clerkId: string | null;
}

type Writer = (row: AiUsageRow) => Promise<unknown>;

const dbWriter: Writer = row => db.insert(aiUsage).values({
  provider: row.provider,
  model: row.model,
  operation: row.operation,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  ms: row.ms,
  estCostUsd: row.estCostUsd == null ? null : String(row.estCostUsd),
  userId: row.clerkId ? sql`(SELECT id FROM users WHERE clerk_id = ${row.clerkId})` : null,
  ok: row.ok,
  error: row.error,
});

let writer: Writer = dbWriter;
let log: (line: string) => void = line => console.log(line);

/** Test hook: swap the insert and the log line (pass nothing to restore both). */
export function setAiUsageSinksForTests(w?: Writer, l?: (line: string) => void): void {
  writer = w ?? dbWriter;
  log = l ?? (line => console.log(line));
}

/** One provider + model's last-30-days line on the admin overview (adminArea.ts aggregates in SQL). */
export interface AiUsageModelLine {
  provider: string; model: string;
  callsToday: number; calls30d: number; errorsToday: number; errors30d: number;
  inputToday: number; outputToday: number; input30d: number; output30d: number;
  costToday: number; cost30d: number;
  /** Calls in 30 days with no price (a model missing from AI_PRICES) — the cost is then a floor. */
  unpriced30d: number;
  lastAt: string | null;
}

export interface AiUsageSummary {
  totals: Omit<AiUsageModelLine, 'provider' | 'model'>;
  byModel: AiUsageModelLine[];
}

const SUMMED = ['callsToday', 'calls30d', 'errorsToday', 'errors30d', 'inputToday', 'outputToday',
  'input30d', 'output30d', 'costToday', 'cost30d', 'unpriced30d'] as const;

/** Totals across models; costs rounded to the cent's hundredth so float sums read cleanly. */
export function foldAiUsage(byModel: AiUsageModelLine[]): AiUsageSummary {
  const totals = { lastAt: null as string | null } as AiUsageSummary['totals'];
  for (const k of SUMMED) totals[k] = 0;
  for (const line of byModel) {
    for (const k of SUMMED) totals[k] += Number(line[k]) || 0;
    if (line.lastAt && (!totals.lastAt || line.lastAt > totals.lastAt)) totals.lastAt = line.lastAt;
  }
  totals.costToday = Math.round(totals.costToday * 1e4) / 1e4;
  totals.cost30d = Math.round(totals.cost30d * 1e4) / 1e4;
  return { totals, byModel };
}

/** Rows older than this are deleted by daily housekeeping (housekeeping.ts). */
export const AI_USAGE_RETENTION_DAYS = 365;

/** Deletes ai_usage rows past retention; returns how many. A few rows a day, so one statement. */
export async function purgeAiUsage(): Promise<number> {
  const rows = await db.execute(sql`
    WITH gone AS (
      DELETE FROM ai_usage WHERE created_at < now() - make_interval(days => ${AI_USAGE_RETENTION_DAYS})
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone
  `) as any[];
  return rows[0]?.n ?? 0;
}

const clean = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

export function recordAiUsage(entry: AiUsageEntry): void {
  try {
    const row: AiUsageRow = {
      provider: entry.provider,
      model: entry.model,
      operation: entry.operation,
      inputTokens: clean(entry.inputTokens),
      outputTokens: clean(entry.outputTokens),
      ms: clean(entry.ms),
      estCostUsd: null,
      ok: entry.ok,
      error: entry.error ? String(entry.error).slice(0, 500) : null,
      clerkId: entry.clerkId ?? null,
    };
    row.estCostUsd = estimateCostUsd(row.model, row.inputTokens, row.outputTokens);
    log(`[AI] ${row.provider} ${row.model} ${row.operation} ${row.inputTokens}/${row.outputTokens} tokens ${row.ms}ms`
      + (row.ok ? '' : ` FAILED (${row.error ?? 'unknown'})`));
    // Through Promise.resolve: a writer that throws synchronously, or returns a bare thenable,
    // still lands in the one catch below — never in the caller.
    Promise.resolve()
      .then(() => writer(row))
      .catch((err: any) => console.error('[AI] failed to record usage:', err?.message ?? err));
  } catch (err: any) {
    console.error('[AI] failed to record usage:', err?.message ?? err);
  }
}
