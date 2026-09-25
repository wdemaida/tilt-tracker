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
- `GET /locations/autocomplete.json?name=` returns a bare array, and only matches from the **start** of the name — `searchPmLocationsByName()` falls back to `locations.json?by_location_name=` when it comes up empty. **As of 2026-09-24 each entry is `{label, value, id}` with `value` = the location *name*** ("Special When Lit") and `id` = the numeric id. The code used to read `value` as the id, which turned every autocomplete hit into a discarded non-numeric id — the repair panel's Pinball Map name search silently returned nothing for any name autocomplete matched. `pmAutocompleteId()` now prefers `id`.
- `locations.json?by_location_name=` returns **full records** (street, city, state, zip, `country`, lat/lon) in one call; autocomplete returns only a label. PM `lat`/`lon` arrive as **decimal strings** — `Number()` them before storing. PM is international (the other "Special When Lit" is in Salisbury, UK, `state: null`).
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

## Address-less venues (`src/lib/venueAddress.ts`, `/repair/place-search` + `/repair/place`, added 2026-09-24)
- A venue typed in by name at upload with location services off has **no address, coordinates, HERE
  id or PM link** (prod venue 47 "Special when lit"). `/repair/here` 400s on it — it geocodes the
  existing address — and `PATCH /api/venues/:id` is admin/owner only, so its creator had no way in.
- `GET /:id/repair/place-search?q=&near=` searches **Pinball Map by name** (`searchPmLocationsWithAddress`)
  and **HERE anchored**: at the geocoded `near` text (50km) or, with no `near`, at each of the top 3
  PM hits' own coordinates (2km). HERE is never searched unanchored. Candidates carry
  `linkedElsewhere` when another TiltTrack venue already holds that hereId / PM id (likely duplicate),
  and `linkedVenue {id,name}` **only when that holder is public** — `describeHolder()` never names a
  residence or restricted-tier venue next to a candidate's exact coordinates. The HERE-pick 409
  (`here_id_taken`), `possibleDuplicates` (plus an anonymous `privateDuplicate` flag) follow the same rule.
- `POST /:id/repair/place` takes `{source:'pm', pinballMapId}`, `{source:'here', hereId}` or
  `{source:'manual', street, city, state?, postalCode?, country?, confirm?}`. The server **re-reads**
  the PM listing / HERE place (Lookup endpoint) itself — the client never supplies coordinates. Manual
  without `confirm: true` returns a geocode preview (with `precise: false` for city-centroid matches)
  and writes nothing; confirming a `precise: false` match (e.g. HERE fell back to the city centroid
  for a misspelt street) is a 422 `imprecise_geocode` unless the body also says `acceptImprecise: true`.
  PM picks don't link PM — they return `pmPreselect` so step 2 offers it and the
  existing `pm-link` route (verification + history seeding) still does the linking.
- Eligibility is `addressResolutionBlocker()`: `canRepairVenue` **and** not a residence (`isResidence`
  or any non-`full` tier) **and** no address yet. Residences are excluded outright — their location is
  the owner's to disclose via Edit Venue, where the tier is chosen. The UPDATE is guarded on
  `address IS NULL` so it can never move a venue that someone placed concurrently.
- The HERE auto-attach rule is now `pickConfidentHereMatch()`, shared by `/repair/here` and this flow.
- **Restricted-tier venues get no HERE / Pinball Map linkage** (`linkageBlockedByPrivacy()`, 409
  `venue_private` from `/repair/here`, `/repair/here/attach` and `/repair/pm-link`). Both ids go out
  unredacted on venue payloads (`pinballMapId` on the list, `pmLocationUrl` and `hereId` on
  `/venues/:id/machines`), so either would publish the location the tier hides. A residence shown in
  `full` tier is allowed. Status payloads carry `linkageBlocked` so the UI explains instead of 409ing.
- `GET /api/venues` no longer sends `createdById`; each row carries a server-computed `canRepair`
  (`venueListFlags()`) for the requester, which is all the "Needs address" badge needed.
