# CLAUDE.md — api-server (backend)

## HERE API
- Use the **browse** endpoint (`browse.search.hereapi.com/v1/browse`) with `categories=100,200,300,500,600,700` and `at=lat,lng`. Do NOT use the `discover` endpoint *without* an `at` anchor — unbounded it searches globally. `findVenueByName()` does use discover, but always pinned to the venue's own coordinates and filtered to <2km.
- Key is in `artifacts/api-server/.env` as `HERE_API_KEY`.
- **Never trust HERE's result ordering inside a dense building.** Browse ranks by distance with an arbitrary tiebreak, so at an address where every tenant shares one geocode (213 W Institute Pl, Chicago — Headquarters Beercade) the venue you want can land at rank 13 behind a dozen law offices, all reporting the same 18m. `getNearbyVenues()` therefore over-fetches `limit=100` (HERE's per-page max — still one request) and re-ranks by category plausibility before slicing to the caller's limit. Raising the limit alone is not enough; the re-rank is what fixes it.
- Pinball-relevant category ids, verified empirically: **`200-2000-0017` Video Arcade-Game Room** (the strongest signal — carried by both Logan Arcade and Headquarters Beercade) and `200-2000-0011` Bar or Pub. Both sit under the already-included `200` prefix, so the category filter was never the bug.

## Pinball Map API
- **Every endpoint requires an `api_token` query param** as of 2026-07-30 — including read-only GETs. It goes on the **query string, not a header** (per `pinballmap.com/llms.txt`; the 2017 blog post describing `user_email`/`user_token` is the separate *user* auth for writes). Stored as `PINBALL_MAP_API_TOKEN` in `.env`; request one at <https://pinballmap.com/api_token>, approval is manual.
  - Without it every call returns `401 {"error":"A valid api_token is required..."}`. This went unnoticed for weeks because every call site swallowed failures (`if (!res.ok) return []` / `.catch(() => [])`), so the app looked like it was working while silently producing empty venue and machine lists — and `upsertMachineByName()` quietly inserted unenriched AI-extracted names, creating duplicate machine rows ("Transformers" vs "The Transformers"). **Don't add new silent `catch → []` around PM calls.** Every call goes through `pmClient` (via the helpers in `pinballmapApi.ts`), which throws a typed `PmApiError`; let it propagate and surface the reason.
- `max_distance` is **integer miles** — decimal values get truncated to 0. Use `Math.ceil`.
- `/locations/:id.json` (the default, full response) already embeds each machine's `name`, `manufacturer` and `year` on every `location_machine_xrefs[]` entry, alongside the xref `id`. `getPmMachinesAtLocation()` reads that in **one** call; it only falls back to `/locations/:id/machine_details.json` if names are ever missing. PM's own guidance singles out per-record fan-out as what gets apps blocked.
- Use `no_details=1` on bulk reads (`machines.json`, `closest_by_lat_lon`, `locations.json`) to cut response size.
- Single machine lookup (`/machines/:id.json`) returns 404 — use the full cached list with in-memory search.
- `GET /locations/autocomplete.json?name=` returns a bare array, and only matches from the **start** of the name — `searchPmLocationsByName()` falls back to `locations.json?by_location_name=` when it comes up empty. **As of 2026-09-24 each entry is `{label, value, id}` with `value` = the location *name*** ("Special When Lit") and `id` = the numeric id. The code used to read `value` as the id, which turned every autocomplete hit into a discarded non-numeric id — the repair panel's Pinball Map name search silently returned nothing for any name autocomplete matched. `pmAutocompleteId()` now prefers `id`.
- `locations.json?by_location_name=` returns **full records** (street, city, state, zip, `country`, lat/lon) in one call; autocomplete returns only a label. PM `lat`/`lon` arrive as **decimal strings** — `Number()` them before storing. PM is international (the other "Special When Lit" is in Salisbury, UK, `state: null`).
- **Attribution is a licence condition**, not a nicety: data shown for a specific location must link to `https://pinballmap.com/map?by_location_id=<id>` (see `pmLocationUrl()`), not just the homepage. That URL is also how a user finds a location's numeric id in PM's own UI.
- **Rate limits / caching**: PM explicitly warns against request volume that scales with your traffic rather than with how often the data changes. **All roster reads go through `getVenueRoster()` in `pmRosterCache.ts`** — never call `getPmMachinesAtLocation()` directly from a route. It's backed by the `pm_location_cache` table, keyed by *their* location id (so the venue page, `/pm-machines/:pmId` and score cross-posting share one entry), with a 6-hour TTL. Verified: 10 venue-page views produce 0 outbound requests. Pass `{ force: true }` only for deliberate user actions where freshness is the point (linking a venue, previewing a re-sync). On a PM failure with a cached row it returns the **stale** roster with `stale: true` rather than an empty list — a venue page should never imply a venue is empty because their API was down.
- `syncVenueMachineHistory()` now only runs when the roster was actually re-fetched (`!roster.fromCache`). A cache hit carries no new information, and re-diffing on every page view churned `lastSeenAt` and re-upserted every machine row for nothing.

