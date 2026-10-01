// migrate27: the ai_usage table — one row per AI model call (today: the two score-photo reads in
// src/lib/anthropic.ts), written fire-and-forget by src/lib/aiUsage.ts and summarized on /admin.
// Provider-neutral, so a swapped-in OCR vendor logs to the same table.
//
// Idempotent (IF NOT EXISTS throughout).
//
//   cd artifacts/api-server && npx tsx migrate27.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

await sql.begin(async tx => {
  await tx`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id bigserial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      provider text NOT NULL,
      model text NOT NULL,
      operation text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      ms integer NOT NULL DEFAULT 0,
      est_cost_usd numeric(12, 6),
      user_id integer REFERENCES users(id) ON DELETE SET NULL,
      ok boolean NOT NULL,
      error text
    )`;
  await tx`CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at)`;
});

const [{ n }] = await sql`SELECT count(*)::int AS n FROM ai_usage`;
const [{ t }] = await sql`
  SELECT data_type AS t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'ai_usage' AND column_name = 'created_at'`;
console.log(`migrate27 done: ai_usage exists (${n} row(s)), created_at is ${t}`);
await sql.end();
