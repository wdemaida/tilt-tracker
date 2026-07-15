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

**Git identity must be `wdemaida` / `wdemaida@gmail.com`** — the remote is `https://wdemaida@github.com/wdemaida/tilt-tracker.git`. If Vercel deployments start failing with "not a member" errors, check `git config user.name/email` in the repo.

Push uses an isolated `GH_CONFIG_DIR` (not the global `gh` login) — see the **deploy** skill (`.claude/skills/deploy/SKILL.md`) for the credential setup, production URLs/service keys, and Vercel/Render-specific gotchas.

---

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
| `artifacts/api-server/src/lib/venueHistory.ts` | Diffs live PM machine list vs. last snapshot; records arrivals/departures |
| `lib/db/src/schema.ts` | Drizzle schema — source of truth for DB types |
| `artifacts/api-server/migrate*.ts` | Numbered migration scripts (run once, keep for history) |