## Pinball Map API — standing rule (see root CLAUDE.md)

Pinball Map's maintainers granted Will an API token personally. **TiltTrack must never hammer their
API.** This is a standing rule, not a guideline:

- **Every PM request goes through `pmClient`** (`artifacts/api-server/src/lib/pmClient.ts`) — no raw
  `fetch` to pinballmap.com anywhere, and never from the browser. It holds the token, a global
  limiter (1 req/s, burst 5, concurrency 2), in-flight de-duplication, a 10 s timeout, a circuit
  breaker honoring `Retry-After` (429 → default 15 min; 5xx/network/timeout → 2 min; rejected
  api_token → 15 min; while open it fails fast, nothing retries per request), and an identifying
  User-Agent. Every live call logs one line: `[PM live] <request key> <status> <ms> (n today)` — the
  key is `logKey()`: method, path and sorted params (`GET /locations/10804.json?metadata_only=1` vs
  the roster's bare `GET /locations/10804.json`), credentials dropped, `lat`/`lon` masked as `~`;
  `sensitive` requests log method + path only.
- **Every new call site needs a DB-backed cache with an explicit TTL** (rosters: `pm_location_cache`,
  6 h; catalog: `pm_catalog_cache`, 24 h). Page views and unauthenticated routes only read cache or
  trigger a refresh that is bounded per *key* (one per linked venue per TTL, one catalog fetch a
  day, de-duplicated in flight) — never per request. Failures are negatively cached, never retried
  per request.
- **No per-record fan-out:** never call PM inside a loop; fetch once and pass the data in (e.g.
  `syncVenueMachineHistory(venueId, xrefs, catalog)`, `upsertMachineByName(name, { catalog })`).
- **Every PM-touching route requires sign-in and a per-user rate limit** (`pmGuards.ts`); PM ids
  come from our DB or from a result we just returned to that user (30-min allowlist), never
  arbitrary input.
- **`force: true` only for deliberate user actions**, and it only refetches if the cached copy is
  more than 5 minutes old (`FORCE_MIN_AGE_MS`).
- **Before adding a PM feature, estimate worst-case calls/day** and write it in the PR/commit.
- **Development & testing:** outside production `PM_MODE` defaults to `offline` — requests are
  answered from recorded fixtures in `artifacts/api-server/fixtures/pm/` and anything unrecorded
  fails loudly. Use `live` only for a deliberate task and `record` to refresh fixtures
  (`PM_MODE=record npx tsx record-pm-fixtures.ts --catalog --roster <pmId> --near <lat,lng>`).
  Non-prod live calls go through an on-disk cache (`artifacts/api-server/.pm-cache/`, 7-day TTL,
  gitignored) and a hard budget — 50 live calls/day per machine, 20 per process (`PM_DEV_BUDGET=<n>`
  overrides both); past it pmClient logs `PM DEV BUDGET EXHAUSTED` and refuses. Test scripts never
  hit PM live unless `PM_LIVE_TESTS=1`; migrations and seed scripts never call PM.
- **Production needs no PM variables beyond `PINBALL_MAP_API_TOKEN`.** Production is detected as
  `NODE_ENV=production` **or** `RENDER=true` (Render sets `RENDER` on every service; neither
  render.yaml nor the start script sets `NODE_ENV`) and is always `live`, with no fixtures, disk
  cache or budget.

Implementation notes (fix/pm-etiquette, 2026-09-26):
- `GET /api/venues/pm-machines/:pmId` was an open proxy (unauthenticated, any integer). It now needs
  `requireAppUser`, 30/min + 300/day per user, and an id that's linked to one of our venues or was
  returned to this Clerk user by pm-match / nearby-venues / the photo-GPS suggestions / repair
  searches in the last 30 min (`allowPmIds` / `pmIdAllowedFor`). Otherwise 404 `pm_id_not_offered`.
- `getVenueRoster()` de-duplicates in flight per PM id, negatively caches a 404 for 1 h and other
  failures (with no cached copy) for 10 min, and never writes a row for an id that didn't resolve —
  `getPmMachinesAtLocation()` throws `not_found` for a missing location instead of returning `[]`.
  `allowLive` lets a caller refuse the live half (the score-repair GET charges it to the repair limit).
- The machine catalog lives in `pm_catalog_cache` (migrate16): 24 h TTL, in-flight de-dup, stale
  served on failure, a failed refresh negatively cached 15 min (in memory and in the row, so other
  processes see it). `GET /api/machines/search` answers 503 `catalog_unavailable` rather than
  refetching per keystroke.
- One per-cell cache for "PM locations near a point" (`pmLocationsNear`, 10 min, failures 2 min) is
  shared by pm-match, nearby-venues, the photo-GPS upload path (which used to be uncached) and
  `repair/pm-candidates`.
- Repair routes: 20 PM-touching calls/hour per user (`repairPmLimiter`); `place-search` and
  `pm-candidates` results cached 10 min per (venue, query), and only a cache miss is charged.
- `POST /api/pinballmap/auth`: 5 attempts / 15 min per user and per IP (the last X-Forwarded-For
  hop — the app doesn't set `trust proxy`). Returns only `{ username }`; the PM user token and email
  stay server-side (`POST /api/users/setup` strips them too). `submit-score`: 10/min per user.
- Admin health reads the stored catalog and pmClient's counters — it never calls Pinball Map.
- Tests: `DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/pmClient.test.ts src/lib/pmCaches.test.ts src/lib/pmAccount.test.ts`.

Location metadata with the roster (fix/pm-link-dedup, 2026-09-26):
- `/locations/:id.json` is the **only** PM URL for one location. `pm_location_cache.location` (jsonb,
  migrate20) stores that response's location fields (id, name, lat, lon, street, city, state, zip,
  country) beside the roster; `RosterResult.location` exposes it. There is no `?metadata_only=1`
  lookup any more — `getPmLocationCached()` (pmRosterCache.ts) reads the stored location (≤ 7 days)
  or refreshes the roster, and `searchPmLocationsWithAddress()` takes it as its (still capped at 3)
  autocomplete-fallback lookup.
- Repair link flow: place-search / pm-candidates keep the full records they returned per user for 30
  min (`rememberOfferedPmLocations` / `offeredPmLocation`, pmGuards.ts); `POST /repair/place
  {source:'pm'}` uses that record, then the cached location, and only then goes live (charged to
  `repairPmLimiter` only then). `pm-link` makes just `getVenueRoster(force)` — it verifies the id
  (`not_found` → 404) and carries the name. Linking = at most 1 roster call (0 if one was fetched in
  the last 5 min); an Add Score there within 6 h = 0. Before: 3 `/locations/:id.json` calls.
- Tests: `npx tsx --test src/lib/pmRosterCache.test.ts` (in-memory store, counting fake fetch).

## Pinball Map account connect + score posting (fix/pm-posting, 2026-09-26)
Verified against **Pinball Map's source**, `github.com/pinballmap/pbm @ 1b527c0` — not their docs,
which were how this broke. Before this fix connect had **never worked** (every correct login said
"Invalid Pinball Map credentials") and every score post **silently did nothing** while the UI said
it had posted. **Almost every PM failure is an HTTP 200** — never treat a 2xx as success.
- **Connect** — `GET /users/auth_details.json?login=&password=` (`users_controller.rb#auth_details`).
  `login` = username OR email, case-insensitive. Success is **nested**:
  `200 {"user":{"username","email","authentication_token"}}`. Failures are `200 {"errors":"…"}`:
  "Unknown user" / "Incorrect password" → our 401 "Invalid Pinball Map credentials"; "User is not
  yet confirmed…" → 400 (tell them to confirm their PM email); "login and password are required
  fields" → 400. Disabled account = PM `403 {"error":"account_disabled"}` → our 403. PM caps this
  at **10/min per api_token owner — shared by all TiltTrack users** → 429 → our 503 "Pinball Map is
  busy" + Retry-After. A 401 mentioning `api_token` is **our** token → 503 "connection problem on
  our side" + a loud `!!! PINBALL MAP REJECTED OUR api_token` log line. On success we store token +
  username + the **email PM returned** (`users.pinball_map_email`, migrate18).
- **Post** — `POST /machine_score_xrefs.json` (`machine_score_xrefs_controller.rb#create`). User auth
  is `authenticate_from_token` (`application_controller.rb`): **both** `user_email` and `user_token`
  (params, query or JSON body, or `X-User-Email`/`X-User-Token` headers), looked up with
  `User.find_by(email:)` — **exact case**, hence storing PM's email rather than what the user typed.
  Without a valid pair: `200 {"errors":"Authentication is required for this action…"}` (no 401).
  `score` must be a **string** (the controller `gsub!`s it; a JSON number is a 500). Success is
  **only** `201 {"machine_score_xref":{…,"username"}}`. Other failures `200 {"errors": "…" | [...]}`
  (e.g. "Failed to find machine"). 80 / 2 min per api_token owner.
- We send `user_email` + `user_token` + `location_machine_xref_id` + `score: String(score)` in the
  **JSON body** (pmClient already JSON-encodes POST bodies and keeps only our api_token on the query
  string, so no user credential lands in a URL / access log). Auth-required → clear stored token +
  email, 401 `pm_reconnect_required`; other `errors` → 422 with PM's message; 403 account_disabled →
  403; 429/5xx/timeout/breaker/our api_token → 503/502 and the credential is **never** cleared. A
  stored token with no email (pre-migrate18) can't authenticate a write: `GET /token` reports
  `hasToken: false` and submit returns `pm_reconnect_required`. A roster match with no xref id (0)
  answers 422 without calling PM.
- The PM calls are `getPmUserToken` / `submitPmScore` in `pinballmapApi.ts` (both `sensitive`: never
  cached, recorded or de-duplicated, so `PM_MODE=offline` refuses them — test with the mocked
  client in `pmAccount.test.ts`). The HTTP reply for each outcome is the pure `pmAccount.ts`.

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
  `/venues/:id/machines`), so either would publish the location the tier hides. Since 2026-09-25
  this covers **every private venue** (`isPrivateVenue`: residence *or* restricted tier) — the same
  definition PATCH uses to clear links; a full-tier residence used to be allowed and then lost the
  link on its next save. Status payloads carry `linkageBlocked` so the UI explains instead of 409ing.