- A `here_id` unique-index collision (a race past the clash check) is a 409 `here_id_taken`, not a
  500 — `isUniqueViolation()` checks `code === '23505'` directly or on `.cause`.
- Tests: `npx tsx --test src/lib/venueAddress.test.ts` (node:test, no deps; dummy DATABASE_URL, never dialled).

## Venue time zones (`venues.timezone`, added 2026-09-13)
- Holds an **IANA zone name** ("America/Chicago"), never a UTC offset — an offset is wrong for half
  the year. One venue resolved to `America/Kentucky/Louisville`, which is Eastern but carries its own
  DST history; that's exactly the case a stored offset would get wrong.
- HERE returns it on every search endpoint when you pass **`show=tz`** (`SHOW_TZ` in `hereApi.ts`) —
  verified on geocode, browse, discover and revgeocode. No lookup dependency was needed. Every
  venue-creation path captures it for free from a call it was already making; `resolveTimezone()`
  reverse-geocodes from coordinates alone, for backfill and for repairs that move a venue.
- **It's not only a display concern.** A photo's EXIF wall clock is zone-less, and the frontend used
  to resolve it against the *browser's* zone — correct only if you upload before travelling home.
  It's now resolved against the venue's zone, which removes that assumption. See
  `AddScorePage`'s `localInputToIso(data.playedAt, selectedVenue?.timezone)`.
- `redactVenue` nulls it for `hidden`-tier venues: a timezone is far coarser than an address but
  still narrows where someone lives, and that tier promises nothing locational goes out. Routes
  without requester plumbing (`users.ts`, `machines.ts`) do the same in SQL with a CASE.
- `redactVenue` also nulls **`hereId`, `pinballMapId`, `pmMachineCount`, `pmLocationUrl`** (only
  keys the row already has) for both restricted tiers: a HERE place id or PM listing resolves to an
  exact address. `canSeeVenueLinkage()` gates the roster too — `/venues/:id/machines` and
  `/scores/:id/repair` skip the Pinball Map roster (and former machines) for viewers who couldn't see
  the venue in full, since a roster identifies the listing.
- **Home venues: anyone may log there; nobody finds one by location** (owner's decision,
  2026-09-25). Any signed-in user can file a score under any venue, private ones included. What's
  forbidden is a private venue surfacing because of *where* someone is — every coordinate behind
  those paths is client-supplied, so any proximity reveal is a scanning oracle for homes.
  `mayRevealByLocation()` is the rule (public always; private only for owner/admin):
  - Upload-flow "history" suggestions (`getHistoryVenues` in `upload.ts`) leave other users' private
    venues out — the 150m box is drawn on raw coordinates, so even a redacted entry told a
    neighbour a named private venue was there, and how far.
  - `POST /api/scores` with a `venueHereId` held by someone else's private venue does **not**
    conflict-match onto it (that would rename their home and reveal it); the score gets a new venue
    without the HERE id instead. `venuePinballMapId` backfill never lands on a private venue.
  - **Friends find a private venue by its exact name**: `GET /api/venues/exact?name=` (signed in,
    30/min per user via `createRateLimiter()` in `rateLimit.ts` — in-memory, single instance only)
    returns `[{id, name, isPrivate: true}]` for private venues whose name matches trimmed and
    case-insensitive (`exactVenueNameKey()` — deliberately *not* `normalizeVenueName`, which would
    turn it into a fuzzy search). Nothing locational, no linkage; public venues are left out because
    callers already have them.
- `backfill-venue-timezones.ts` filled all 36 pre-existing venues from coordinates (not city/state —
  34 of them have neither). Dry-run by default, re-runnable, `--force` to refresh existing values.

## Duplicate venues (`src/lib/venueDedup.ts`, added 2026-09-13)
- The unique index on `venues.here_id` only ever protected the **upload** flow. `POST /api/venues`
  never set a `here_id`, and Postgres treats `NULL != NULL`, so null-`here_id` rows could never
  conflict-match each other — a second "headquarters" was created 92m from the real one.
