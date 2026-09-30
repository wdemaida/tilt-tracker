# CLAUDE.md — pinball-tracker (frontend)

## Clerk (auth)
- Use the **custom sign-in form** (`src/pages/SignInPage.tsx`) — not Clerk's pre-built `<SignIn>` component. The pre-built component has a submit button that hides behind the mobile keyboard.
- Sign-in flow uses Clerk v5 two-step: `signIn.create({ identifier })` then `signIn.attemptFirstFactor({ strategy: 'password', password })`. Handle `needs_client_trust` by sending an email code.
- HTTPS is required for Clerk cookies — local dev must use `https://localhost:5174`, not `http://`.

## Recharts (Score Trend chart)
- The Scatter chart's `YAxis` needs an explicit `dataKey="y"` (and each `<Scatter>` needs `dataKey="y"` too) — without it, recharts can't resolve the Y value for scatter points and they render invisibly, even though positions/colors look correct in the JSX.
- When a `<Scatter>` dot and a `<Line>` trend point share the same x (true here, since trend lines are built via `rollingAvg()` over the same dots), hovering the dot's exact pixel position returns BOTH in the tooltip's `payload` array — but recharts always orders the trend entry first. `ScatterTooltip` in `MachinePage.tsx` explicitly searches for a non-`trend` payload entry first; don't revert to blindly reading `payload[0]`, or dots become unhoverable again (verified empirically with Playwright — this is not a hypothetical).

## Theming (Admin > Config)
- Color keys: `primary` (Scores), `machine`, `venue`, `username`, `field` (others'/aggregate chart color). Defined in `src/lib/theme.tsx` (`DEFAULT_COLORS`), applied as CSS vars on `documentElement`, exposed as Tailwind colors (`text-venue`, `bg-username`, etc.) via `tailwind.config.ts`.
- **Recharts elements** (Line/Scatter `stroke`/`fill`) can't use Tailwind classes — pass `"hsl(var(--venue))"` etc. directly as the prop value; browsers resolve CSS custom properties fine in SVG presentation attributes.
- **Leaflet popups**: `leaflet.css` ships `.leaflet-container a { color: #0078A8 }`, which beats single-class Tailwind utilities on specificity. Any new colored link inside a `<Popup>` needs a matching override in `index.css` under `.leaflet-container .text-<key>` (see existing block) — otherwise it silently renders Leaflet's default blue regardless of the `text-*` class applied.

## Venue / score repair UI (added 2026-09-11)
- `VenueLinkageSteps.tsx` owns **steps 1 and 2** (resolve in HERE, link Pinball Map) and is shared by
  both repair surfaces. Don't fork it — `VenueRepairPanel` (venue page) and `ScoreRepairSection`
  (edit-score modal) differ *only* in step 3: bulk re-sync of every score at the venue, versus fixing
  one score's machine.
- `useVenueLinkageActions()` deliberately **does not fetch the linkage status**. Both callers already
  load it as part of a bigger payload (`/venues/:id/repair` and `/scores/:id/repair`), so fetching it
  in the hook would double the requests on both pages. The caller maps its payload into `LinkageView`.
- **Step 3 is gated on Pinball Map only**, not on HERE. The roster comes from Pinball Map; HERE is
  venue identity and plays no part in machine matching. Gating on both would lock the step on the
  seed-script venues that match fine. `StatusChip` takes `tone="info"` for HERE (neutral when
  missing) and the default `critical` for Pinball Map (amber when missing) — don't make HERE amber,
  it cries wolf on venues that work.
- **A score's author is not necessarily the venue's creator.** `/scores/:id/repair` returns
  `canRepairVenue` separately from `canRepairScore`; when false the modal shows linkage state
  read-only with a pointer to the venue page, instead of buttons that would 403.
- The edit modal is `max-h-[90vh] overflow-y-auto` — the repair section can make it taller than a
  phone viewport.
- Each step is a `CollapsibleSection` whose open state is **driven by** its `done` flag, not merely
  seeded from it: linking Pinball Map folds that step away immediately, and un-linking reopens it.
  Three stacked steps is too much panel for a venue that's already correct.
- Step 3's icon is `PinballIcon`, the same flippers used for machines everywhere else — not a
  lucide game controller. It's an `<img>` forced white by a CSS filter, so `text-*` classes don't
  tint it; size it with `w-4 h-4` and let it sit on the white heading text.
- **A score with no venue renders `ScoreVenuePicker`, not `ScoreRepairSection`.** No venue means no
  Pinball Map location, so the machine can never be verified — the picker (search existing, or add a
  new venue inline) is what unblocks the rest. It `PATCH`es `venueId` immediately rather than waiting
  for the modal's Save, matching how every other control in the repair UI behaves.

- **Address-less venues** (`LinkageView.needsAddress`, from both repair payloads): step 1 renders
  `VenueAddressFinder` instead of "Find in HERE" — name + optional city search over Pinball Map and
  HERE, plus "Enter address manually" with a geocode preview. Every pick goes through an inline
  confirm, because once an address is set this flow no longer applies and only an admin's Edit Venue
  dialog can change it. A PM pick lands in step 2 highlighted ("The listing you picked in step 1").
  `VenueRepairPanel` auto-opens once when `needsAddress`. The Venues page shows a "Needs address"
  badge + filter chip **only** when the row's server-computed `canRepair` is true (the list no longer
  carries `createdById`); residences never get it. Candidates held by a *private* venue show
  "another TiltTrack venue" with no name (`linkedElsewhere` without `linkedVenue`). An imprecise
  manual geocode saves only via "Save approximate position", which sends `acceptImprecise`.
