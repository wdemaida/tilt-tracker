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
Runs on port 3000. Vite proxies `/api/*` to it automatically.

Both must be running for the app to work.

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

**Push credential:** the user's `gh` CLI is often authenticated as a different GitHub account (`WillDeMaidaNymbl`, used for other repos/Actions work) and the global `~/.gitconfig` routes all `github.com` auth through `gh auth git-credential` — which silently fails to produce a `wdemaida` credential and `git push` errors with a `/dev/tty` / "could not read Password" failure. Fixed via a **repo-local** override (in this repo's `.git/config` only, not global) that routes `github.com` auth back through Windows Credential Manager (`manager`), which has a `wdemaida` fine-grained PAT cached for this repo. This does not affect other repos on the machine (they still use the global `gh`-based flow). If push ever fails again with a `/dev/tty` error, check `git config --local --get-all credential.https://github.com.helper` returns `manager`; if the cached credential expired (PAT is set to expire ~1yr from 2026-06-30), the user needs to generate a new fine-grained PAT (Contents: Read/write, scoped to just this repo) and re-seed it via one interactive `git push` from a real terminal window (not through Claude Code — GCM's prompt needs a real console).

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
| `lib/db/src/schema.ts` | Drizzle schema — source of truth for DB types |
| `artifacts/api-server/migrate*.ts` | Numbered migration scripts (run once, keep for history) |