- **Matching on the address string would not have caught it.** The typed address geocoded to a street
  centroid (`W Institute Pl, Chicago, IL 60610`) while the original holds a building address
  (`213 W Institute Pl, ... 60610-0704`). Same place, different strings. Don't reach for
  `UNIQUE(name, address)`.
- The guard is **normalized name AND within 250m**, and both halves are load-bearing: name alone
  would block a chain's branch in another city; proximity alone would block genuine neighbours
  ("The Alley Bar" and "Versus" are 156m apart and unrelated). Returns 409 with candidates rather
  than refusing — the client re-sends with `allowDuplicate: true` after the user confirms.
- **Private matches are never described.** `findDuplicateVenues()` returns raw matches with privacy
  fields; every caller runs them through `partitionDuplicates()` first. Someone else's residence (or
  any restricted tier) becomes `privateNearby: true` on the 409 — no id, name, address or distance
  (a distance from a point the requester chose *is* a location). Its owner and admins still see it
  as a normal candidate. The 409 is sent for a private-only match too, so the UI can say "a private
  venue exists nearby" and offer **Create my venue** (re-sends `allowDuplicate`).
- `normalizeVenueName()` folds case, diacritics, punctuation and a leading "the" only. It must NOT
  strip anything meaningful — "Pinball Palace" and "Pinball Palace North" are different venues.
- `POST /api/venues` also resolves a real HERE place via `findVenueByName()` (accepted only under
  250m, and only if no venue already holds that `here_id`) so new venues carry a `here_id` from
  birth and the unique index finally applies to them too.

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

## Score extraction (`src/lib/anthropic.ts`, `src/lib/scoreRead.ts`, added 2026-09-24)
- The model answers through a **forced tool call** (`record_score_read`, `strict: true`) — no more
  regex-parsing JSON out of prose. `strict` isn't in the pinned SDK's `Tool` type (0.36), hence the
  intersection type; the API accepts it on `claude-sonnet-4-6`.
- A read is a **template**: digits plus `?` for positions that exist but were dark. Old multiplexed
  segment displays get caught mid-refresh by a phone shutter; the prompt tells the model to never
  guess a digit. `upload.ts` returns `score` only when the template has no `?` (older clients) and
  the full read as `scoreRead`. The template's `status` is derived in code, not trusted from the model.
- **A partly lit segment digit is `?`, never a low-confidence guess** — half a 2 reads as a 7, half an 8
  as 0/6/9 (the Black Knight test photo read "72057??" for 7,205,2?? until this rule). `lowConfidence`
  is only for fully lit digits obscured by glare/blur/angle.
- The model also returns a literal `displayText` ("7205,?"), and `templateFromDisplayText()` applies
  the comma rule in code: the group after the last comma always has three positions. The model
  reliably transcribes the comma but then undercounts in its own template ("7205?"). The transcription
  wins **only when it refines the template** (`displayRefinesModel`): agrees wherever both have a digit
  and only adds trailing `?`s. It can carry other display text ("EXTRA BALL", "P1", "BALL 2"), so
  non-score tokens are dropped and letters are never read as unread positions — without both guards
  "P1 1,234,560" became the complete, wrong 11234560. `temperature: 0` — without it the same photo came back as
  7205?, 7205?? and 7205??? across runs.
- **Every route that accepts a score goes through `parseScore()`** (scores POST/PATCH, Pinball Map
  submit): safe positive integers only, as a number or a `^\d+$` string, else 400 `invalid_score`.
