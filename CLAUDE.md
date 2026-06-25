# CLAUDE.md

## Project Goal

Rebuild **TiltTrack** — a pinball high score tracker — as a local project, migrated from the original Replit deployment. See **[SPEC.md](./SPEC.md)** for the full app specification: routes, features, data model, tech stack, and design system.

## Tech Stack (planned)

pnpm monorepo with:
- `artifacts/pinball-tracker` — React + Vite + TypeScript frontend
- `artifacts/api-server` — Express + Node.js + TypeScript backend
- `lib/db` — Drizzle ORM schema + DB client
- `lib/api-spec` — OpenAPI YAML spec
- `lib/api-client-react` — Orval-generated React Query hooks

## Status

Project is in early initialization — no source code exists yet. Update this file with build commands, environment setup, and conventions once the scaffold is in place.
