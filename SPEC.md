# TiltTrack — App Specification

> **Purpose:** Rebuild this app locally from scratch. The original was built on Replit and cannot be downloaded. This document is the single source of truth for what to build — derived from live exploration of https://pinball-high-score--wdemaida.replit.app/ combined with the original tech stack notes.

---

## Setup Checklist

Complete these before scaffolding. Each item is a prerequisite for a different part of the app.

### 1. Clerk (Authentication) ✅
- [x] Application exists: **TiltTrack** (`quick-piranha-9.clerk.accounts.dev`)
- [x] Keys stored in `artifacts/pinball-tracker/.env` and `artifacts/api-server/.env`
- [x] Confirm **Google** is enabled as a social provider (Settings → Social connections)
- [x] `localhost` origins are allowed automatically on development instances — no config needed

### 2. Anthropic API Key (Claude photo analysis) ✅
- [x] Key stored in `artifacts/api-server/.env`

### 3. HERE Places API (venue lookup from GPS)
- [ ] Go to https://developer.here.com and sign up
- [ ] Create a new project and generate an **API key**
- [ ] Free tier: 1,000 requests/day — plenty for personal use

### 4. PostgreSQL — Neon ✅
- [x] Connection string stored in `artifacts/api-server/.env`

### 5. HERE Places API ✅
- [x] Token stored in `artifacts/api-server/.env`

### 6. Foursquare API (optional — supplemental venue data)
- The app uses this for additional venue metadata, but it's not critical
- [ ] Skip for now; add later if HERE Places results feel incomplete

### 6. Environment Variables
Once you have the keys, create these two `.env` files before running the app:

**`artifacts/api-server/.env`**
```
DATABASE_URL=postgresql://...
CLERK_SECRET_KEY=sk_test_...
ANTHROPIC_API_KEY=sk-ant-...
HERE_API_KEY=...
```

**`artifacts/pinball-tracker/.env`**
```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_API_BASE_URL=http://localhost:3000
```

> Note: Never commit `.env` files. A `.gitignore` will be set up to exclude them.

---

## What It Is

A pinball high score tracker called **TILTTRACK**. Users photograph their pinball score screens; Claude AI extracts the machine name, score, timestamp, and GPS location. Scores are stored, browsable, and mapped. The app targets casual pinball players who want to track their personal bests across machines and venues.

---

## Routes

| Route | Auth required | Description |
|-------|:---:|-------------|
| `/` | No | Score feed — card grid of all scores, filterable by all/casual/tournament, search bar |
| `/machines` | No | Machine list ranked by personal best score, searchable |
| `/machines/:name` | No | Machine detail — personal best card + full score history table, sortable by date or score |
| `/map` | No | Leaflet map showing GPS-tagged score locations as clustered pins |
| `/stats` | No | Player stats: total games logged, all-time high score, most-played-machines bar chart, casual vs tournament split |
| `/add` | Yes | Add Score wizard (2 steps — see below) |
| `/setup` | Yes | New-user onboarding: collect display name + username before entering the app |
| `/users/:username` | No | Public user profile — all scores with machine thumbnail, date, venue, score |
| `/sign-in` | No | Clerk sign-in page (Google OAuth + email/password) |
| `/sign-up` | No | Clerk registration page |

---

## Feature Details

### Score Feed (`/`)
- Card grid layout
- Each card shows: game type badge (CASUAL / TOURNAMENT), machine name, score, date+time, venue name, "PROOF ATTACHED" indicator (if photo exists), username link
- Filter tabs: ALL / CASUAL / TOURNAMENT
- Search bar filters by machine name
- Unauthenticated users see all public scores; username links go to `/users/:username`

### Machines (`/machines`)
- Ranked list: #1 machine = personal best score across all plays
- Each row: star icon (for top machine), machine name, play count, last played date, BEST score
- Searchable
- Click → `/machines/:name`

### Machine Detail (`/machines/:name`)
- "← ALL MACHINES" back link
- Machine name heading + "N scores recorded"
- Personal Best card: trophy icon, score in pink, date · venue
- Sort toggles: DATE ↓ / SCORE ↑↓
- Score table columns: DATE & VENUE | TYPE | SCORE | Actions
  - BEST badge on the top score row
  - TYPE: CASUAL or TOURNAMENT pill badge
  - Actions column: likely edit / delete (partially obscured in capture)
- "+ ADD SCORE" button shortcut (top right)