- `LinkageView.linkageBlocked` (restricted-tier venue): steps 1–2 render an explanation instead of
  buttons — the server refuses HERE / Pinball Map linkage for private venues.

- **Merging a duplicate venue** (`VenueMergeModal.tsx`, added 2026-09-25): a HERE / Pinball Map
  candidate that another *public* TiltTrack venue holds (`linkedVenue`) shows **Merge** — in place
  of the dead Use button for HERE (unique id), alongside Use for Pinball Map (ids aren't unique).
  Also offered under the notice after a `here_id_taken` 409 or a `possibleDuplicates` warning
  (`actions.duplicateOffers`). Only the venue page passes `onMergeInto`; the edit-score modal
  doesn't merge. The modal previews, confirms with the previewed `expectedScoreCount`, **removes**
  the deleted source's `[key, id]` queries instead of invalidating them (they'd refetch into 404s),
  then navigates to the target. `VenueRepairPanel` is keyed on the venue id so it resets there.

## Private (home) venues in venue search
- Anyone may log a score at someone's home venue, but it's never suggested by location. The two
  venue searches (AddScorePage step 2, `ScoreVenuePicker`) find another user's private venue only
  through `useExactPrivateVenues()` — an exact, debounced (400ms) name lookup that returns names
  only — shown as "Private venue". `ScoreVenuePicker` also keeps others' private venues out of its
  browse/substring list (`isOthersPrivateVenue`), since the venues list itself still carries every
  venue by name.

## Add Score venue step: search, pick, or add (`src/lib/venueSearch.ts`, added 2026-09-25)
- The box used to filter only the Nearby list and *your own* venues (substring), so "pop" found
  nothing for anyone who'd never logged at Pop's — and Continue then saved the typed text as a new,
  unplaced venue (the score POST upserts a bare `venueName`). Two real users did exactly that.
- Now: typing searches, it never *is* the venue. `searchTerm` (what was typed) drives the lists and
  `useVenueSearch()` → `GET /api/venues/search`; `venueSearch` is just what the box shows (the
  picked name after a pick). Sections: Nearby, Your Venues (local, `venueMatches()` — any word,
  punctuation-insensitive), **On TiltTrack** and **Places** (server), Private venue (exact name).
  Search results already shown in Nearby / Your Venues are dropped client-side.
- **Continue is disabled until a venue is picked.** "Skip — no venue" is the explicit way on
  without one; "Not listed? Add “…” with its address" (under the results) and "+ Add a new venue"
  open the name + address form (HERE address autocomplete, `POST /api/venues` with its duplicate 409).
- Picking a Place sends `venueHereId` + coordinates/address/timezone through the existing score
  POST, which upserts on `here_id` — no new create path. `searchTokens()` here must stay in step
  with the api-server's `venueSearch.ts`.
