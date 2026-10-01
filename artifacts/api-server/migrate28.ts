// migrate28: the site_content table — admin-editable copy for public pages, one JSON value per key
// (today the /welcome page's sections: welcome.hero, welcome.how, …). Defaults live in the frontend
// (artifacts/pinball-tracker/src/lib/welcomeContent.ts); a row overrides its key, no row = default.
// Written only through the admin content routes (src/routes/adminContent.ts), which validate shapes.
//
// Idempotent (IF NOT EXISTS throughout).
//
//   cd artifacts/api-server && npx tsx migrate28.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

await sql.begin(async tx => {
  await tx`
    CREATE TABLE IF NOT EXISTS site_content (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by_id integer REFERENCES users(id) ON DELETE SET NULL
    )`;
});

const [{ n }] = await sql`SELECT count(*)::int AS n FROM site_content`;
const [{ t }] = await sql`
  SELECT data_type AS t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'site_content' AND column_name = 'updated_at'`;
console.log(`migrate28 done: site_content exists (${n} row(s)), updated_at is ${t}`);
await sql.end();
