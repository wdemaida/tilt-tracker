# CLAUDE.md — api-server (backend)

## HERE API
- Use the **browse** endpoint (`browse.search.hereapi.com/v1/browse`) with `categories=100,200,300,500,600,700` and `at=lat,lng`. Do NOT use the `discover` endpoint — without a bounding circle it searches globally.
- Key is in `artifacts/api-server/.env` as `HERE_API_KEY`.

## Pinball Map API
- `max_distance` is **integer miles** — decimal values get truncated to 0. Use `Math.ceil`.
- `/locations/:id/machine_details.json` returns `{ machines: [...] }`.
- `/locations/:id.json` returns xref IDs in `location_machine_xrefs[].id`.
- Single machine lookup (`/machines/:id.json`) returns 404 — use the full cached list with in-memory search.

## Photo / GPS extraction
- Use **`exifr`** (not `exifreader`) for GPS from iPhone HEIC files: `await Exifr.gps(buffer)`.
- Extract GPS from the **original buffer before HEIC→JPEG conversion** — conversion strips EXIF.
- `playedAt` uses `DateTimeOriginal` from EXIF; AI result is fallback only.

## Venue machine history (`venue_machine_history` table, added 2026-07-01)
- Tracks which machines have been at a venue over time, since operators rotate inventory and Pinball Map only exposes each location's *current* roster (no history via their public API — confirmed empirically: their `user_submissions.json` activity feed is capped at the most recent ~200 events per region, non-paginated, no location filter, so anything older scrolls off with no way to page back).
- **Lazy, not polled**: `syncVenueMachineHistory()` only runs as a side effect of `GET /api/venues/:id/machines` — i.e. whenever someone actually opens that venue in the app (VenuesPage modal or AddScorePage's venue step). A venue nobody looks at doesn't get its history advanced, and the recorded `removedAt` is "first time we happened to notice it was gone," not the operator's actual removal date.
- Guards against `getPmMachinesAtLocation()` returning `[]` on a fetch failure (a real thing it does) — `syncVenueMachineHistory` only marks machines removed when the live list is non-empty, so a transient PM API blip can't mass-mark an entire venue's roster as gone.
- Pre-existing venue history (before this table existed) is **not recoverable** — verified by checking both Pinball Map's API and our own `scores` table for a specific venue with no trace of an earlier machine. Don't try to backfill; the table only knows what it's observed since 2026-07-01.
- `AddScorePage.tsx` unions in machines removed within the last 90 days (`RECENTLY_LEFT_DAYS`) as valid suggestions, tagged "Recently left" — this is what makes late score uploads work (e.g. photo taken Friday night, uploaded Monday, machine swapped Saturday): the machine just shows a badge instead of triggering the "not found in Pinball Map" confirmation dialog. Score submission itself was never gated on live PM presence anyway (that confirm-and-continue escape hatch already existed) — this table only makes the UX honest about it.
