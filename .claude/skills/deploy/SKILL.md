---
name: deploy
description: Deploy TiltTrack (production URLs, service API keys, push credential setup, Vercel/Render gotchas). Use when actually running the deploy sequence from the root CLAUDE.md, or when a deploy/push fails.
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

## Push credential (isolated `GH_CONFIG_DIR`, set up 2026-07-01)

The user's global `gh` CLI is often authenticated as a different GitHub account (`WillDeMaidaNymbl`, used for other repos/Actions work), and `gh auth switch` is unsafe across concurrent Claude Code windows on different projects/accounts (it mutates the one shared `~/.config/gh/hosts.yml`). This repo instead uses a dedicated, isolated gh config directory: `~/.gh-config-personal`, logged in as `wdemaida`, which never touches the global gh state.

This repo's **local** (not global) git config routes `github.com` credential lookups through that isolated dir:
```
git config --local --get-all credential.https://github.com.helper
```
should return two lines — an empty one (resets the inherited global helper chain) followed by:
```
!GH_CONFIG_DIR='C:/Users/wdema/.gh-config-personal' gh auth git-credential
```
This does not affect other repos on the machine (they still use the global `gh`-based flow / whatever account that resolves to). If push ever fails, re-verify those two lines are present (`--add`, not a plain set, when recreating — the key is multi-valued) and that the isolated login is still valid: `GH_CONFIG_DIR=~/.gh-config-personal gh auth status`. Any `gh` CLI command run manually against this repo should also be prefixed with `GH_CONFIG_DIR=~/.gh-config-personal`.

## Vercel deploys — known gotchas

- `tilttrack.vercel.app` is registered as a **project domain** (not a frozen alias) so it auto-tracks the latest `main` deploy. If it ever serves stale code, check `GET /v3/aliases/tilttrack.vercel.app` to see what deployment it points to.
- When a deploy gets stuck/cancelled, trigger one directly via the Vercel API: `POST /v13/deployments` with `gitSource: { type: 'github', org: 'wdemaida', repo: 'tilt-tracker', ref: 'main', sha }`.
- `render.yaml` in the repo root **does not auto-apply** to the existing Render service — use the Render API or dashboard to update build/start commands.
- Render's `PUT /v1/services/{id}/env-vars` **replaces all env vars** — always include every var, never update one in isolation.