- **Going private clears the links** (`linkageClearedForPrivacy()`, owner decision 2026-09-25): a
  `PATCH /api/venues/:id` that leaves the venue private (restricted tier, or `isResidence`) nulls
  `hereId`, `pinballMapId` and `pmMachineCount` in the same UPDATE. Not restored on switching back;
  the Edit Venue dialog warns first. `venue_machine_history` rows are left in place (only served
  to viewers who pass `canSeeVenueLinkage`).
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

## Home-venue inventory + "Show my machines/scores publicly" (`venueActivity.ts`, `venueInventory.ts`, `venueView.ts`, migrate12, added 2026-09-25)
- **Two separate axes.** Location (address/coords/tz/linkage) is still the privacy tier's job
  (`venuePrivacy.ts`). "Activity" — a venue's machine inventory and the scores logged there — is
  `venues.show_machines_and_scores` (default true). The switch only takes effect on a **private**
  venue (`isPrivateTier`): a public venue's `ownerId` is often just whoever typed it in, and must not
  be able to hide everyone's scores at a bar. The stored value is ignored on public venues.
- Switch off → only the owner and admins see the inventory and the scores there; **each score's
  author always sees their own** (with venue name) in their feed, profile, stats and on the venue
  page. Everyone else doesn't get those scores *at all* — not venue-anonymised, since "a score at a
  private venue" on a machine page would still say what the owner has at home.
