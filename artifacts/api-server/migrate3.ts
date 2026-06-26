import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);
await sql`ALTER TABLE scores ADD COLUMN IF NOT EXISTS photo_thumbnail text`;
console.log('Migration complete: photo_thumbnail added to scores');
await sql.end();
