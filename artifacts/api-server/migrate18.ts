// Pinball Map score posting (fix/pm-posting).
//
//  users.pinball_map_email  text  — the email Pinball Map's auth_details returned for the connected
//                                   account. PM's write endpoints authenticate with user_email AND
//                                   user_token together (User.find_by(email:), exact case), so the
//                                   token alone was never enough. Null = not connected, or connected
//                                   before this column existed (the app asks those users to reconnect).
//
// Purely additive (ADD COLUMN IF NOT EXISTS) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate18.ts

import 'dotenv/config';
import postgres from 'postgres';

// DEV-BRANCH GUARD — deliberately refuses to run against anything but the Neon dev branch
// (endpoint ep-late-mouse-at8antth) while this is still on fix/pm-posting. Production is a
// different endpoint, so running this from the production checkout (whose .env points at prod)
// aborts here. Remove this block deliberately at ship time, when the migration is meant to hit
// production.
const DEV_ENDPOINT = 'ep-late-mouse-at8antth';
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!host.startsWith(DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the Neon dev branch (${DEV_ENDPOINT}). See the guard comment in migrate18.ts.`);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pinball_map_email text`;

console.log('migrate18: users.pinball_map_email ready');
await sql.end();
