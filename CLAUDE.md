# CLAUDE.md — TiltTrack

Pinball high score tracker. Deployed at **[tilttrack.vercel.app](https://tilttrack.vercel.app)**.
See [SPEC.md](./SPEC.md) for the full feature spec.

---

**pnpm workspaces** — always run installs from the repo root with `pnpm install`.

---

## Running locally

**Frontend** (from `artifacts/pinball-tracker`):
```bash
npx vite
```
Opens at **`https://localhost:5174`** (HTTPS only — required for Clerk cookies).
Port 5173 is taken by another process on this machine; `vite.config.ts` hardcodes 5174 with `strictPort: true`.

**API server** (from `artifacts/api-server`):
```bash
npx tsx watch src/index.ts
```
Runs on port 3001. Vite proxies `/api/*` to it automatically.
Port 3000 is intentionally avoided — an unrelated project (`bart-core`, under `_nymbl-work`) frequently occupies it on this machine, so the api-server, `vite.config.ts`'s proxy, and the direct-loopback Drizzle Studio launcher (`src/lib/api.ts`) all standardize on 3001 instead.

Both must be running for the app to work.

**A stray `vite.config.js` will silently override `vite.config.ts`** — Vite prefers `.js` config files, and the two can drift out of sync since only the `.ts` file is meant to be edited. If `/api/*` calls ever fail mysteriously even though the api-server is running, check for `artifacts/pinball-tracker/vite.config.js` and delete it if present.

---

## Database migrations

**Do NOT use `drizzle-kit push`** — it crashes on Neon's PostgreSQL dialect.

Instead, write a numbered migration script in `artifacts/api-server/`:

```typescript
// migrate<N>.ts
import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL!);
await sql`ALTER TABLE venues ADD COLUMN IF NOT EXISTS pm_machine_count integer`;
console.log('done');
await sql.end();
```

Run it:
```bash
cd artifacts/api-server
npx tsx migrate<N>.ts
```

This hits the **production Neon DB** via `DATABASE_URL` in `artifacts/api-server/.env`.
Always also update `lib/db/src/schema.ts` to keep Drizzle types in sync.

---

## Deploy sequence

After any set of changes, ask the user: **"Deploy now or save for later?"**

If deploying:

1. **Run DB migration** (only if `lib/db/src/schema.ts` changed) — see above.
2. **Commit** — stage files by name (never `git add -A`), descriptive message.
3. **Push** — `git push origin main`
   - Vercel auto-deploys the frontend (~1–2 min)
   - Render auto-deploys the backend (~2–3 min)

Claude is authorized to commit and push to `main` directly — no need to ask permission each time.

**`PINBALL_MAP_API_TOKEN` must be set on Render**, not just locally — Pinball Map has required an
`api_token` on every endpoint since 2026-07-30, and without it venue/machine lookups return empty
rather than erroring. Request one at <https://pinballmap.com/api_token>. Remember that a Render env
var PUT **replaces all env vars** — send the full set, not just the new key.

**Git identity must be `wdemaida` / `wdemaida@gmail.com`** — the remote is `https://wdemaida@github.com/wdemaida/tilt-tracker.git`. If Vercel deployments start failing with "not a member" errors, check `git config user.name/email` in the repo.

Push uses an isolated `GH_CONFIG_DIR` (not the global `gh` login) — see the **deploy** skill (`.claude/skills/deploy/SKILL.md`) for the credential setup, production URLs/service keys, and Vercel/Render-specific gotchas.

---

## Pinball Map API — standing rule

Pinball Map's maintainers granted Will an API token personally. **TiltTrack must never hammer their
API.** This is a standing rule, not a guideline:

- **Every PM request goes through `pmClient`** (`artifacts/api-server/src/lib/pmClient.ts`) — no raw
  `fetch` to pinballmap.com anywhere, and never from the browser. It holds the token, a global
  limiter (1 req/s, burst 5, concurrency 2), in-flight de-duplication, a 10 s timeout, a circuit
  breaker honoring `Retry-After` (429 → default 15 min; 5xx/network/timeout → 2 min; rejected
  api_token → 15 min; while open it fails fast, nothing retries per request), and an identifying
  User-Agent. Every live call logs one line: `[PM live] <method> <path> <status> <ms> (n today)`.
- **Every new call site needs a DB-backed cache with an explicit TTL** (rosters: `pm_location_cache`,
  6 h; catalog: `pm_catalog_cache`, 24 h). Page views and unauthenticated routes only read cache or
  trigger a refresh that is bounded per *key* (one per linked venue per TTL, one catalog fetch a
  day, de-duplicated in flight) — never per request. Failures are negatively cached, never retried
  per request.
- **No per-record fan-out:** never call PM inside a loop; fetch once and pass the data in (e.g.
  `syncVenueMachineHistory(venueId, xrefs, catalog)`, `upsertMachineByName(name, { catalog })`).
- **Every PM-touching route requires sign-in and a per-user rate limit** (`pmGuards.ts`); PM ids
  come from our DB or from a result we just returned to that user (30-min allowlist), never
  arbitrary input.
- **`force: true` only for deliberate user actions**, and it only refetches if the cached copy is
  more than 5 minutes old (`FORCE_MIN_AGE_MS`).
- **Before adding a PM feature, estimate worst-case calls/day** and write it in the PR/commit.
- **Development & testing:** outside production `PM_MODE` defaults to `offline` — requests are
  answered from recorded fixtures in `artifacts/api-server/fixtures/pm/` and anything unrecorded
  fails loudly. Use `live` only for a deliberate task and `record` to refresh fixtures
  (`PM_MODE=record npx tsx record-pm-fixtures.ts --catalog --roster <pmId> --near <lat,lng>`).
  Non-prod live calls go through an on-disk cache (`artifacts/api-server/.pm-cache/`, 7-day TTL,
  gitignored) and a hard budget — 50 live calls/day per machine, 20 per process (`PM_DEV_BUDGET=<n>`
  overrides both); past it pmClient logs `PM DEV BUDGET EXHAUSTED` and refuses. Test scripts never
  hit PM live unless `PM_LIVE_TESTS=1`; migrations and seed scripts never call PM.
- **Production needs no PM variables beyond `PINBALL_MAP_API_TOKEN`.** Production is detected as
  `NODE_ENV=production` **or** `RENDER=true` (Render sets `RENDER` on every service; neither
  render.yaml nor the start script sets `NODE_ENV`) and is always `live`, with no fixtures, disk
  cache or budget.

## Known gotchas

Feature-specific gotchas live in `artifacts/pinball-tracker/CLAUDE.md` (frontend) and `artifacts/api-server/CLAUDE.md` (backend) — both load automatically when working in those directories.

---

## Key files

| File | Purpose |
|------|---------|
| `artifacts/pinball-tracker/src/pages/AddScorePage.tsx` | 4-step score submission wizard (photo → venue → details → PM post) |
| `artifacts/pinball-tracker/src/pages/HomePage.tsx` | Recent Scores list with pagination and trophy detection |
| `artifacts/pinball-tracker/src/components/ScoreCard.tsx` | Score tile with thumbnail, trophy icon |
| `artifacts/pinball-tracker/src/pages/VenuesPage.tsx` | Venues grid with X/Y machine count |
| `artifacts/pinball-tracker/src/lib/api.ts` | All frontend API calls |
| `artifacts/api-server/src/routes/scores.ts` | Score CRUD |
| `artifacts/api-server/src/routes/venues.ts` | Venue list + machine detail (PM lazy cache) |
| `artifacts/api-server/src/routes/upload.ts` | Photo upload, AI extraction, GPS, HERE lookup |
| `artifacts/api-server/src/lib/pinballmapApi.ts` | Pinball Map API helpers |
| `artifacts/api-server/src/lib/pmClient.ts` | The only Pinball Map transport — limiter, breaker, dedup, fixtures, dev budget |
| `artifacts/api-server/src/lib/pmGuards.ts` | Per-user PM rate limits, pm-machines id allowlist, shared nearby cache |
| `artifacts/api-server/src/lib/venueHistory.ts` | Diffs live PM machine list vs. last snapshot; records arrivals/departures |
| `artifacts/api-server/src/lib/venueRepair.ts` | Venue relink + score re-sync: permissions, machine-name matching, merge apply |
| `artifacts/api-server/src/lib/pmRosterCache.ts` | 6h cache of PM machine rosters — the only sanctioned way to read a roster |
| `artifacts/pinball-tracker/src/components/VenueRepairPanel.tsx` | 3-step repair UI on the venue page (HERE → Pinball Map → re-sync) |
| `artifacts/pinball-tracker/src/components/ScoreResyncModal.tsx` | Preview-and-confirm modal for re-syncing a venue's scores |
| `lib/db/src/schema.ts` | Drizzle schema — source of truth for DB types |
| `artifacts/api-server/migrate*.ts` | Numbered migration scripts (run once, keep for history) |