### Map (`/map`)
- Leaflet.js map, CARTO dark tile layer
- Subtitle: "N locations · N scores with GPS"
- Pink circular pins for each venue cluster
- Zoom +/- controls

### Stats (`/stats`)
- TOTAL GAMES LOGGED (count)
- ALL-TIME HIGH SCORE: score value + machine name + "Achieved at [venue]"
- MOST PLAYED MACHINES: bar chart (machine name on x-axis, play count on y-axis), pink bars
- PLAY STYLE panel: Casual Drops count + bar, Tournament Play count + bar, "Tournament games account for X% of your total recorded plays."

### Add Score — 2-Step Wizard (`/add`)
**Step 1 — Upload Evidence:**
- Dashed-border dropzone (pink outline)
- Camera icon + "TAP TO TAKE PHOTO / or choose from camera roll"
- Hidden `<input type="file" accept="image/*">`
- HEIC conversion handled server-side before sending to AI
- Escape hatch: "SKIP AI & ENTER MANUALLY >" link

**Step 2 — Confirm / Edit Details (after AI or manual skip):**
- AI extracts from photo: machine name, score, timestamp, GPS coordinates
- Machine name typeahead searches Pinball Map API (~2,261 machines); user picks correct variant (e.g. Metallica Pro vs LE vs Premium)
- Selected machine upserted to local `machines` table, linked to the score
- GPS coordinates → HERE Places API call for nearby venue name
- User confirms/edits all fields before saving
- Type selection: CASUAL or TOURNAMENT

### New User Onboarding (`/setup`)
- Triggered automatically after first Clerk login if no profile exists
- DISPLAY NAME field (free text, placeholder: "Your full name or nickname")
- USERNAME field (letters/numbers/underscores only, `@` prefix hint, placeholder: "yourhandle")
- "LET'S GO" CTA
- Stores to app's own `users` table (not just Clerk metadata)

### User Profile (`/users/:username`)
- "WILL DEMAIDA" display name heading, `@username` handle, "N scores" count
- Chronological list of all scores: machine thumbnail image (left), machine name, date+time, venue name, score (right, pink)
- Machine name links to `/machines/:name`

### Authentication (Clerk)
- Google OAuth + email/password
- Authenticated header: "ADD SCORE" pink CTA + Clerk UserButton (avatar, far right)
- Unauthenticated header: "SIGN IN" link
- No custom settings/profile pages — `/settings`, `/profile`, `/account` all 404; Clerk UserButton dropdown handles all account management

---

## Data Model

### `users`
| Field | Type | Notes |
|-------|------|-------|
| id | uuid / serial | primary key |
| clerk_id | string | foreign key to Clerk user |
| username | string | unique, URL-safe |
| display_name | string | shown on profile |
| created_at | timestamp | |

### `machines`
| Field | Type | Notes |
|-------|------|-------|
| id | serial | primary key |
| name | string | e.g. "The Munsters" |
| opdb_id | string | from Pinball Map API |
| ipdb_id | string | from Pinball Map API |
| variant | string | Pro / LE / Premium / Standard |
| created_at | timestamp | |

### `scores`
| Field | Type | Notes |
|-------|------|-------|
| id | serial | primary key |
| user_id | fk → users | |
| machine_id | fk → machines | |
| score | bigint | high scores can exceed 2^31 |
| played_at | timestamp | from photo EXIF or manual entry |
| type | enum | 'casual' \| 'tournament' |
| venue_name | string | from HERE Places API |
| latitude | decimal | GPS from photo EXIF |
| longitude | decimal | GPS from photo EXIF |
| photo_url | string | uploaded proof image |
| created_at | timestamp | |

---

## Tech Stack

### Monorepo Structure (pnpm workspaces)
```
/
├── artifacts/
│   ├── pinball-tracker/    # React frontend
│   └── api-server/         # Express backend
├── lib/
│   ├── db/                 # @workspace/db — Drizzle schema + DB client
│   ├── api-spec/           # @workspace/api-spec — OpenAPI spec (YAML)
│   └── api-client-react/   # @workspace/api-client-react — React Query hooks (Orval codegen)
└── pnpm-workspace.yaml
```