- **A pick with no Pinball Map link is matched on pick** (`pmLookup` → `api.venues.pmMatch`, once
  per pick, never per result): a Place by its coordinates + name, a TiltTrack venue by id. Nearby
  HERE places (`pmChecked`) and private venues (`isPrivate`) are skipped. `effectivePmId` (the
  venue's own link, else the resolved one) drives the roster (`/pm-machines/:pmId`, merged into a
  TiltTrack venue's payload when its link was only just resolved), `canPostToPm`, and the score
  POST's `venuePinballMapId`, which links the venue on save. No match → catalog search as before.
- **Tapping a venue option picks it and advances to step 3** (`selectVenueCard` → `setStep(3)`);
  Continue remains for returning to step 2 with a pick kept. The pm-match / roster queries live at
  the top of the component keyed on `selectedVenue`, so they keep loading across the step change —
  step 3's picker shows the loading state, and Save is held ("Checking venue…") while
  `pmMatchLoading`, so `venuePinballMapId` isn't dropped. Add-a-venue and the duplicate prompt keep
  their own explicit buttons.
- **Wizard steps are in browser history** (steps 2–3 push a same-URL entry tagged `addScoreStep` /
  `addScoreDepth`), so the phone back gesture steps back instead of leaving /add. The visible Back
  (`goBack`, top and bottom of steps 2–3) pops that entry rather than calling `setStep` directly —
  keep it that way or history and screen drift apart. Reaching step 4 unwinds the entries with
  `history.go(-depth)`, so back from the success screen can't reopen the form and double-save.
- A venue's machine list now has **"Not listed? Type the machine name"** (`machineFreeText`), which
  switches to the catalog search input; before, a roster venue offered no way to enter an unlisted
  machine unless the AI had read a name.

## Home-venue inventory and the show-publicly switch (added 2026-09-25)
- The Edit Venue dialog is one component, `EditVenueDialog.tsx`, used by the Venues page card and
  the venue detail page header — same pencil, same permission (the row's server-computed
  `canEdit`; the list no longer sends `ownerId`). "Show my machines/scores publicly" appears only
  for a private venue, because the server only honours it there.
- `VenueInventoryPanel.tsx` on the venue page lists a home venue's machines; owner/admin get
  add (typeahead over `api.machines.search`, the Pinball Map catalog) and remove. It reads the
  `['venue-machines', id]` payload (`inventory`, `canManageInventory`), shared with
  `VenueMachinesModal`, which shows the inventory as "Machines here" and removed ones under
  "Formerly here". AddScorePage offers a venue's inventory as machine suggestions.
- `activityHidden` on a venue payload means the owner turned the switch off and you aren't exempt:
  the card shows name + "Address hidden" (+ your own score count), no machine pill; the venue page
  says so and lists only your own scores.
- **Every read in `api.ts` now sends the token when signed in** (not just the `mine` variants),
  and UserPage/MachinePage use `useApi()` — what a score listing contains depends on who's asking.

## Duplicate venues
- `POST /api/venues` answers **409 `duplicate_venue`** with `candidates` when a venue of the same
  normalized name already exists within 250m (`src/lib/venueDedup.ts` on the api-server). Both
  create-a-venue surfaces — `ScoreVenuePicker` and AddScorePage's "Add custom venue" form — must
  render those candidates as "use this one instead" buttons plus a **Create it anyway** escape that
  re-sends with `allowDuplicate: true`. It is never a hard block: a chain's other branch is a real
  venue, not a duplicate.
- The API client's thrown error carries the whole payload on `.body`, so `e.body.candidates` is how
  the UI reaches them; `.code` and `.status` are unchanged for existing callers.

## Time zones
- **A score is displayed on its venue's clock, not the reader's.** `formatScoreTime(playedAt,
  venueTimezone, fmt)` in `src/lib/scoreTime.ts` is the only sanctioned way to render a `playedAt` —
  don't reach for bare `format(new Date(...))` again. The property it buys: the time shown equals
  what the camera recorded, for everyone, forever. Viewer-local rendering made a Friday night in
  Chicago read an hour late from the east coast and could push a late score onto the wrong date.
- Falls back to the viewer's zone when `venueTimezone` is null — a score with no venue, or a
  hidden-tier residence whose zone is redacted with its address.
- `zoneAbbreviation()` returns a short label ("CDT") **only** when the venue's clock differs from the
  reader's, so the common case stays uncluttered. It compares rendered labels rather than zone ids,
  because America/New_York and America/Kentucky/Louisville read identically.
- `createdAt` ("added: …") stays viewer-local on purpose. That's an event in the reader's own life,
  not something that happened at the venue.
- **The edit modal's input must use the same zone as the card.** If the card says 6:01 PM Chicago and
  the input says 7:01 PM Eastern, correcting a score silently shifts it — that's the bug class this
  whole area exists to prevent. `toLocalInput`/`localInputToIso` both take an optional zone.
  Attaching a venue mid-edit re-expresses the field, since the score's clock just changed.

## Date & time inputs
- Always convert through `src/lib/datetime.ts`. `new Date(iso).toISOString().slice(0, 16)` looks
  right for a `datetime-local` input and is wrong — it writes **UTC** into a field the browser reads
  as **local**, so the edit modal and the score card disagreed by the viewer's offset and saving
  wrote that shift back to the database. `toLocalInput` / `localInputToIso` are the round trip;
  `naiveToLocalInput` is for the zone-less wall clock `/api/upload` returns for EXIF timestamps.

## Camera-recorded played times are locked (`src/lib/captureTime.ts`, added 2026-09-30)
- A score's played time from the photo's EXIF (or a video's own metadata) **can't be changed by the
  player — only by an admin**. Server rules, token and the `played_at_source` column: api-server
  CLAUDE.md, "Played-time provenance". Legacy scores (source null) and manual ones stay editable.
- **Add Score:** `applyUploadResult` sets `playedTimeLock` via `playedTimeLockFor()`: `/api/upload`'s
  `playedAtSource` + `playedAtToken` → locked (`photo`/`video`); a video's `mvhd` instant
  (`capturedAtSource: 'container'`) → locked `video`, no token; a video's **`file.lastModified`**
  (`capturedAtSource: 'file'` — forwarded/re-saved videos have no recording time) → **not** locked,
  editable, with "Couldn't read when this video was recorded — check the time."; camera time the
  server couldn't sign, AI-read or none → editable. Locked shows the time read-only with "From your
  photo" / "From your video" and "Wrong time? Ask an admin to correct it after saving." Submit sends
  `playedAtToken` and `playedAtSource`; a stale/tampered one comes back 400 (message shown).
  `pickVideoCaptureTime()` (creationdate → mvhd → lastModified) is what `videoFrames.ts` uses; video
  frames carry `timeKind: 'video'` so the upload `meta` tells the server a creationdate is a video's.
- **Edit dialog:** for a locked score and a non-admin the Date & Time is read-only ("From your photo",
  "Wrong time? Ask an admin to correct it.") and **`playedAt` is not sent**. An admin can edit it; a
  changed value needs a reason (inline textarea, ConfirmDialog's style, 500 chars) sent as
  `playedAtReason`, and Save stays disabled until it's filled. `EditScoreTarget.playedAtSource`
  comes from the list row (`GET /api/scores`) or the POST row.
- **Challenge summary:** `ChallengeFitSummary` takes `playedAtSource`; played-time lines on a locked
  score end "(time from your photo)" — "Not counted in your Munsters challenges — played May 2,
  before they started (time from your photo)". Callers leave out `onEditPlayedTime` (so no "Edit
  played time" button) for a locked score unless the viewer is an admin.
- `formatWallClock()` (datetime.ts) prints a datetime-local value read-only without re-zoning it.
- Tests: `npx tsx --test src/lib/captureTime.test.ts` (from artifacts/pinball-tracker; `*.test.ts`
  is excluded from `tsconfig.app.json`, since the app's types don't include node:test).

## Missing photo location (`MissingLocationNotice.tsx`, `src/lib/photoLocation.ts`, added 2026-09-25)
- A page can't see whether the Camera app geotags photos — only whether the picked files carry GPS
  (`describePhotoLocation()` over the prepared images, plus the upload result's `latitude`, since
  the server has its own EXIF fallback). None has GPS → step 2 shows the amber notice.
- "Use my current location" is **always offered when there's no photo GPS** — including no photo at
  all ("Skip AI & Enter Manually", `info={null}`) — since the tap itself is the user saying "I'm
  still here". `currentLocationOffer()` only sets prominence: a big button when the photo is recent
  (within 2h) or of unknown age (camera input, or a picked file with EXIF stripped — screenshots,
  messaging-app forwards); a quiet "Still there?" link when the photo's clock says it's older.
  (Changed 2026-09-25: users with GPS-less photos typed bare venue names, one a duplicate.) Not
  offered when the photo *had* GPS but found no venues. It fires `getCurrentPosition` **only on tap** and calls
  `POST /api/upload/nearby-venues` (JSON body, coords rounded to 4 decimals client-side), which
  shares `suggestVenuesNear()` with the photo path. It's rate-limited per user (10/min, 100/day →
  429, whose message the notice shows) and cached per ~110m cell for 10 minutes.
- **The device position is never the score's location.** It lives in `deviceCoords` (venue lookup
  and address-autocomplete bias only) — never in `gps`, which is spread into `POST /api/scores`.
  Cleared on a replace upload.
- Both lookups land after an await, so they read venue state from `latestVenueRef`, never the
  closure: a venue the user picked or typed meanwhile (search text set) is never overwritten. A GPS
  photo added after a current-location lookup replaces the "Near You" list; the device lookup's own
  auto-pick (`deviceAutoPickRef`) may be replaced, a user's pick may not.
- On iPhone, photos from the `capture` input usually arrive without GPS, so the camera path is where
  the fallback matters most. Step 1 says "Location is off for this site…" only when the Permissions
  API reports `denied`; unknown/unsupported shows nothing.

## Partial score reads (`ScoreDigitInput.tsx`, `src/lib/scoreTemplate.ts`, added 2026-09-24)
- When `/api/upload`'s `scoreRead.template` contains `?`, step 3 renders digit cells instead of the
  plain input: unread positions are amber x's filled left-to-right, low-confidence digits are amber
  but need no confirmation. **Never auto-fill** — the trailing-zeros chip is a one-tap suggestion only.
- Save is blocked two ways while x's remain: the button is disabled, and the zod schema's
  `scoreUnfilled` field fails validation. `scoreUnfilled` is stripped before `POST /api/scores`.
- The hidden input keeps a one-space sentinel value so a mobile keyboard's backspace still fires a
  change event; don't "simplify" it to an empty controlled input.
- "Edit as plain number" starts the field **empty** when x's remain — dropping the x's would shrink
  the score by orders of magnitude.
- Every file goes through `prepareUploadImage()` (EXIF first, then HEIC convert, then a ~2000px JPEG
  downscale) — it replaced `heicClientConvert.ts`. The file input takes up to 3 photos, and step 3's
  "Add another photo" re-uploads the **whole set** so the server can merge the reads; it deliberately
  doesn't overwrite a machine or venue the user already picked.
- **Adding a photo never throws away digits the user typed.** `reconcileUserDigits()` carries every
  user entry (a filled x, or a corrected digit) onto the new read, right-aligned like the server merge.
  Where the new read has a *different* digit the user's wins, and the cell turns amber with
  "Use 7 / Keep 2" buttons (`disagreements` prop on `ScoreDigitInput`). Plain-number mode counts every
  digit as the user's. It reads the score state from `latestScoreRef`, not the closure — the upload
  result lands after an await and the user may have kept typing.
- **Video input** (`src/lib/videoFrames.ts`): a video counts as one of the 3 items and is never
  uploaded. ~15 frames are sampled (seek + `seeked`, plus `requestVideoFrameCallback` where it
  exists), scored by Laplacian variance on a small grayscale copy, and the sharpest frame from each
  third of the clip is sent (spread matters — different refresh phases light different digits).
  Limits are `MAX_VIDEO_SECONDS` / `MAX_VIDEO_BYTES`. GPS/time come from a byte scan of the QuickTime
  `moov` box (Apple ISO 6709 location + `creationdate`, `©xyz`, then `mvhd`), falling back to
  `file.lastModified` and no GPS. **`mvhd` and `lastModified` are instants, not wall clocks** — they
  travel as `capturedAt` (ISO, UTC), never `exifDatetime`, and AddScorePage renders them with
  `toLocalInput(instant, venue.timezone)`, re-deriving when the venue changes until the user edits
  the field. Formatting them as a naive clock in the browser's zone and then re-reading that in the
  venue's zone shifted the time — the same bug class as the 2026-09-13 EXIF fix. Apple's
  `creationdate` is a real wall clock and stays `exifDatetime`. A browser that can't decode the codec (HEVC .mov in Chrome on
  Windows) gets a friendly "try a photo" message, and the wizard stays on step 1.
