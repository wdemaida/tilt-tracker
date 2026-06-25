## Tilt Tracker app description

## Here

Here's a rundown of everything powering TiltTrack:

Monorepo structure

pnpm workspaces — all packages managed together under one repo
Frontend (artifacts/pinball-tracker)

React + Vite — fast dev server, TypeScript throughout
Wouter — lightweight client-side routing
React Hook Form + Zod — form state and validation
TanStack Query — server state, caching, and query invalidation
Tailwind CSS — utility-first styling
Framer Motion — animations and transitions
Radix UI — accessible headless components (dialogs, etc.)
Lucide React — icons
Clerk — user authentication (Google OAuth + email/password)
date-fns — date formatting
Backend (artifacts/api-server)

Express (Node.js, TypeScript, ESM via tsx)
Drizzle ORM — type-safe SQL queries against PostgreSQL
PostgreSQL — Replit-hosted database
Anthropic Claude — AI photo analysis (extracts machine name, score, date, and GPS from uploaded pinball score photos)
HEIC conversion — converts iPhone HEIC photos before sending to AI
HERE Places API — nearby venue search by GPS coordinates
Foursquare API — supplemental venue data
Pinball Map API — free public machine database (~2,261 machines), cached in memory, used for machine name typeahead with Pro/LE/Premium variant support, OPDB IDs, and IPDB IDs
Shared packages (lib/)

@workspace/db — Drizzle schema + database client
@workspace/api-spec — OpenAPI spec (YAML)
@workspace/api-client-react — auto-generated React Query hooks via Orval (codegen from the OpenAPI spec)
Data flow highlight

User uploads a photo → Claude AI reads the score, machine name, and GPS metadata
Machine name is auto-searched against Pinball Map's database → user picks the correct variant (e.g. Metallica Pro vs LE)
Selected machine is upserted to the local machines table and linked to the score
GPS coordinates trigger a HERE Places lookup for nearby venues