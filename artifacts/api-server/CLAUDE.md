# CLAUDE.md — api-server (backend)

## HERE API
- Use the **browse** endpoint (`browse.search.hereapi.com/v1/browse`) with `categories=100,200,300,500,600,700` and `at=lat,lng`. Do NOT use the `discover` endpoint *without* an `at` anchor — unbounded it searches globally. `findVenueByName()` does use discover, but always pinned to the venue's own coordinates and filtered to <2km.
- Key is in `artifacts/api-server/.env` as `HERE_API_KEY`.
- **Never trust HERE's result ordering inside a dense building.** Browse ranks by distance with an arbitrary tiebreak, so at an address where every tenant shares one geocode (213 W Institute Pl, Chicago — Headquarters Beercade) the venue you want can land at rank 13 behind a dozen law offices, all reporting the same 18m. `getNearbyVenues()` therefore over-fetches `limit=100` (HERE's per-page max — still one request) and re-ranks by category plausibility before slicing to the caller's limit. Raising the limit alone is not enough; the re-rank is what fixes it.
- Pinball-relevant category ids, verified empirically: **`200-2000-0017` Video Arcade-Game Room** (the strongest signal — carried by both Logan Arcade and Headquarters Beercade) and `200-2000-0011` Bar or Pub. Both sit under the already-included `200` prefix, so the category filter was never the bug.

## Pinball Map API
- **Every endpoint requires an `api_token` query param** as of 2026-07-30 — including read-only GETs. It goes on the **query string, not a header** (per `pinballmap.com/llms.txt`; the 2017 blog post describing `user_email`/`user_token` is the separate *user* auth for writes). Stored as `PINBALL_MAP_API_TOKEN` in `.env`; request one at <https://pinballmap.com/api_token>, approval is manual.
  - Without it every call returns `401 {"error":"A valid api_token is required..."}`. This went unnoticed for weeks because every call site swallowed failures (`if (!res.ok) return []` / `.catch(() => [])`), so the app looked like it was working while silently producing empty venue and machine lists — and `upsertMachineByName()` quietly inserted unenriched AI-extracted names, creating duplicate machine rows ("Transformers" vs "The Transformers"). **Don't add new silent `catch → []` around PM calls.** Use `pmFetch` in `pinballmapApi.ts`, which throws a typed `PmApiError`; let it propagate and surface the reason.
- `max_distance` is **integer miles** — decimal values get truncated to 0. Use `Math.ceil`.
- `/locations/:id.json` (the default, full response) already embeds each machine's `name`, `manufacturer` and `year` on every `location_machine_xrefs[]` entry, alongside the xref `id`. `getPmMachinesAtLocation()` reads that in **one** call; it only falls back to `/locations/:id/machine_details.json` if names are ever missing. PM's own guidance singles out per-record fan-out as what gets apps blocked.
- Use `no_details=1` on bulk reads (`machines.json`, `closest_by_lat_lon`, `locations.json`) to cut response size.
- Single machine lookup (`/machines/:id.json`) returns 404 — use the full cached list with in-memory search.
- `GET /locations/autocomplete.json?name=` returns a bare array of `{label, value}` (value = location id), and only matches from the **start** of the name — `searchPmLocationsByName()` falls back to `locations.json?by_location_name=` when it comes up empty.
- **Attribution is a licence condition**, not a nicety: data shown for a specific location must link to `https://pinballmap.com/map?by_location_id=<id>` (see `pmLocationUrl()`), not just the homepage. That URL is also how a user finds a location's numeric id in PM's own UI.
- **Rate limits / caching**: PM explicitly warns against request volume that scales with your traffic rather than with how often the data changes. **All roster reads go through `getVenueRoster()` in `pmRosterCache.ts`** — never call `getPmMachinesAtLocation()` directly from a route. It's backed by the `pm_location_cache` table, keyed by *their* location id (so the venue page, `/pm-machines/:pmId` and score cross-posting share one entry), with a 6-hour TTL. Verified: 10 venue-page views produce 0 outbound requests. Pass `{ force: true }` only for deliberate user actions where freshness is the point (linking a venue, previewing a re-sync). On a PM failure with a cached row it returns the **stale** roster with `stale: true` rather than an empty list — a venue page should never imply a venue is empty because their API was down.
- `syncVenueMachineHistory()` now only runs when the roster was actually re-fetched (`!roster.fromCache`). A cache hit carries no new information, and re-diffing on every page view churned `lastSeenAt` and re-upserted every machine row for nothing.

## Venue repair (`src/lib/venueRepair.ts`, routes under `/api/venues/:id/repair/*`, added 2026-09-11)
- Recovery path for a venue the upload flow never resolved: **1)** re-run HERE off the (possibly after-the-fact) address, **2)** link a Pinball Map location by search or manual id, **3)** re-sync the scores already logged there.
- Permissions: **admin, the venue's `ownerId`, or its `createdById`** (`canRepairVenue`). `createdById` was added because upload-flow venues have no owner — without it, any user whose venue failed to resolve would need an admin to rescue them. Score re-syncs are scoped: a non-admin only ever previews and moves **their own** scores.
- `normalizeMachineName()` folds case, punctuation, a leading "The", and edition suffixes (`(Pro)`/`(Premium)`/`(LE)`) — and **folds diacritics via NFD first**, or "Pokémon" becomes `pok mon` and stops matching PM's "Pokemon". It deliberately does *not* strip subtitles; "King Kong" and "King Kong: Myth of Terror Island" are different machines.
- **Per-score repair** (`/api/scores/:id/repair`, `POST .../repair/machine`) is the same machinery scoped to one score, for the edit-score modal. `rankRosterForName()` returns the venue's whole roster ranked against one machine name so the UI can show a recommendation *and* let the user override it. `retireMachineIfUnused()` is shared with the bulk path so neither strands an orphan machine row.
- **`PATCH /api/scores/:id` is owner-or-admin**, not admin-only (changed 2026-09-11). It was `requireAdmin`, which meant no ordinary user could correct their own misread machine name — the exact thing the repair flow exists to fix. Mirrors how `DELETE` already worked.
- Match tiers: `exact` → `normalized` → `fuzzy` (whole-word prefix, and **only when exactly one** candidate matches — ambiguity is not a match) → `unmatched`. Only `normalized` is pre-ticked in the UI; `fuzzy` requires a deliberate click, because a machine row is global and merging it rewrites that machine's identity at every venue.