- **`visibleScoreSql(viewer)` is the SQL twin of `canSeeScore`** and must be on every query that
  lists scores to someone: `/api/scores`, `/api/venues` (in the scores JOIN, so counts are per
  viewer), `/api/venues/:id/scores` + `/machines`, `/api/machines` (JOIN + top scorers),
  `/api/machines/:name`, `/api/users/:username`, `/api/stats?mine=false`. Keep the two in step —
  `venueActivity.test.ts` pins the JS rule and checks each SQL branch renders. Left alone on purpose:
  `machineScoreStats` (a count + median for the "missing digits" check — no venue or player in it)
  and the daily `captureStatSnapshot` counts.
- **Inventory** (`venue_inventory`, one row per venue+machine, `removed_at` null = there now) is the
  roster for private venues, which can't use Pinball Map. Owner or admin only
  (`canManageInventory`), via `POST /api/venues/:id/inventory {name | machineId}` and `DELETE
  .../inventory/:machineId`; 409 `venue_public` on a public venue. `resolveCatalogMachine()` only
  accepts an existing `machines` row or a Pinball Map catalog name, so it can't mint junk machines.
  Deliberately **not** `venue_machine_history`: that table is PM-derived, re-diffed against the PM
  roster (which would mark owner-added machines removed), and served only past
  `canSeeVenueLinkage` — a venue that went private would otherwise publish its old PM roster.
  Machine deletes / `retireMachineIfUnused` and venue deletes account for inventory rows.
- **Machine count** (`displayedMachineCount`): public venues = distinct machines scored there (the
  X of X/Y). A private venue whose owner has ever used the inventory = current inventory size, and
  `pmMachineCount` is sent as null so the UI shows "N Machines", not X/Y. Scored-but-unlisted
  machines don't count (like a machine gone from PM's roster); a home venue never inventoried keeps
  the played count rather than suddenly reading 0.
