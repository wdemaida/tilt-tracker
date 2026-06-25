import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS manufacturer text`;
await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS year integer`;
await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS image_url text`;
console.log('Migration complete: manufacturer, year, image_url added to machines');
await sql.end();
