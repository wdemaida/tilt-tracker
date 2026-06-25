import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!);

// Venom (Premium) — PM id 3739
await sql`
  UPDATE machines SET
    manufacturer = 'Stern', year = 2023,
    image_url = 'https://img.opdb.org/88057d58-3f96-49d7-b635-21725103fac3-medium.jpg',
    opdb_id = 'G3EBl-MRj6e-AOVkD'
  WHERE name = 'Venom (Premium)'
`;

// The Munsters (Premium) — PM id 3100
await sql`
  UPDATE machines SET
    manufacturer = 'Stern', year = 2019,
    image_url = 'https://img.opdb.org/707b7a5b-53b7-4e0e-b2d5-71fe3dcfe4c3-medium.jpg',
    opdb_id = 'GbPde-Mp43l-AOQwL'
  WHERE name = 'The Munsters (Premium)'
`;

console.log('Machine backfill complete');
await sql.end();