- **Wire shapes** (`venueView.ts`): `GET /api/venues` rows no longer carry `ownerId`/`createdById`;
  every row has server-computed `canEdit`, `isPrivate`, `activityHidden`, `ownerInventory`,
  `machineCount` (null when hidden). Someone else's private venue is trimmed to
  `{id, name, address (tier-redacted), isResidence, scoreCount, machineCount, flags}` — no tier,
  coordinates, timezone, lastPlayedAt or linkage. `/api/venues/:id/scores`'s venue gets the same
  treatment (plus tier-redacted lat/lng/timezone for the map thumbnail) and now includes `timezone`,
  which the venue page was already reading.
- `/api/venues/:id/machines` also withholds the Pinball Map roster / former machines /
  `pmLocationUrl` when the switch excludes the viewer, and sends others' private venues a trimmed
  venue object (`venueMachinesView`). Adding to an inventory answers **503 `catalog_unavailable`**
  when Pinball Map's catalog can't be read — never a misleading "not in the catalog" 400.
- Tests: `npx tsx --test src/lib/venueActivity.test.ts src/lib/venueActivity.sql.test.ts` — the
  second runs `visibleScoreSql` in an in-process PGlite and checks it matches `canSeeScore` row for
  row, for each kind of viewer.

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
- **Someone else's private venue never matches by location** (`matchDuplicates()`, owner decision
  2026-09-25). Not within 250m and not via the geocode-failure fallback: the coordinates come from an
  address the requester typed, so a proximity match would let anyone probe where people live. It
  matches only when the new name equals its name **exactly** (trimmed, case-insensitive — same rule
  as `GET /api/venues/exact`), anywhere, and comes back as `{id, name, address: null, distance: null,
  isPrivate: true}` — "A private venue named X exists — log here, or create your own". Owner and
  admins keep the full candidates for their own private venues. Public venues unchanged.
- `normalizeVenueName()` folds case, diacritics, punctuation and a leading "the" only. It must NOT
  strip anything meaningful — "Pinball Palace" and "Pinball Palace North" are different venues.
- `POST /api/venues` also resolves a real HERE place via `findVenueByName()` so new venues carry a
  `here_id` from birth and the unique index finally applies to them too. `adoptableHereMatch()`
  decides: **never for a private venue** (residence or restricted tier — it used to adopt the
  nearest shop's id, breaking "private venues carry no linkage" and leaking a bit to anyone creating
  a venue near that shop); for public ones the closest result must be under 250m **and** its name
  must overlap (`hereNamesOverlap`, the pickConfidentHereMatch rule), and no venue may already hold it.

## Merging a duplicate venue (`src/lib/venueMerge.ts`, `/repair/merge-preview` + `/repair/merge`, added 2026-09-25)
- For a hand-typed venue that turns out to be one TiltTrack already has (prod "Deep Cuts -- Pop's II"
  vs "Pop's Pinball - Deep Cuts"): the repair panel's HERE / Pinball Map candidate says "already used
  by …" and offers **Merge into …** instead of a dead Use button.
- `GET /:id/repair/merge-preview?into=<id>` → counts, `players` (admins only), `adopts`, `canMerge`,
  `blocker`/`blockerMessage`. `POST /:id/repair/merge {intoVenueId, expectedScoreCount}` → one
  transaction; both rows locked `FOR UPDATE` in id order and every rule re-checked; a changed score
  count is 409 `merge_stale`, a refusal 409 (403 for `target_not_visible`) with `code` = the blocker.