### Frontend (`artifacts/pinball-tracker`)
- **React + Vite** — TypeScript throughout
- **Wouter** — lightweight client-side routing
- **TanStack Query** — server state, caching, query invalidation
- **React Hook Form + Zod** — form state and validation
- **Tailwind CSS** — utility-first styling
- **Framer Motion** — animations and transitions
- **Radix UI** — accessible headless components (dialogs, dropdowns, etc.)
- **Lucide React** — icons
- **Clerk** — auth (Google OAuth + email/password), UserButton component
- **Leaflet.js** — interactive map (CARTO dark tiles)
- **date-fns** — date formatting

### Backend (`artifacts/api-server`)
- **Express** — Node.js, TypeScript, ESM via `tsx`
- **Drizzle ORM** — type-safe SQL queries
- **PostgreSQL** — primary database
- **Anthropic Claude API** — photo analysis: extracts machine name, score, date, GPS from pinball score photos
- **HEIC conversion** — converts iPhone HEIC photos before sending to AI
- **HERE Places API** — nearby venue search by GPS coordinates
- **Foursquare API** — supplemental venue data
- **Pinball Map API** — free public machine database (~2,261 machines), cached in memory; used for machine name typeahead with Pro/LE/Premium variant support, OPDB IDs, and IPDB IDs

### Shared (`lib/`)
- **@workspace/db** — Drizzle schema definitions + database client (shared between api-server and migrations)
- **@workspace/api-spec** — OpenAPI spec in YAML (the contract between frontend and backend)
- **@workspace/api-client-react** — auto-generated React Query hooks via **Orval** (codegen from the OpenAPI spec); frontend imports these instead of writing fetch calls manually

### Data Flow — Add Score
```
User uploads photo
  → HEIC conversion (if needed)
  → Claude AI (extracts: machine name, score, timestamp, GPS)
  → Pinball Map API typeahead (user confirms machine + variant)
  → Machine upserted to machines table
  → HERE Places API (GPS → venue name)
  → Score saved to scores table with all fields
```

---

## Design System

### Visual Identity
- **Name:** TILTTRACK (displayed as "TILT**TRACK**" with "TRACK" in primary pink)
- **Icon:** Trophy (Lucide), displayed in a rounded square with pink border/glow
- **Vibe:** Arcade machine / pinball aesthetic — dark, high-contrast, glowing accents

### Colors
- Background: near-black (`bg-background`)
- Primary accent: **pink/magenta** (`text-primary`, glow effects like `text-glow-primary`)
- Muted: dark gray for secondary text
- Cards: slightly lighter dark surface
- Badges: CASUAL = muted pill, TOURNAMENT = distinct pill

### Typography
- **Font:** Inter (Google Fonts), weights 400/500/600/700
- **Headings:** uppercase, bold, wide letter-spacing (`tracking-widest`)
- **Nav items:** `text-sm font-bold uppercase tracking-wider`
- **Scores:** large, bold, pink

### Layout
- Max width: `max-w-7xl mx-auto`
- Header: sticky, `z-50`, `backdrop-blur-xl`, `bg-background/80`, bottom border `border-white/10`
- Header height: `h-20`
- Responsive: mobile-first, hamburger menu on small screens
- Cards: rounded corners, dark surface, subtle border

### Key UI Patterns
- Score cards on home page: "PROOF ATTACHED" label when photo exists
- BEST badge (pink) on top score in machine detail table
- Personal Best card: trophy icon + large pink score + date · venue
- Step indicator: numbered circles (1, 2) connected by a line for the Add Score wizard
- Dashed pink border on photo dropzone
- Pink glow on active nav item (`text-glow-primary`)

---

## External APIs & Keys Needed

| Service | Purpose | Notes |
|---------|---------|-------|
| Clerk | Authentication | Publishable key + secret key; configure Google OAuth |
| Anthropic Claude | Photo AI analysis | `claude-sonnet-*` model recommended |
| HERE Places API | Venue lookup from GPS | Free tier available |
| Foursquare API | Supplemental venue data | May be optional |
| Pinball Map API | Machine typeahead | Free, public, no key needed |
| PostgreSQL | Database | Local or hosted (Neon, Supabase, Railway, etc.) |

---

## Known Data (helmhead / Will Demaida)
- 7 scores total across 6 machines
- Machines: The Munsters, The Shadow, Elton John, Indiana Jones: The Pinball Adventure, The Lord of the Rings, Metallica
- Venues: Pastime Pinball (most scores), Red Nun Bar & Grill
- All scores tagged CASUAL (no tournament entries yet)
- All-time best: **102,070,660** on The Shadow at Pastime Pinball
