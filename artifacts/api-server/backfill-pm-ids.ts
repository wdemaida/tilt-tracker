import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

await sql`UPDATE venues SET pinball_map_id = 18256 WHERE id = 1`; // The Local Tavern & Grille
await sql`UPDATE venues SET pinball_map_id = 20676 WHERE id = 2`; // Red Nun Bar & Grill

console.log('Backfill complete');
await sql.end();