- **Everything that references `venues.id`** (FK catalogue checked 2026-09-25): `scores.venue_id`
  (plus the `venue_name` snapshot, renamed to the target's), `venue_machine_history`,
  `venue_inventory`. A new FK to venues must be added to `applyVenueMerge` too, or merges will fail
  on the final DELETE (or worse, if it's ON DELETE CASCADE, silently drop rows).
- Per machine: history at both → one row, earliest first-seen / latest last-seen, **target's
  `removedAt` stands**; source-only rows move, and a still-current one is closed at its `lastSeenAt`
  when the target has a different PM listing. Inventory at both → the current stint wins (both
  current: earlier start; both ended: later end). The target fills only its **gaps** from the source
  (HERE id, PM link, address block, timezone) — never on a private venue.
- Permission = `canRepairVenue` on the **source**. `mergeBlocker()`: target must be public or the
  caller's own; public→public ok; public→private and private→public refused for everyone (the owner
  makes a home public in Edit Venue first); private→private only same owner, by that owner or an
  admin; **a non-admin can only move their own scores** (`others_scores` otherwise — creators are
  ordinary users and could otherwise relocate other players' scores).
- Tests: `npx tsx --test src/lib/venueMerge.test.ts` (pure rules) and `npx tsx test-venue-merge.ts`
  (dev branch only — aborts unless the host is `ep-late-mouse-at8antth`; cleans up after itself).

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

## "Use my current location" (`POST /api/upload/nearby-venues`, `src/lib/nearbyLookup.ts`, added 2026-09-25)
- Venue suggestions for the device's position when no photo had GPS; same `suggestVenuesNear()` as
  the photo path. POST with a JSON body so the point stays out of URL/access logs; the client rounds
  to 4 decimals. The route stores and logs nothing of it (it does go to HERE / Pinball Map as `at`).
- **The app has no general rate limiter** — this route has its own: per Clerk user, 10/min and
  100/day (`SlidingRateLimiter`), 429 `rate_limited` + `Retry-After`. HERE + PM results are cached
  per 3-decimal cell for 10 min (`cachedByCell`, in-flight promises shared), so repeat taps don't
  re-hit Pinball Map; a PM failure or empty HERE answer isn't cached. History venues are always read
  fresh (they're redacted per requester). In-memory, per process — a restart forgets both.
- Tests: `npx tsx --test src/lib/nearbyLookup.test.ts`.

## Venue search (`GET /api/venues/search`, `src/lib/venueSearch.ts`, added 2026-09-25)
- The Add Score wizard's one search box. `?q=` (≥2 letters/digits) plus optional `lat`/`lng`
  (client's photo GPS or device position, rounded to 3 decimals; never stored or logged). Returns
  `{ tiltTrack, places, anchor }`. Signed in (`requireAppUser`), 60/min + 1500/day per user
  (`SlidingRateLimiter`), 429 `rate_limited`.
- **tiltTrack**: every venue row is read and matched in JS (`matchScore`: every query word must
  start a word of the name — or of the address, with at least one in the name; apostrophes are
  removed, so "pop"/"pops"/"Pop's" all hit "Pop's Pinball - Deep Cuts"). Ranked by match quality,
  then distance from `lat`/`lng`. Fine at today's size (dozens of rows); move matching into SQL
  (`pg_trgm` or a tokens column) if the table reaches thousands. **Only venues the requester may
  see by location** (`searchableBy` = public, or own/admin private): results carry address,
  coordinates and a distance from a client-supplied point. Others' home venues stay reachable only
  through `/venues/exact`.
- **places**: HERE **Autosuggest** (`autosuggestPlaces`, `place` results only, arcades/bars moved
  ahead, `show=tz`), from 3 characters. Autosuggest beat Discover for partial input — Discover
  returned one result for "pop". Bias: client location → the requester's most recent *public* venue
  → Boston; distances only when the client sent a location. Places >150km from the bias are
  dropped unless a query word names their town/street (`placeIsRelevant`) — so "pops medford"
  works from anywhere. Cached per (normalized query, 3-decimal bias) for 10 min; empty answers
  aren't cached.
- **Dedupe**: a place holding a visible venue's `hereId`, or within 150m with an overlapping name
  (`venueForPlace`), is returned once, as that venue. The second rule is load-bearing: venue 19 is
  linked to HERE's "Deep Cuts" listing while HERE also lists "Pop's Pinball" at 21 Main St under
  another id. A place near someone else's private venue stays a plain place (nothing revealed).
- Cost: one HERE Autosuggest request per debounced (350ms) search of ≥3 chars that misses the cache.
- Tests: `npx tsx --test src/lib/venueSearch.test.ts`.

## Pinball Map match on pick (`GET /api/venues/pm-match`, `src/lib/pmMatch.ts`, added 2026-09-25)
- A HERE "Places" pick in the Add Score venue step used to carry no Pinball Map id, so the machine
  step fell back to catalog search even at a PM-listed bar (Wedgehead, Portland). Search results
  still carry none — resolving per result per keystroke would be a PM call each. Instead the client
  calls `pm-match` **once per pick**: `?lat=&lng=&name=` for a place (its own coordinates), or
  `?venueId=` for a TiltTrack venue with no link (server uses the venue's coordinates; answers the
  stored link without calling PM if it has one; a private venue gets `null`, same as no match).
  Signed in, 30/min + 500/day per user; PM's nearby list cached per ~110m cell for 10 min.
- **`matchPmLocation()` is the one matching rule** — `suggestVenuesNear()`'s `attachPinballMapIds`
  uses it too. Closest PM location within 150m whose name overlaps (`pmNamesOverlap`: containment,
  or a shared distinctive word — "pinball"/"bar"/"arcade" etc. don't count); failing that, the
  closest within **40m** whatever its name (same building — HERE "Deep Cuts" vs PM "Pop's Pinball").
  The old rule took the nearest within 150m regardless of name, so the coffee shop next door
  inherited the bar's listing.
- **Persisting on save** (`resolveScoreVenue()` in `src/lib/scoreVenue.ts`, split out of
  `POST /api/scores`): `pmIdToPersist()` — a new venue takes the client's id; an existing venue only
  if it has **no** link and isn't private. The `here_id` upsert is `COALESCE(venues.pinball_map_id,
  excluded.…)` (it used to be the other way round, and the by-id backfill overwrote unconditionally).
  The id is still client-supplied, as on the nearby path — the repair panel is how a wrong one is fixed.
- Tests: `npx tsx --test src/lib/pmMatch.test.ts`; live + dev-DB check: `npx tsx test-score-venue-pm.ts`
  (aborts unless DATABASE_URL is the dev branch; throwaway `zz-pm-test` venues, cleaned up).

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

## Challenges (`challengeRules.ts`, `challenges.ts`, `routes/challenges.ts`, migrate15, added 2026-09-26)
- **Rules are pure** (`challengeRules.ts`, unit-tested); `challenges.ts` loads rows and applies them.
  Tables: `challenges`, `challenge_participants` (creator included, accepted at creation; groups
  later = more rows), `challenge_scores` (the lock). Friends only, checked at creation.
- **Every state change goes through `syncChallenge(id)`** (row-locked `FOR UPDATE`): expiry, writing
  the lock rows, and resolution (race won / forfeit / deadline). Three triggers call it: lazy reads
  (list, detail, record), `onScoreCreated()` in `POST /api/scores`, and the daily
  `POST /api/cron/challenge-sweep` (`.github/workflows/challenge-sweep.yml`, same `CRON_SECRET`).
- **What counts**: matching machine (`match_group` = OPDB group captured at creation for 'game'
  mode, else exact id), venue if locked, a photo, `played_at` AND `created_at` inside
  [starts_at, ends_at], and visible to every other participant (`canSeeScore`) — a score at a home
  venue with activity hidden doesn't count. **"Has a photo" = `photo_url` OR `photo_thumbnail`**:
  the client only ever sends the data-URL thumbnail; `photo_url` is never written.
- **A venue lock must have the machine** (`venueMachineSource`, 400 `machine_not_at_venue`). Sources,
  any one is enough: the venue's Pinball Map roster via `pmRosterCache` (PM-linked venues; a PM
  failure falls through rather than blocking), then `venue_machine_history` rows not removed, then
  a score on the machine there. Match mode applies: 'game' = any model in the OPDB group; roster
  entries match TiltTrack machines by name, plus PM's catalog `opdb_id` in game mode
  (`rosterHasMachine`, pure). The create form's picker uses `GET /api/challenges/venue-options`
  (same sources, but makes **zero** Pinball Map calls: cached rosters at any age and the stored
  catalog via `getStoredCatalog()` — without a stored catalog, exact-name matching only). At create
  time the roster read is the normal `getVenueRoster` path with `allowLive` charged to
  `challengePmLimiter` (20 live checks/hour/user; refused → TiltTrack data), and the catalog comes
  from `getCatalogOrNull()` (24 h DB cache). Worst case: one roster fetch per locked PM venue per 6 h.
- **The lock**: the counting scores are recorded in `challenge_scores` every time a challenge is
  synced (so the moment one is uploaded). PATCH / DELETE / per-score machine repair answer 409
  `score_locked_by_challenge`, admins included; the FK has no ON DELETE, so the DB refuses too.
  Machine retirement, admin machine/venue deletes and venue merges account for challenges.
- **Race = strictly beat the target** (`> target`; equalling it is not a finish). **Nobody finishing**
  (race: nobody beat the target; average: nobody reached `min_plays`) **or nobody playing at all
  (any type)** = **abandoned**: every non-forfeited participant's `outcome` is `'abandoned'`,
  played or not, and ChallengeView has `abandoned: true` (derived from the participant rows, no
  column). **Void is retired** (2026-09-26, Will: "you signed up and were supposed to play"): no
  new challenge resolves void; the `void` column, the ChallengeView/notification field and the
  record's `voids` count stay for compatibility but are always false / 0 (only a legacy row could
  differ; the UI's void handling is left in place for that). The record (and each head-to-head
  row) counts `abandoned` on its own, not as W/L/T/no-show; abandoned **breaks** a win streak. `challenge_result` notifications carry `abandoned` too.
  The outcome CHECK is named `challenge_participants_outcome_check`; migrate15 drops and re-adds it.
- `starts_at` null = starts at acceptance, stamped with the **DB clock** (same clock as
  `scores.created_at`). `most_improved` baselines are frozen at acceptance.
- The sweep also sends `challenge_ending_soon` once per participant (`ending_soon_notified_at`) and
  deletes **read** notifications older than 30 days; unread ones are kept.
- Tests: `npx tsx --test src/lib/challengeRules.test.ts`; `npx tsx test-challenges.ts` (dev branch
  only; borrows 3 friendless users and throwaway `zz-challenge-test` machines, cleans up).

## Full-size score photos (`src/lib/photoStore.ts`, `routes/scorePhotos.ts`, migrate17, added 2026-09-26)
- **Storage:** Cloudflare R2, private buckets — `tilttrack-photos-dev` (local/dev) and `tilttrack-photos`
  (prod). Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. **Optional:** with
  any missing, startup logs one `[photos] Full-size photos disabled` warning, the photo routes answer 503
  `photos_disabled`, and uploads/thumbnails work exactly as before. Never log the values.
- **Client:** `@aws-sdk/client-s3` with `forcePathStyle` and `requestChecksumCalculation` /
  `responseChecksumValidation: 'WHEN_REQUIRED'` — SDK >= 3.729 otherwise adds CRC32 checksum params to
  presigned PUTs that a browser can't satisfy and R2 rejects. The PUT signs `content-type`, so R2 itself
  refuses anything not sent as exactly `image/jpeg`.
- **Schema:** `scores.photo_key` (+ `photo_bytes`, `photo_width`, `photo_height`). A separate column, not
  `photo_url`: dev seed scripts put a marker in `photo_url`, and challenge rules treat
  `photo_url OR photo_thumbnail` as "has a photo" — a full-size photo is display-only and never part of
  that rule. Keys are `scores/{scoreId}/{uuid}.jpg`; the score id in the key is how confirm proves a key
  belongs to the score (`keyBelongsToScore`) and how the orphan sweep maps objects back to rows.
- **Keys never leave the server.** Lists (`/api/scores`, `/users/:u`, `/machines/:name`,
  `/venues/:id/scores`, challenge counting scores) expose `hasFullPhoto` only (`hasFullPhotoSql`); POST
  and PATCH `/api/scores` pass their full rows through `publicScoreRow()`. Any new route returning a full
  score row must do the same.
- **Upload** (after the score saves — AddScorePage, see frontend CLAUDE.md): `POST /api/scores/:id/photo/upload-url`
  (owner only, 30/10 min) → presigned PUT, 5 min → browser PUTs to R2 → `POST .../photo/confirm {key,width,height}`
  (owner only, 30/10 min): `HeadObject` must exist, be ≤ 12MB and `image/jpeg`; a failing object is
  deleted. Confirm replaces any previous key (row-locked) and deletes the old object. Width/height are the
  browser's word — a layout hint, clamped to 1..4096. The first photo may be attached to a
  challenge-locked score (a challenge can lock a score the moment it saves, before the background upload
  lands); *replacing* one on a locked score is 409 `score_locked_by_challenge`.
- **View:** `GET /api/scores/:id/photo` — optional auth, guests included (240/10 min per user or IP).
  Loads through `visibleScoreSql(viewer)`, so a hidden home-venue score is a 404 to strangers and guests.
  Returns JSON `{ url, width, height, expiresAt }` (presigned GET, 10 min) rather than a 302: an `<img>`
  can't carry the Clerk bearer token, and the visibility check needs to know who's asking.
- **Deletion:** `DELETE /api/scores/:id` deletes the object *after* the row (`deletePhotoBestEffort`,
  using the key from `DELETE … RETURNING`), logging failures — an orphan, never a dangling row. **Any
  future code that deletes scores (or clears `photo_key`) must delete the object the same way.** Today
  that route is the only score delete in `src/`.
- **Orphans:** `npx tsx cleanup-photo-orphans.ts` (dry run; `--delete` to remove) lists `scores/` objects
  no row references and older than 24h (the floor protects an upload between PUT and confirm). It refuses
  a dev DB with the prod bucket or vice versa. No cron yet — run it by hand occasionally.
- **Bucket CORS** is configured in the Cloudflare dashboard, not in code: dev allows
  `https://localhost:5174` and `https://192.168.192.218:5174`, prod `https://tilttrack.vercel.app`;
  methods PUT, GET; header Content-Type. A new dev origin/port can view photos (`<img>` needs no CORS)
  but can't upload until it's added there.
- Tests: `npx tsx --test src/lib/photoStore.test.ts` (keys, head checks, verifyUpload against a fake
  store, presigned URL shape, orphan filter); `npx tsx test-photos.ts` — live round trip against the dev
  DB + dev bucket (upload-url → PUT → confirm → list → guest view → replace → hidden-venue 404s → delete),
  skips when R2 vars are absent, refuses anything but `tilttrack-photos-dev`.
