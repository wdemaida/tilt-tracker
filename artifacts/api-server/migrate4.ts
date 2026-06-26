import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pm_machine_count integer`;
console.log('Migration complete: pm_machine_count added to venues');
await sql.end();
