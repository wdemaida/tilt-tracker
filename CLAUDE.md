# CLAUDE.md — TiltTrack

Pinball high score tracker. Deployed at **[tilttrack.vercel.app](https://tilttrack.vercel.app)**.
See [SPEC.md](./SPEC.md) for the full feature spec.

---

## Monorepo layout

```
artifacts/pinball-tracker/   React + Vite + TypeScript frontend
artifacts/api-server/        Express + Node.js + TypeScript backend
lib/db/                      Drizzle ORM schema + Neon DB client
```

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

**Git identity must be `wdemaida` / `wdemaida@gmail.com`** — the remote is `https://wdemaida@github.com/wdemaida/tilt-tracker.git`. If Vercel deployments start failing with "not a member" errors, check `git config user.name/email` in the repo.

**Push credential (isolated `GH_CONFIG_DIR`, set up 2026-07-01):** the user's global `gh` CLI is often authenticated as a different GitHub account (`WillDeMaidaNymbl`, used for other repos/Actions work), and `gh auth switch` is unsafe across concurrent Claude Code windows on different projects/accounts (it mutates the one shared `~/.config/gh/hosts.yml`). This repo instead uses a dedicated, isolated gh config directory: `~/.gh-config-personal`, logged in as `wdemaida`, which never touches the global gh state.

This repo's **local** (not global) git config routes `github.com` credential lookups through that isolated dir:
```
git config --local --get-all credential.https://github.com.helper
```
should return two lines — an empty one (resets the inherited global helper chain) followed by:
```
!GH_CONFIG_DIR='C:/Users/wdema/.gh-config-personal' gh auth git-credential
```
This does not affect other repos on the machine (they still use the global `gh`-based flow / whatever account that resolves to). If push ever fails, re-verify those two lines are present (`--add`, not a plain set, when recreating — the key is multi-valued) and that the isolated login is still valid: `GH_CONFIG_DIR=~/.gh-config-personal gh auth status`. Any `gh` CLI command run manually against this repo should also be prefixed with `GH_CONFIG_DIR=~/.gh-config-personal`.

---

## Production architecture

| Service | URL | Notes |
|---------|-----|-------|
| Frontend | `https://tilttrack.vercel.app` | Vercel, project `tilttrack` |
| API | `https://tilt-tracker.onrender.com` | Render, service `tilt-tracker` |
| Database | Neon PostgreSQL | Cloud-hosted, always on |
| Auth | Clerk dev instance | `pk_test/sk_test` keys — fine for personal app |

**Vercel** — root directory: `artifacts/pinball-tracker`, framework: Vite.
`VITE_*` env vars are baked in at build time; changing them requires a new deploy.

**Render** — build: `npm install -g pnpm && pnpm install --frozen-lockfile`, start: `pnpm --filter api-server start`.
Env vars: `DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ANTHROPIC_API_KEY`, `HERE_API_KEY`, `FRONTEND_URL`.

**CORS:** `FRONTEND_URL` on Render must match the live Vercel URL. If the Vercel URL ever changes, update that env var on Render and redeploy both.

### Service API keys (for programmatic deployment management)
Keys and IDs are stored in Claude's project memory (`project_deployment.md`) — not committed to git.
Retrieve them from there when needed to call the Vercel or Render APIs directly.

---

## Known gotchas

### Vercel deploys
- `tilttrack.vercel.app` is registered as a **project domain** (not a frozen alias) so it auto-tracks the latest `main` deploy. If it ever serves stale code, check `GET /v3/aliases/tilttrack.vercel.app` to see what deployment it points to.
- When a deploy gets stuck/cancelled, trigger one directly via the Vercel API: `POST /v13/deployments` with `gitSource: { type: 'github', org: 'wdemaida', repo: 'tilt-tracker', ref: 'main', sha }`.
- `render.yaml` in the repo root **does not auto-apply** to the existing Render service — use the Render API or dashboard to update build/start commands.
- Render's `PUT /v1/services/{id}/env-vars` **replaces all env vars** — always include every var, never update one in isolation.

### Clerk (auth)
- Use the **custom sign-in form** (`src/pages/SignInPage.tsx`) — not Clerk's pre-built `<SignIn>` component. The pre-built component has a submit button that hides behind the mobile keyboard.
- Sign-in flow uses Clerk v5 two-step: `signIn.create({ identifier })` then `signIn.attemptFirstFactor({ strategy: 'password', password })`. Handle `needs_client_trust` by sending an email code.
- HTTPS is required for Clerk cookies — local dev must use `https://localhost:5174`, not `http://`.

### HERE API
- Use the **browse** endpoint (`browse.search.hereapi.com/v1/browse`) with `categories=100,200,300,500,600,700` and `at=lat,lng`. Do NOT use the `discover` endpoint — without a bounding circle it searches globally.
- Key is in `artifacts/api-server/.env` as `HERE_API_KEY`.

### Pinball Map API
- `max_distance` is **integer miles** — decimal values get truncated to 0. Use `Math.ceil`.
- `/locations/:id/machine_details.json` returns `{ machines: [...] }`.
- `/locations/:id.json` returns xref IDs in `location_machine_xrefs[].id`.
- Single machine lookup (`/machines/:id.json`) returns 404 — use the full cached list with in-memory search.

### Photo / GPS extraction
- Use **`exifr`** (not `exifreader`) for GPS from iPhone HEIC files: `await Exifr.gps(buffer)`.
- Extract GPS from the **original buffer before HEIC→JPEG conversion** — conversion strips EXIF.
- `playedAt` uses `DateTimeOriginal` from EXIF; AI result is fallback only.

### Recharts (Score Trend chart)
- The Scatter chart's `YAxis` needs an explicit `dataKey="y"` (and each `<Scatter>` needs `dataKey="y"` too) — without it, recharts can't resolve the Y value for scatter points and they render invisibly, even though positions/colors look correct in the JSX.
- When a `<Scatter>` dot and a `<Line>` trend point share the same x (true here, since trend lines are built via `rollingAvg()` over the same dots), hovering the dot's exact pixel position returns BOTH in the tooltip's `payload` array — but recharts always orders the trend entry first. `ScatterTooltip` in `MachinePage.tsx` explicitly searches for a non-`trend` payload entry first; don't revert to blindly reading `payload[0]`, or dots become unhoverable again (verified empirically with Playwright — this is not a hypothetical).

### Theming (Admin > Config)
- Color keys: `primary` (Scores), `machine`, `venue`, `username`, `field` (others'/aggregate chart color). Defined in `src/lib/theme.tsx` (`DEFAULT_COLORS`), applied as CSS vars on `documentElement`, exposed as Tailwind colors (`text-venue`, `bg-username`, etc.) via `tailwind.config.ts`.
- **Recharts elements** (Line/Scatter `stroke`/`fill`) can't use Tailwind classes — pass `"hsl(var(--venue))"` etc. directly as the prop value; browsers resolve CSS custom properties fine in SVG presentation attributes.
- **Leaflet popups**: `leaflet.css` ships `.leaflet-container a { color: #0078A8 }`, which beats single-class Tailwind utilities on specificity. Any new colored link inside a `<Popup>` needs a matching override in `index.css` under `.leaflet-container .text-<key>` (see existing block) — otherwise it silently renders Leaflet's default blue regardless of the `text-*` class applied.

### Venue machine history (`venue_machine_history` table, added 2026-07-01)
- Tracks which machines have been at a venue over time, since operators rotate inventory and Pinball Map only exposes each location's *current* roster (no history via their public API — confirmed empirically: their `user_submissions.json` activity feed is capped at the most recent ~200 events per region, non-paginated, no location filter, so anything older scrolls off with no way to page back).
- **Lazy, not polled**: `syncVenueMachineHistory()` only runs as a side effect of `GET /api/venues/:id/machines` — i.e. whenever someone actually opens that venue in the app (VenuesPage modal or AddScorePage's venue step). A venue nobody looks at doesn't get its history advanced, and the recorded `removedAt` is "first time we happened to notice it was gone," not the operator's actual removal date.
- Guards against `getPmMachinesAtLocation()` returning `[]` on a fetch failure (a real thing it does) — `syncVenueMachineHistory` only marks machines removed when the live list is non-empty, so a transient PM API blip can't mass-mark an entire venue's roster as gone.
- Pre-existing venue history (before this table existed) is **not recoverable** — verified by checking both Pinball Map's API and our own `scores` table for a specific venue with no trace of an earlier machine. Don't try to backfill; the table only knows what it's observed since 2026-07-01.
- `AddScorePage.tsx` unions in machines removed within the last 90 days (`RECENTLY_LEFT_DAYS`) as valid suggestions, tagged "Recently left" — this is what makes late score uploads work (e.g. photo taken Friday night, uploaded Monday, machine swapped Saturday): the machine just shows a badge instead of triggering the "not found in Pinball Map" confirmation dialog. Score submission itself was never gated on live PM presence anyway (that confirm-and-continue escape hatch already existed) — this table only makes the UX honest about it.

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
| `artifacts/api-server/src/lib/venueHistory.ts` | Diffs live PM machine list vs. last snapshot; records arrivals/departures |
| `lib/db/src/schema.ts` | Drizzle schema — source of truth for DB types |
| `artifacts/api-server/migrate*.ts` | Numbered migration scripts (run once, keep for history) |