## HERE vs Pinball Map — what each is load-bearing for
- **Pinball Map is the functional dependency**: it supplies the machine roster, so machine matching
  and score re-sync are gated on `pinballMapId`. Missing = the feature genuinely can't work (amber).
- **HERE is venue identity and de-duplication**, not machines. Its real job is being the
  `onConflictDoUpdate` target in `scores.ts` that stops a second venue row being created — note
  Postgres treats `NULL != NULL` in a unique index, so a null `here_id` can never conflict-match.
  Missing = hygiene, not breakage (rendered as a neutral chip, `tone="info"`).
- **Don't gate machine features on `hereId`.** 30 venues arrived from the 2026-06-30 seed script with
  `pinball_map_id` set and `here_id` null; they match machines perfectly well.
- `backfillHere.ts` (run 2026-09-11, `--apply`) filled 24 of them by name+coords, taking HERE-linked
  venues from 4 to 28. Re-runnable and dry-run by default. The 8 left are genuinely ambiguous
  (two Lucky Strikes, a venue since renamed Lucky Strike Fenway) or absent from HERE — repair those
  by hand from the venue page rather than loosening the match rules.
- Auto-attach requires name overlap **and** `distance < 500m` absolute, **and** either a lone
  candidate or `distance < 100m`. The absolute ceiling exists because "only one result" would
  otherwise attach a match from the next town.

## Photo / GPS extraction
- Use **`exifr`** (not `exifreader`) for GPS from iPhone HEIC files: `await Exifr.gps(buffer)`.
- Extract GPS from the **original buffer before HEIC→JPEG conversion** — conversion strips EXIF.
- `playedAt` uses `DateTimeOriginal` from EXIF; AI result is fallback only.
- **EXIF timestamps are naive wall clocks and must stay that way through the response.** exifr builds
  its `Date` by reading the camera's zone-less digits in the *host's* timezone, so `toISOString()`
  relabels them with the host's offset — on Render (UTC) a 6:01pm Chicago photo was stored as
  `18:01Z` and every score card rendered five hours early. `toNaiveLocal()` in `upload.ts` reads the
  components back out with the local getters, and the route returns `playedAt` as a zone-less
  `YYYY-MM-DDTHH:mm:ss`. The **browser** turns it into an instant against the viewer's timezone (see
  `src/lib/datetime.ts` on the frontend) — never call `new Date()` on that value server-side.
- **`scores.played_at` / `created_at` are `timestamp WITHOUT time zone`.** Prod is only self-consistent
  because Render runs in UTC; a score written by a locally-run api-server stores an ET wall clock into
  the same column. Migrating both to `timestamptz` is the real fix, not yet done. When querying them
  for debugging, select `::text` — postgres.js parses them into a Date in *your* zone, so
  `new Date(row.created_at).toISOString()` prints times that don't match the column.

## Venue machine history (`venue_machine_history` table, added 2026-07-01)
- Tracks which machines have been at a venue over time, since operators rotate inventory and Pinball Map only exposes each location's *current* roster (no history via their public API — confirmed empirically: their `user_submissions.json` activity feed is capped at the most recent ~200 events per region, non-paginated, no location filter, so anything older scrolls off with no way to page back).
- **Lazy, not polled**: `syncVenueMachineHistory()` only runs as a side effect of `GET /api/venues/:id/machines` — i.e. whenever someone actually opens that venue in the app (VenuesPage modal or AddScorePage's venue step). A venue nobody looks at doesn't get its history advanced, and the recorded `removedAt` is "first time we happened to notice it was gone," not the operator's actual removal date.
- Guards against `getPmMachinesAtLocation()` returning `[]` on a fetch failure (a real thing it does) — `syncVenueMachineHistory` only marks machines removed when the live list is non-empty, so a transient PM API blip can't mass-mark an entire venue's roster as gone.
- Pre-existing venue history (before this table existed) is **not recoverable** — verified by checking both Pinball Map's API and our own `scores` table for a specific venue with no trace of an earlier machine. Don't try to backfill; the table only knows what it's observed since 2026-07-01.
- `AddScorePage.tsx` unions in machines removed within the last 90 days (`RECENTLY_LEFT_DAYS`) as valid suggestions, tagged "Recently left" — this is what makes late score uploads work (e.g. photo taken Friday night, uploaded Monday, machine swapped Saturday): the machine just shows a badge instead of triggering the "not found in Pinball Map" confirmation dialog. Score submission itself was never gated on live PM presence anyway (that confirm-and-continue escape hatch already existed) — this table only makes the UX honest about it.