- "May be missing digits" plausibility: `checkPlausibility()` flags a read whose *upper bound*
  (x's taken as 9s) is under 1/50 of the machine's median recorded score. Machine stats come from
  `machineScoreStats.ts` (id → case-insensitive name → unique `normalizeMachineName` match), served
  read-only at `GET /api/machines/score-stats`. The frontend mirrors the check in
  `src/lib/scoreTemplate.ts` — keep the two in step.
- **Multi-photo uploads** (`photos`, up to 9 images — 3 wizard items, a video counting as its best
  3 frames; the legacy single `photo` field still works). Videos are never uploaded.
  The two shapes use **separate multer instances** (memoryStorage holds every byte): `?set=1` +
  `photos` at 8MB/file (the browser already downscaled them), legacy `photo` at 20MB (it's also the
  route for an unconvertible HEIC original). Content-Length is checked first — 40MB / 21MB caps,
  411 without one. Per-photo
  GPS/EXIF comes as a JSON `meta` array. Photos are processed **sequentially** and the multi path
  **refuses server-side HEIC decode** with 400 `heic_multi_unsupported` — one ~380MB decode is
  survivable, three in one request is the OOM this route already had once. One model call sees all
  images; `mergeReads()` right-aligns the per-image templates, a position is known if any image read
  it, disagreement becomes `?` plus a `conflicts` entry, and the longest template sets the length.
  GPS = first photo with GPS; playedAt = earliest EXIF time; `differentGamesWarning` when photos are
  >10 min or >200m apart. Photos aren't stored — no schema change; the thumbnail stays single.
- **Every player display is read** (added 2026-09-24). The tool returns, per image, a list of
  `displays` — `{ player, displayKind, digitWindows, displayText, template, lowConfidence,
  possiblyTruncated, truncationReason, leadingPositionAmbiguous }`. The old "read the current or
  highest player" rule was a guess at Game Over (the Stars test photo returned 4UP in one run and 1UP
  in another). The prompt skips ball-in-play/credit/match panels and **mirror-image reflections** in
  the playfield glass; `sanitizeImageDisplays()` also drops blank and all-zero displays ("00"),
  de-duplicates player numbers and sorts numbered players first. Player numbers outside 1–4 → null.
- `mergePlayerReads()` merges **per player**, then `mergeReads()` per group as before. Matching, in
  order: player number → position (only when an image has as many displays as the reference image)
  → template agreement for a lone unnumbered close-up (≥2 agreeing digits, no contradiction, unique
  best — two identical players is ambiguity, not a match). Two different player numbers never merge.
  Position means each display's `position` — its place in the model's own list, kept from *before*
  the player-number sort. Matching on the sorted order broke with partial numbering (photo A labelled
  1–4, photo B with only 3UP legible put B's 1UP into Player 2's group).
  `/api/upload` returns `playerReads` (one `scoreRead`-shaped entry per player, plus `player` and
  `leadingPositionAmbiguous`) and `selectedPlayerIndex`; top-level `score`/`scoreRead` are the
  `defaultPlayerIndex()` entry so older clients keep working: highest by what was read — trailing
  x's add no place value ("8076??" doesn't outrank "88070"), interior x's count as 0.
- **Leading dark window** (`leadingPositionAmbiguous`): the comma rule pins down the *trailing*
  count only. A dark leftmost window on a strobing display is a blank or an unlit digit — the
  template treats it as blank and the flag makes the UI say so. Set in code, not trusted from the
  model: `displayKind === 'segment'` **and** the transcription shows `_` before the first lit digit
  (`displayLeadsWithDark`) **and** (the read has a `?` — evidence of mid-refresh — or the model
  flagged it). Without the evidence clause every short score on a wide display would warn.
- `digitWindows` exists to make the model count physical windows before transcribing; code doesn't
  use it — the count isn't stable (Black Knight 2000's 16-character alphanumeric display came back
  as 7 and 6 on consecutive runs), so it can't place a missing window on its own. At full-photo
  resolution the model reads digits well but places dark windows only roughly — on the Stars photo
  3UP "8807__" read as "_8807_" and 4UP "8807_0" as "88070_" — hence the crop pass below.
