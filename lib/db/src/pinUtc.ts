// Pin the process zone to UTC. Imported first by index.ts, so it runs as soon as anything imports
// @workspace/db — before the driver or the importer's own code touches a Date.
//
// Render already runs in UTC; this makes a script, test or api-server on Will's Eastern laptop
// behave the same way, so a zone-less timestamp string (which the API refuses from clients — see
// api-server src/lib/instant.ts) can never be read as local time. Side effects locally: anything
// that uses local Date getters follows UTC, not Eastern — console timestamps, and pmClient's
// dev-budget day key (the 50-calls/day budget rolls over at 8 pm EDT / 7 pm EST). Node re-reads TZ
// when it's assigned, so this takes effect immediately.
process.env.TZ = 'UTC';
export {};
