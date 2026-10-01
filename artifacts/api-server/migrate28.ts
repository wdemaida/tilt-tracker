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

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on feature/site-content. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately, in its own commit, at ship time, when the migration
// is meant to hit production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate28.ts.`);
  process.exit(1);
}

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