- **Crop pass** (`src/lib/displayCrops.ts`, `readDisplayWindows()` in `anthropic.ts`). Pass 1 also
  returns a `bbox` per display, **in pixels of the image as the model sees it** — `modelViewSize()`
  computes that size from the API's downscale limits (1568px long edge / ~1.15MP) off the header
  alone, and `sanitizeBBox` normalizes with it. Fractions came back as round guesses that missed
  displays entirely. Don't re-encode the photo to that size or state the size in the prompt: both
  measurably changed how pass 1 transcribed the displays (Stars 1UP went from "_8076_" to "80760").
  - Runs only when `needsCropPass()`, which counts **segment/plasma displays only**: more than one,
    or one with `?` or a leading-dark flag. DMD/LCD screens never trigger it, multi-player or not
    (verified skipped on four modern-LCD photos). Photos with an EXIF orientation other than 1 get
    no crops — the boxes may refer to the rotated or unrotated image.
  - Each photo is decoded **once** to a raw bitmap and every crop is extracted from that (no
    decode-in-a-loop), photos one at a time, at most `MAX_CROPS` (8) per upload. The decode is
    bounded: `limitInputPixels` 40MP (refused before reading pixels) and resized to 3000px long edge,
    ~27MB raw at most — measured on a 6000x6000 JPEG, peak RSS +90MB vs +133MB for the old full
    decode. Boxes are fractions, so they apply to the smaller bitmap unchanged. Crops are padded
    generously — a third of the box width sideways, a full box height vertically, because boxes are
    routinely that far off — and scaled to 1000px wide. One call per photo, photos in parallel.
  - The crop prompt asks for one entry per **physical** window (`digit`/`dark`/`partly_lit`/`,`).
    `reconcileWindowRead()` distrusts it — keeping pass 1 — when it counts >10 windows, differs from
    pass 1's `digitWindows` by >1, disagrees with its own `windowCount`, has no digit, or knows 2+
    fewer digits than pass 1 (the crop missed). It never touches a complete non-segment read.
    **Governing rule: a crop may never shorten the template, or take away a pass-1 digit without an
    x in its place.** A crop read shorter than pass 1 never replaces it — pass 1 stands, flagged,
    unconfirmed digits unsure (that's the leading-vs-trailing dark ambiguity: "8807??" vs a crop's
    "__8807"). Relocating dark windows at equal length and lengthening are allowed.
    Otherwise it compares the two reads' known digits as sequences:
    same sequence → the crop only moved a dark window, its positions win (flagged only if that
    lengthened it — the added positions are all x's); one digit added → kept as `lowConfidence`
    only where pass 1 had an x in that spot, otherwise it becomes an x with the crop's digit as the
    sole `conflicts` candidate — it would lengthen the score and shift every higher digit up a place
    ("202" → "2052" is 10x), so Save stays blocked until the user confirms it; one dropped →
    crop positions only if the crop has an x exactly where it was, else pass 1 flagged with that
    digit unsure; anything else → if most shared (right-aligned) positions disagree it's a
    different display or a hallucination and **pass 1 stands** ("8807?" vs a crop's "880700",
    "123450" vs a neighbour's "987600"); else each contested position becomes `?` with a
    `conflicts` entry offering both digits (mergeReads carries these into the existing picker).
    **A crop never silently replaces a digit pass 1 read.** The wizard opens any flagged read in
    digit-cell mode, even when complete, and shows "Digits were hard to line up".
  - Any failure (bad box, sharp error, API error, timeout) keeps pass 1 for that photo; it never
    fails the upload. Request limits (`readRequestOptions`): pass 1 gets 30s + 12s per image, capped
    at 150s, with one retry only for ≤3 images; the crop pass 20s with none (both were on the SDK
    default of 10 minutes × 2 retries). The browser calls Render directly (`VITE_API_URL`) — no
    Vercel proxy hop — and Node's requestTimeout/headersTimeout bound only receiving the request.
    Pass 1's `max_tokens` is `readMaxTokens(images)` = min(16000, 1024 + 800/image) — a 4-player
    photo is 510–614 output tokens — and a `stop_reason` of `max_tokens` throws
    `ScoreReadTruncatedError` rather than parsing a cut-off tool call; `/api/upload` then answers
    normally with no reads and a `readNotice` (GPS, venues and thumbnail kept), never a 500. Cost on the test photos: ~2s / ~1.7k input tokens for one display, ~3.5s / ~3.8k input
    tokens for four (Sonnet 4.6: about $0.006 and $0.014).
  - Known limit: a display whose window dividers aren't visible (unlit windows are just dark glass)
    gets counted by its lit digits — Stars 1UP "8076" as 4 windows — and is rejected by the ±1
    check, so pass 1's placement stands there.