- iOS web file pickers hand over only the still of a Live Photo, which is why step 1 tells users to
  "Save as Video" first.
- **Camera and picker are separate inputs.** Android Chrome skips offering the camera for a `multiple`
  input, so the big "Take photo" target is `accept="image/*" capture="environment"` with no `multiple`,
  and multi-select (photos or videos) is the secondary button. Step 3's add row mirrors it. Don't
  merge them back into one input.
- **"Which player were you?"** (added 2026-09-24): when `/api/upload` returns more than one
  `playerReads` entry, step 3 shows a card per display (x's in amber) in place of the score field,
  and Save is disabled until one is picked. The pick becomes `scoreRead`, so ScoreDigitInput, the
  trailing-zeros chip and plausibility all run on that player only. "Change player" reopens the
  cards; "None of these — type it in" is plain-number entry. One display skips the question. Never
  pre-select from `selectedPlayerIndex` — that's only the old-client fallback.
- After "Add another photo", `matchPlayerRead()` keeps the pick by player number, else by position
  when the display count didn't change. If it can't, the user is asked again and whatever they had
  typed waits in `pendingCarryRef` to be reconciled onto the player they pick — adding a photo
  still never throws away their digits. Switching player *deliberately* does start fresh.
- `leadingPositionAmbiguous` surfaces as a "may be missing digits" reason
  (`LEADING_AMBIGUOUS_REASON`), non-blocking, dropped once the typed number is longer than the read.
  There are deliberately no +/- digit controls.
- `alignmentWarning` (the server's close-up re-read disagreed with the whole-photo read) shows a
  separate non-blocking note, "Digits were hard to line up — check each one against the machine".
  A flagged read **always opens in digit-cell mode, even when complete** — never prefilled into the
  plain number field — so its amber `lowConfidence` digits and its `conflicts` picker are visible.

## Full-size photos (`src/lib/fullSizePhoto.ts`, `components/PhotoViewer.tsx`, added 2026-09-26)
- Thumbnails are unchanged (160px data URL on the score). The full-size photo is uploaded to R2 **after**
  the score saves, in the background (`runFullPhotoUpload` in AddScorePage); step 4 shows Saving / Saved /
  Retry, and says nothing when there's no photo or the server has photos disabled. Tapping Done doesn't
  cancel it.
- Only the image behind the thumbnail is uploaded — `setBestImage()` is called exactly where
  `generateThumbnail()` is, so the two can't diverge. **Never upload the camera original**: every photo is
  redrawn through a canvas (drops EXIF/GPS — home-venue privacy), capped at `FULL_MAX_EDGE` 4096 (iOS
  Safari's ~16.7MP canvas limit; 24MP iPhone photos exceed it) and encoded JPEG 0.92, stepping down if
  over 11.5MB. Video frames are drawn at native resolution during extraction (the `<video>` is gone by save
  time) and marked `ready`. A `heicFailed` image gets no full-size.
- **Encoded at pick time, with a fallback** (added 2026-09-29 — an Android user's full photos silently
  never uploaded). `setBestImage()` hands the image to `FullPhotoEncoder`, which encodes in the
  background right away (one encode at a time, latest image wins, a replaced image's encode aborts at
  its next step); `runFullPhotoUpload` awaits that result. Android gallery/cloud Files may not be
  readable minutes later at save time. If the full encode fails (`encodeFullSizePhoto` returns
  `{ ok: false, reason: 'heic' | 'decode' | 'too_large' | 'no_image' }`), `encodeScorePhoto` redraws
  the ~2000px `PreparedImage.file` through a canvas and uploads that (`variant: 'fallback'`, step 4:
  "Saved a smaller copy of the photo"). Always redrawn — `file` is the untouched original when it was
  already a ≤2000px JPEG. **Nothing goes silently idle after a real attempt**: a failed encode or upload
  shows the failed line with a reason and Retry (which re-encodes).
- **HEIC:** `prepareUploadImage` tries the browser's native decoder (`createImageBitmap`, Safari 17+)
  before heic2any. heic2any paints the whole decoded image into one canvas, so a 24MP+ HEIC on an iPhone
  exceeds the canvas limit and silently becomes `heicFailed` (server decode). Note iOS usually hands
  `accept="image/*"` inputs a JPEG anyway; raw HEIC mostly arrives from the Files picker or desktop.
- Viewing: `api.scores.photo(id)` via `useApi()` (no token for guests) returns a signed URL for the
  `<img>`; cached 4 min under `['score-photo', id]` (URLs last 10). `PhotoViewer` portals to `<body>` at
  z-50; hand-rolled pointer zoom (pinch/drag, wheel, click on desktop, double-tap on touch), closes via ×,
  Escape, backdrop tap or swipe down at 1×. Home `ScoreCard` thumbnails with `hasFullPhoto` open it (tiny
  expand badge); user/machine/venue/challenge rows use `FullPhotoButton` (camera icon).
- **Thumbnail-only scores** (added 2026-09-26 — a user posted one from an old cached app and the tap
  did nothing) open the same viewer: `GET /photo` answers `url: null` + `thumbnail`, shown unblurred and
  capped at `THUMB_MAX_UPSCALE` (3×) its natural size, with "Thumbnail only — the full-size photo wasn't
  saved". Every Home thumbnail is tappable (the expand badge still means a full photo). Other lists get
  `hasThumbnail` and show `FullPhotoButton` **dimmed** for thumbnail-only rows — nothing for no photo.
- **Adding the full photo later** (`components/FullPhotoUpload.tsx`): the viewer shows "Upload the
  full-size photo" (thumbnail-only) or a quiet "Replace photo" **only when the response's `canUpload`
  is true** — the server decides ownership and challenge locks; never gate it on client-side username
  checks alone. The Home edit dialog has the same button (own scores only) for scores with no photo at
  all. Same encode path as AddScorePage (`prepareUploadImage` → `encodeFullSizePhoto` → upload-url →
  PUT → confirm), then `invalidatePhotoQueries()` refreshes the viewer and every score list. The
  `['score-photo', id, userId|'guest']` key includes the viewer because `canUpload` is per viewer.
- Uploads only work from origins in the R2 bucket's CORS list (see api-server CLAUDE.md) — a scratch vite
  on another port can view but not upload.

## Stale-tab guard (`src/lib/appVersion.ts`, `components/UpdateBanner.tsx`, added 2026-09-29)
- `vite.config.ts` bakes a build id (Vercel's `VERCEL_GIT_COMMIT_SHA`, else `git rev-parse`, else the build
  time) into `import.meta.env.VITE_APP_BUILD_ID` and emits `dist/version.json` with the same id
  (`vercel.json` serves it `no-store`). When a tab becomes visible (at most every 10 min) it fetches
  `/version.json`; a different id shows a small "A new version is available — Reload" banner. It never
  reloads by itself (it would lose a half-entered score); on `/add` Reload asks first. Off under the
  dev server (no version.json there) — test with `npx vite build && npx vite preview`.
- Every API call sends the id as `X-App-Version`; `score.created` records it as `appVersion`.

## Admin area (`src/pages/Admin*.tsx`, `components/admin/`, `lib/adminApi.ts`, added 2026-09-26)
- Routes: `/admin` (Overview), `/admin/users`, `/admin/users/:id`, `/admin/activity` (`?userId=`,
  `?category=`, `?type=`), `/admin/crew` (`?tab=friendships|challenges|notifications`),
  `/admin/scores` (`?userId=`), `/admin/health`, and `/admin/config` (`?tab=retention|photos|stats`;
  no param = Theme). `AdminNav` scrolls sideways on phones rather than wrapping.
- **Config is tabs** (`CONFIG_TABS` in `AdminConfigPage.tsx`, added 2026-09-29): Theme, Data
  retention, Photo storage, Stats. Stats is `AdminStatsPanel` from `AdminStatsPage.tsx`; `/admin/stats`
  is only a redirect to `?tab=stats` now, and isn't in `AdminNav`. Its Recent History is the last 7
  New York calendar days, fixed server-side in `GET /api/admin/stats/history`.
- `AdminGate` renders nothing until `/api/users/me` says admin, so admin pages never fire requests
  for guests or users (the server refuses them regardless).
- Admin calls live in `lib/adminApi.ts` (`useAdminApi()`), built on the `request` helper exported from
  `api.ts`. Every action goes through `ConfirmDialog` (optional reason → stored in the activity log)
  and invalidates every `['admin', …]` query afterwards.
- Event wording is `TYPE_TEXT` / `detail()` in `components/admin/AdminParts.tsx` — add a line there when
  the server gains an activity type (unknown types still render, as their raw name).
- A disabled account (`me.disabledAt`) gets `DisabledAccountNotice` from `Layout` instead of any page.
- **Config → Data & Storage** (`components/admin/MaintenanceSettings.tsx`): `RetentionSettingsCard`
  (activity-log tiers, server-side via `GET/PUT /api/admin/settings/retention` — unlike the theme
  colours above, which are localStorage) and `PhotoOrphansCard` (dry run runs directly; the real run
  goes through `ConfirmDialog`). Client-side validation mirrors the server's `limits`; the server is
  the authority. The would-delete estimates reflect the *saved* settings, not unsaved inputs.

## Badges (`components/BadgeImage.tsx`, `BadgeShelf.tsx`, `pages/BadgesPage.tsx`, `AdminBadgesPage.tsx`, added 2026-09-29)
- **`BadgeImage` is the only way to draw a badge**: the uploaded image when `imageVersion` is set,
  else the lucide `icon` (`BADGE_ICONS`, kebab-case names; unknown → award) in `color` on a tinted
  disc. `locked` = grayscale + dimmed (the catalog's not-yet-earned look — same asset). Image URLs
  carry `?v=<imageVersion>` and are cached immutably, so never build one without the version.
- Profile (`UserPage` → `BadgeShelf`): public for everyone, 48px grid in the **admin's sort order**
  (not newest first), "View all" past 12 items, tap → `BadgeDetail` (96px). No badges → hidden,
  except on your own profile (link to `/badges`). **Series** (feature/badge-series): renders the
  server's collapsed `items` (`shelfItems()` falls back to one per badge for an older server) — a
  series is one tile, its highest earned tier with `SeriesPips` under it (filled = earned tiers,
  hollow = remaining live tiers, series color); the hover tooltip adds "Tier 2 of 4"; the detail
  shows "Scores · Tier 2 of 4" and `SeriesLadder` (every tier: ✓ + earn date, or ○ "Not yet", with
  its requirement). A tier's `color` is already the series color — never recolor it client-side.
- `/badges` catalog (public route): live badges in the shared order; unearned ones locked;
  `availabilityText()` gives "Earn it on Dec 25, 2026" for a one-day rule, else the window.
  `groupCatalog()` turns a series' consecutive tiers into one full-width ladder card (header in the
  series color + pips); tapping a tier opens its detail with the ladder.
- AddScorePage step 4 shows `newBadges` from the score POST at 96px; the notifications page renders
  `badge_earned`.
- `/admin/badges`: list + editor (kind, metric + N or the rule form builder, window, retroactive),
  image upload with a live 48/96/locked preview, Preview / Go live / Retire, grant picker (admin user
  search) and per-holder revoke — all through `ConfirmDialog`. Preview, Go live and Backfill now use
  the **saved** badge, so the editor tracks unsaved edits (`dirty`: `bodyOf(draft)` vs
  `bodyOf(draftOf(saved))`): with edits pending, Go live is "Save & go live" (PATCH, then activate
  the saved badge) and Preview / Backfill now are disabled ("Save changes first"). Going live with
  Retroactive ticked but unsaved once activated forward-only on prod. "Backfill now" shows on live
  retroactive badges (idempotent server-side); saving a live badge with Retroactive newly on
  confirms first, since the server backfills on that save, and toasts "Saved — N awarded". The editor opens inline under its row (new: at the top), scrolls into view and focuses Name; saving
  an edit collapses it with a toast. Icon = `IconPicker` (searchable grid in the badge color); rule
  machine = `components/MachineCombobox.tsx` (attached dropdown, keyboard, chip with ×). Admin
  actions also invalidate `['notifications']` — they can award the admin themself.
- `/admin/badges` **series + order** (feature/badge-series): the list is the shared order from the
  server's `order` — series rows (header in the series color → inline `SeriesEditor`: rename,
  recolor every tier, the `{N}` "Tier description" template, delete only when empty) with their
  tiers indented beneath, and singles. **Inside a series**, a tier with a threshold has no controls
  (the server seats it by N); a rule/manual tier has its own grip + ▲/▼ and can go anywhere in the
  ladder — `moveTier` is optimistic and PUTs the series' full tier list (`reorderSeriesTiers`); its
  drag events `stopPropagation` so the series row's drag doesn't fire. Each series ends with the
  one-line ordering hint and **Add tier**: `GET /badge-series/:id/new-tier` → the editor opens
  under that series (`Editing = … | { prefill }`, `draftOfPrefill`), title "New tier · <series>",
  with a "Suggested: the next step after …" hint on N. The description follows the series
  template while it still reads as the template's text or is empty (`descLinked` /
  `descFollowsTemplate`): changing N, series or kind rewrites it (`setFollowing`); typing your
  own stops that, and "Use the series wording" restores it. Reorder a top-level row by dragging its grip handle (HTML5 drag, armed only from the
  handle, `sm:` and up) or the ▲/▼ buttons (keyboard + phones; an `aria-live` line announces the
  move). Each move is optimistic and PUTs the full order (`reorderBadges`); a failure restores and
  toasts. Reordering is off unless the status filter is All. Editor: **Series** select (None /
  existing / "New series…"); in a series the badge's own Color is hidden and "Series color" (+ name)
  shows instead — saving PATCHes the series first (dirty-tracked like the rest); a new metric badge
  preselects its metric's series until the admin touches the select. There's no order field any
  more (the old "Tier order" is gone): singles are placed by the list, tiers by N or the in-series drag.
- `/admin/badges` **one metric per series** (2026-09-30; server: 400 `series_metric_mismatch`,
  shown inline on Metric via `errors.metric`). `seriesMetricOf()` mirrors the server's
  `seriesMetric` (ignores the badge being edited). When the badge's series was *chosen* (an existing
  badge's, the admin's pick, or Add tier) and its other metric tiers have a metric, Metric is locked
  to it — hint "All tiers in <Series> count <label>" — and picking a series or switching Kind to
  Metric sets it (`withSeriesMetric`). Otherwise Metric is free and the Series select offers only
  compatible series (+ None / New series; the hint counts the hidden ones); a new badge's auto-picked
  series still follows its metric. A tier that already disagrees is never switched silently: Metric
  stays editable with an amber "change it to …, or move it out" hint, the series row shows the
  server's `metricConflict.message`, and the odd tier gets its own amber line.
