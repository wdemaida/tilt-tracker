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

const sql = postgres(process.env.DATABASE_URL!);

await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS pinball_map_email text`;

console.log('migrate18: users.pinball_map_email ready');
await sql.end();
