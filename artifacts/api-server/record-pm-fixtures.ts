// Records Pinball Map fixtures for PM_MODE=offline (the non-production default) into fixtures/pm/.
// Each request here is ONE deliberate live call through pmClient (rate limited, budgeted, logged),
// made with the exact parameters the app uses so the offline lookup keys match.
//
//   cd artifacts/api-server
//   PM_MODE=record npx tsx record-pm-fixtures.ts --catalog --roster 20676 --near 41.66778,-70.12377
//
//   --catalog          machines.json?no_details=1 (the typeahead / enrichment catalog)
//   --roster <pmId>    /locations/<pmId>.json (a venue's machine roster)
//   --near <lat,lng>   closest_by_lat_lon as pm-match / nearby suggestions / pm-candidates ask it
//
// Never run from production (pmClient ignores PM_MODE there anyway). Doesn't touch the database.
import 'dotenv/config';

if (process.env.PM_MODE !== 'record') {
  console.error('Refusing to run: set PM_MODE=record (this makes live Pinball Map calls, one per request).');
  process.exit(1);
}

const { pmClient } = await import('./src/lib/pmClient.js');
const { getPmMachinesAtLocation, findNearestPmLocations } = await import('./src/lib/pinballmapApi.js');

const args = process.argv.slice(2);
const jobs: Array<{ label: string; run: () => Promise<string> }> = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--catalog') {
    jobs.push({ label: 'catalog', run: async () => {
      const d = await pmClient().get<{ machines?: unknown[] }>('/machines.json', { no_details: 1 });
      return `${d.machines?.length ?? 0} machines`;
    } });
  } else if (a === '--roster') {
    const id = Number(args[++i]);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`--roster needs a numeric id, got ${args[i]}`);
    jobs.push({ label: `roster ${id}`, run: async () => `${(await getPmMachinesAtLocation(id)).length} machines` });
  } else if (a === '--near') {
    const [lat, lng] = String(args[++i]).split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`--near needs lat,lng, got ${args[i]}`);
    jobs.push({ label: `near ${lat},${lng}`, run: async () => `${(await findNearestPmLocations(lat, lng)).length} locations` });
  } else {
    throw new Error(`Unknown argument ${a}`);
  }
}
if (jobs.length === 0) {
  console.error('Nothing to record — pass --catalog, --roster <pmId> and/or --near <lat,lng>.');
  process.exit(1);
}

for (const job of jobs) {
  try {
    console.log(`recorded ${job.label}: ${await job.run()}`);
  } catch (err) {
    console.error(`FAILED ${job.label}: ${(err as Error).message}`);
  }
}