- **Toasts** (`lib/toast.ts` + `components/Toaster.tsx`, mounted in `Layout`): `toast({ title, body,
  tone, icon, href })` for confirmations and passive news; errors that need fixing stay inline.
  `lib/badgeToasts.tsx` toasts new unread `badge_earned` notifications off the bell's 30 s unread-count
  poll (high-water mark per user in localStorage; the first visit only records one), skipping badges
  AddScorePage already showed (`markBadgesShown`). Other notification kinds could reuse it.
- `index.css` sets `color-scheme: dark` and explicit `select option` colors — native `<select>` popups
  were white-on-white. SignInPage's white inputs opt back into `[color-scheme:light]`.

## Group challenges (`ChallengePage.tsx`, `ChallengesPage.tsx`, `NewChallengePage.tsx`, added 2026-09-29)
- Up to 7 friends per challenge (`MAX_INVITEES` in `lib/challenges.ts`); the create form sends
  `friendIds`. One friend → "Recommended for @friend" (`/recommendations/:username`); several →
  "Recommended for the group" grouped by `coverage` (`/recommendations?users=`), a friend's own home
  shown as "at @name's" (`atHomeOf`).
- `isGroupChallenge(c)` = more than two participants and not a proposal. Groups get the ranked
  `StandingsList` (one row per player — phone-friendly) and a `Roster`; 1:1 keeps the two cards.
- **Counter-offers are proposals** to the challenger: `c.isProposal`, `c.proposedBy`, and the
  original's `c.proposals`. The challenger decides with `act(id, 'accept' | 'decline')` on the
  proposal's id ("Take it for everyone" / "Keep mine" — `me.canDecideProposal`). An accepted player
  in a pending challenge sees "Back out" (a decline); the challenger sees "Start with who's in"
  (`me.canStart`, `act(id, 'start')`). Both go through an inline confirm.
- **Did my score count?** (`components/ChallengeFitSummary.tsx`, 2026-09-30): Add Score's step 4
  and the edit dialog (after a save) render the `challenges` list POST / PATCH `/api/scores` return.
  Identical (status, reason) pairs share one line; tap a line for links to the challenges. Copy:
  all counted "Counts in 4 of your challenges" (one: "Counts in your Munsters (Pro) challenge" — a
  leading "The" is dropped after "your"); `played_before_start` "Not counted in your … challenges —
  played May 2, before they started" (the date via `formatScoreTime` in the venue's zone);
  `played_after_end` "…after they ended"; `posted_before_start` / `posted_after_end` "…logged
  before they started / after they ended"; `no_photo` "…challenge scores need a photo";
  `wrong_venue` "…they only count at <venue>"; `not_visible` "…the other players can't see scores at
  this venue"; `not_started` "Your … challenge hasn't started yet — plays after it starts will
  count". Nothing renders when the list is empty (no challenge on that machine). **Edit played time**
  shows only for a played-time reason and only when nothing counted (a counted score is locked, 409).
- **One edit-score dialog** (`components/EditScoreDialog.tsx`), used by Home's cards and step 4's
  Edit played time — don't build a second editor. When the PATCH returns challenges it stays open on
  the summary ("Score Updated", Done / Edit played time); otherwise it closes as before. `onSaved`
  hands the caller the updated fields + summary (step 4 re-renders from it).
- **Read `status`, not `phase`, for proposed / rejected / lapsed** — the server maps them onto old
  phases for cached clients. `statusLine` has a `default` branch: never remove it (an unknown status
  from a newer server must not crash the page).
