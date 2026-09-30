# TiltTrack — App Specification

> **Last reconciled:** 2026-09-30 (main `be5b523`).
>
> **Purpose:** the product and feature spec for what TiltTrack does and the rules it follows. It
> started life as the rebuild spec for the original Replit app (which could not be downloaded);
> that rebuild is long done and the app has grown well past it. This document describes
> **behavior and rules**. Implementation detail — file names, endpoints, gotchas, tests — lives in
> the CLAUDE.md files, which this spec links to rather than repeats:
> [root](./CLAUDE.md) · [frontend](./artifacts/pinball-tracker/CLAUDE.md) ·
> [api-server](./artifacts/api-server/CLAUDE.md).

---

## Mission

TiltTrack exists so that:

1. **Log & improve** — players can easily log all their plays (snap a photo, done) and watch
   themselves improve over time.
2. **Compare & connect** — players can see their progress next to others, and maybe find new
   friends through it.
3. **Play together from anywhere** — players in "pinball wastelands" (few machines, nobody local to
   play with) still get the social, play-together side of pinball.

Getting better and *completing* games matters as much as chasing raw high scores. Feature sections
below are tagged with the goal(s) they mainly serve: **[1]**, **[2]**, **[3]**.

---

## What It Is

**TILTTRACK** is a pinball score tracker. A player photographs the score display (or records a short
video); Claude reads the score, and the app fills in the machine, the venue (from photo GPS or
search), and when it was played (from the photo's own metadata). Scores are browsable by machine,
venue and player, charted over time, compared against friends and self-chosen groups ("pods"), and
used in friendly challenges and badges. Machine rosters come from **Pinball Map**; places come from
**HERE**.

Deployed at [tilttrack.vercel.app](https://tilttrack.vercel.app) (frontend, Vercel) with the API on
Render and the database on Neon.

---

## Routes

"Gate" is what a visitor needs. Every route except `/welcome`, `/sign-in` and `/sign-up` first
requires **access**: signed in, or guest mode (see [Access](#access-welcome-guest-mode-sign-in)).

| Route | Gate | Description |
|-------|------|-------------|
| `/welcome` | none | Marketing landing page; "Start Tracking", Sign In, Continue as guest |
| `/sign-in`, `/sign-up` | none | Custom Clerk forms (email/password + Google), plus Continue as guest |
| `/` | access | **Recent Scores** feed |
| `/machines` | access | Machine table: search, manufacturer/year filters, sortable columns |
| `/machines/:name` | access | Machine detail: top score, trend chart, compare scope, venue difficulty, score table |
| `/venues` | access | Venues **List / Map** toggle (`?view=map`); search + state filter |
| `/venues/:id` | access | Venue detail: map thumbnail, machines, scores, compare scope, repair / inventory |
| `/map` | access | Redirect → `/venues?view=map` (keeps old `?venueId=` links working) |
| `/users/:username` | access | Profile: scores, badge shelf, challenge record, friend button |
| `/badges` | access | Badge catalog (earned and locked) |
| `/stats` | signed in | Stats with Compare scope; site-wide section |
| `/add` | signed in | Add Score wizard (4 steps) |
| `/setup` | signed in | First-run profile: display name + username |
| `/crew` | signed in | Crew: **Friends / Pods / Challenges** tabs (`?tab=`) |
| `/friends`, `/pods`, `/challenges` | signed in | Redirects to the matching Crew tab |
| `/challenges/new` | signed in | Create a challenge (1:1 or group) |
| `/challenges/:id` | signed in | Challenge detail: standings, roster, actions |
| `/notifications` | signed in | In-app inbox |
| `/admin`, `/admin/*` | admin | Admin area (see [Admin area](#admin-area)) |

---

## Feature Details

### Access: welcome, guest mode, sign-in

- A visitor with neither a session nor guest mode lands on **`/welcome`**, a marketing page with a
  real score in the hero and a "your legacy" trend chart. (A mission/origin-story section is parked,
  unmerged, on branch `wip/welcome-mission`.)
- **Guest mode** (a per-browser flag, set by "Continue as guest") allows browsing everything that
  isn't signed-in-only. Guests can't add scores, see Stats, Crew, challenges or notifications.
- **Sign-in** is a custom form (Clerk's pre-built one hid its submit button behind the mobile
  keyboard); HTTPS is required for Clerk cookies.
- **First sign-in** routes to `/setup`: display name + username (letters, numbers, underscores),
  stored in TiltTrack's own `users` table.
- A **disabled** account (admin action) sees an "Account disabled" notice instead of any page, and is
  banned in Clerk. **Users are never deleted** — disabling is how an account is retired.

### Navigation & app chrome

- Desktop header: **Scores · Machines · Venues · Stats · Crew**, the notifications bell, "Add Score",
  and an avatar menu for personal items (your profile, Crew, Admin for admins).
- Phones get a **bottom tab bar** (the hamburger menu is gone). The Crew entry carries a badge for
  pending friend requests + challenges awaiting your answer.
- Every `@username` everywhere links to its profile, always shown with the `@`.
- **Stale-tab guard:** when a tab becomes visible and a newer build has shipped, a small "A new
  version is available — Reload" banner appears. It never reloads by itself; on `/add` it asks first,
  so a half-entered score is never lost.
- **Toasts** for confirmations and passive news (e.g. a badge earned); errors that need fixing stay
  inline.

### Recent Scores (`/`) — [1] [2]

- Score cards, newest first, 10 at a time with "Load more".
- **ALL / MINE** scope toggle; type filter **ALL / CASUAL / TOURNAMENT**; search by machine name.
- Each card: machine, score, played time (on the venue's clock — see [Time](#played-time-and-time-zones--1)),
  venue (house icon for a home venue), `@username` (with pod-member icons for the viewer's pods),
  thumbnail, type badge, "added:" time.
- A **trophy** marks the top score on that machine among the scores shown.
- Tapping a thumbnail opens the full-screen [photo viewer](#score-photos--1). Your own cards have edit /
  delete.

### Add Score — 4-step wizard (`/add`) — [1]

Steps: **1 Photo → 2 Venue → 3 Details → 4 Done.** Wizard steps are in browser history, so the phone
back gesture steps back rather than leaving; after saving, back can't reopen the form.

**Step 1 — Photo / video**
- A big **Take photo** button (camera) and a separate picker for up to **3 items** (photos or a short
  video). They're separate inputs because Android skips the camera for multi-select inputs.
- "Skip AI & enter manually" escape hatch.
- Everything is prepared in the browser first: EXIF (GPS + time) read, HEIC converted, downscaled.
- **Video** (a short clip, size/length capped) is never uploaded: the sharpest frames are picked in
  the browser and sent as photos. Live Photos: step 1 tells iPhone users to "Save as Video" first,
  since iOS web pickers hand over only the still.

**Reading the score** (Claude, forced structured output) — the rules that make old displays work:
- A read is a **template**: digits plus unread positions. Old multiplexed/segment displays are often
  caught mid-refresh; the model never guesses a dark or partly-lit digit.
- **Unread digits show as amber x's** to fill in. Save is blocked until every x is filled. Nothing is
  ever auto-filled (a trailing-zeros chip is a one-tap suggestion only).
- **Multiple photos** of the same display are merged digit-by-digit; a disagreement becomes an x with
  both candidates offered. "Add another photo" in step 3 re-reads the whole set and **never throws
  away digits the user typed**.
- **Multi-player displays:** every player's score is read. With more than one, step 3 asks **"Which
  player were you?"** and never pre-selects.
- Segment displays with dark windows get a second, close-crop read to place missing digits. A crop can
  never shorten a score or silently replace a digit; a flagged read opens in digit-cell mode with
  "Digits were hard to line up".
- "May be missing digits" is a non-blocking warning when a read is implausibly low for that machine.
- Photos that look like different games (>10 min or >200 m apart) raise a warning.
- Details: api-server CLAUDE.md "Score extraction"; frontend CLAUDE.md "Partial score reads".

**Step 2 — Venue**
- **Nearby** places from photo GPS (HERE, re-ranked so arcades/bars beat the law offices in the same
  building), each tagged **TT** (already in TiltTrack), **V** (you've scored there), **PM** (on
  Pinball Map); then **Your Venues**.
- One search box finds **On TiltTrack** venues (any word, punctuation-insensitive) and **Places**
  (HERE), plus another user's home venue **only by its exact name** ("Private venue").
- **Continue requires a pick** (typing is only searching). "Skip — no venue" is explicit; "Not
  listed? Add …" opens name + address (HERE autocomplete) with a duplicate check.
- **No GPS in the photo?** An amber notice explains, and **"Use my current location"** is always
  offered — prominent when the photo is recent or its age is unknown, a quiet "Still there?" link when
  it's older. The device position is used only to find venues; **it is never stored as the score's
  location**.
- Tapping a venue picks it and advances. A pick that already carries a Pinball Map id uses it; one
  without — from search or the nearby list — is matched to Pinball Map exactly once, on pick, at its
  own coordinates, so the machine step can show the roster. Private venues are never matched.

**Step 3 — Details**
- **Machine:** the venue's Pinball Map roster (or a home venue's inventory) with AI-matching names on
  top; machines that left within 90 days are still offered ("Recently left") so late uploads work.
  "Not listed? Type the machine name" searches the Pinball Map catalog (typo-tolerant). A name not in
  the roster triggers a "Machine not found — save anyway?" confirm.
- **Score** (digit cells when partial), **Date & time**, **Type** (Casual / Tournament).
- A camera-recorded time is shown **read-only** ("From your photo") — see
  [Played-time provenance](#played-time-provenance-lock).

**Step 4 — Done**
- Score summary; any **new badges** earned (96px); **"Did my score count?"** — a one-line summary per
  challenge on that machine (see [Challenge fit](#did-my-score-count-challenge-fit)), with an "Edit
  played time" action only when a played-time rule excluded it and nothing counted.
- **Full-size photo** uploads in the background (Saving / Saved / Retry); tapping Done doesn't cancel it.
- **Post to Pinball Map** when the venue is PM-listed: connect a PM account once (username or email),
  then post. Failures are reported honestly (PM reports most failures as HTTP 200 — never trusted as
  success). Private venues carry no Pinball Map link, so there's nothing to post to.

### Editing a score — [1]

- One **edit dialog**, own scores (admins: any). Machine, venue, score, type, and played time (subject
  to the lock below).
- **Repair section**: a score with no venue gets a venue picker (search or add inline); a score at a
  venue gets per-score machine repair against the venue's roster (recommended match, user may
  override). Venue linkage is shown read-only if you can't repair the venue.
- A score **counted in a challenge is locked** — no edit, delete or machine repair (admins included);
  admins must void the challenge first.
- After a save that touches challenges, the dialog stays open on the challenge-fit summary.

### Played time and time zones — [1]

- **A score is shown on its venue's clock, not the reader's** — the time displayed equals what the
  camera recorded, for everyone. A zone label ("CDT") appears only when it differs from the reader's.
  Venue-less scores (and hidden-tier homes) fall back to the reader's zone. "added:" times stay
  reader-local.
- Photo EXIF times are zone-less wall clocks and are interpreted in the **venue's** zone, so uploading
  after travelling home is correct.
- Venues store an IANA time zone (never an offset).

#### Played-time provenance lock

- Each score records where its played time came from: **photo** (EXIF), **video** (metadata in the
  file), **manual** (typed, AI-read off the screen, a video's file-modified time, or none), or legacy
  (unknown, pre-2026-09-30).
- **A photo/video time can't be changed by the player — only by an admin**, who must give a reason
  (logged; the lock survives the correction). Manual and legacy times stay editable.
- The server vouches for a photo time with a signed, per-user, 24 h token from the upload; a
  mismatched or forged claim is refused.
- **Never in the future:** a played time more than 15 minutes after now (new) or after the score was
  logged (edit) is refused. Legacy future-dated rows never count in challenges or badges.
- Why: challenges compare played time with their window; a freely movable time could be moved into
  any window. Details: api-server CLAUDE.md "Played-time provenance".

### Score photos — [1]

- Every score keeps a small **thumbnail**. Since 2026-09-26 the **full-size photo** is stored too
  (Cloudflare R2, private): re-encoded in the browser (EXIF/GPS stripped for privacy, ≤4096 px JPEG),
  uploaded after the score saves, with a ~2000 px fallback if the full encode fails.
- **Viewer:** full-screen, pinch/drag/wheel zoom, swipe down to close. Visibility follows the score's
  visibility (a hidden home-venue score is a 404 to others). Thumbnail-only scores open the same viewer
  ("Thumbnail only").
- Owners can **add or replace** the full photo later from the viewer (replacing is refused on a
  challenge-locked score).
- Orphaned objects are swept weekly. Without R2 configured the feature is simply off.

### Machines (`/machines`) — [1] [2]

- Table of machines with scores (toggle to include unplayed): name + thumbnail, plays, last played,
  best score with the top scorer's `@username`. **ALL / MINE** scope.
- Search (machine or top scorer), manufacturer and year filters, sortable columns (default A→Z).
- Admins can edit / delete a machine.

### Machine detail (`/machines/:name`) — [1] [2]

- Top score card; **Compare** picker (All · Mine · Friends · a pod, plus "All others"); a venue
  filter; the score table.
- **Score trend chart** — "am I improving?":
  - **By Play** (play number), **By Visit** (a visit = plays within 6 h; best or average per visit),
    **Scatter** (every play on its date; 5-play average or every score; Linear / Log axis).
  - You in your color, friends/pods in theirs, everyone else in the "field" color.
  - Tap / click to pin a chart popup (works on iPhone); `@names` in it are links.
- **Venue Difficulty** — how a machine plays at each venue, player-normalized (only players who've
  played it at 2+ venues count): Much Easier … Much Harder, with a low-confidence flag. When there
  isn't enough data it now explains why instead of disappearing.

### Venues (`/venues`, `/venues/:id`) — [1] [2] [3]

- **List / Map** in one page. List: search, state filter, alphabetical; each card shows machine count
  **X/Y** (machines scored here / on Pinball Map), score count, PM link; a "Needs address" badge +
  filter on venues you can repair. Map: dark Esri basemap, one pin per venue, popup with latest score.
- **Venue page:** map thumbnail, "Machines here" modal (current + "Formerly here"), Compare picker over
  the scores, a By-machine view, Edit Venue (owner/admin), and the repair panel.
- **Machine history:** TiltTrack records machines arriving and leaving a Pinball Map venue from
  2026-07-01 on (observed lazily when the roster refreshes). Earlier history is not recoverable.

#### Home venues and privacy — [3]

- A user can mark a venue as their **residence**, with a privacy tier for its location:
  **full** (address shown), **city/state** (city centroid only), **hidden** (nothing locational, not
  even the time zone). Redaction is server-side, on every path that carries a location — including
  per-score coordinates.
- **Private venue** = residence or a restricted tier. Private venues:
  - get **no HERE / Pinball Map linkage** (either id resolves to an exact address); going private
    clears existing links;
  - are **never revealed by location** — not in nearby suggestions, searches or duplicate hints.
    Friends find one only by typing its **exact name**;
  - still accept scores from **anyone** (logging at a friend's house is the point);
  - keep an owner/admin-managed **machine inventory** (their roster, since PM can't be used); count
    shows as "N Machines";
  - have a **"Show my machines/scores publicly"** switch. Off → only the owner, admins and each
    score's own author see the inventory and scores there. Others don't get those scores anywhere
    (feed, machine pages, profiles, stats) — not just anonymized.
- Others' home venues still appear on the Venues page with minimal info ("Address hidden" / "City, ST").

#### Venue repair, merge and duplicates

- **Repair panel** (admin, owner, or the venue's creator) — three steps: **1** resolve in HERE (or,
  for an address-less venue, find it on Pinball Map / HERE or enter an address with a geocode
  preview), **2** link a Pinball Map location, **3** re-sync the venue's scores' machine names against
  the roster (exact → normalized → fuzzy; only normalized is pre-ticked). A non-admin only moves their
  own scores. Step 3 is gated on Pinball Map only.
- **Duplicate prevention:** creating a venue with the same normalized name within 250 m offers the
  existing one ("use this one instead") with a "Create it anyway" escape — never a hard block (a
  chain's other branch is real). A stranger's private venue matches only on exact name, anywhere.
- **Merge:** a candidate already held by another public venue offers **Merge into …**; preview, then
  one transaction moves scores, history and inventory and fills the target's gaps. Public↔private
  merges are refused; a non-admin can only move their own scores.

### Stats (`/stats`) — [1] [2]

- Signed in only. **Compare** picker (All · Mine · Friends · a pod, ± all others).
- **Totals** (plays, visits, machines with a score, venues played — each with a trend chart),
  **Monthly / Rates** (plays per visit, plays and visits this calendar month, scores submitted per
  day), **Charts** (most played machines, casual vs tournament play style), and an
  **Across TiltTrack** site-wide section.
- Site-wide trends come from a **daily snapshot** of 8 stats (GitHub Actions cron). Stat definitions
  are managed in Admin → Config → Stats (rename/describe; new stats are added in code, not the UI).

### Crew: friends and pods (`/crew`) — [2] [3]

**Friends** — mutual and consent-based:
- One asks, the other accepts or declines. A pair allows **3 declines** in total, after which the
  declined person can't ask again (shown as "unavailable"). Re-asking an unanswered request just
  refreshes it. Declines send no notification and nothing ever says "declined".
- Asking someone who already asked you = accepting. Unfriending (either side) deletes the pair and
  its history.
- Friends unlock challenges, the Friends compare scope, and a friend's "Challenge me on" machines.
- Friends share one global **friend color** (pale aqua) on charts.

**Pods** — private comparison groups:
- Any users (friends or not), created by you, with a name and a color. **Only the owner ever sees a
  pod** — its name, members, even that it exists. Members are never told; adding someone needs no
  request.
- Used as a Compare scope on Machine, Venue and Stats pages; pod members get small icons next to
  their names in feeds and profiles.

**Comparison scopes** (All · Mine · Friends · Pod, with "All others"): the client sends only "friends"
or a pod id; who's in it is resolved on the server. A scope only ever *narrows* what the viewer could
already see — being in someone's pod reveals nothing a home-venue switch hides.

### Challenges — [2] [3]

The play-together feature: friends agree on a machine, a type and a window, then each goes and plays
wherever they are. Built for "wastelands": the machine counts anywhere unless the challenger locks a
venue.

**Setup**
- **Friends only**: 1:1, or a **group of up to 8 players** (you + up to 7 friends; invitees needn't
  be friends with each other).
- **Types:**

  | Type | Label | Winner |
  |------|-------|--------|
  | `high_score` | High score | Best counting score at the deadline |
  | `race` | Beat my score / First to X | First to **strictly beat** the target (the challenger's best, or a picked number) wins on the spot |
  | `most_improved` | Most improved | Biggest % gain over your own best from before the challenge (baseline frozen at start; no baseline → can't join) |
  | `average` | Best average | Highest average of all counting scores, with at least N plays (N = 3–10) |

- **Match mode:** **game** (any model of the title — Pro/Premium/LE, via the OPDB group) or **exact**
  model.
- **Venue lock** (optional): the venue must actually have the machine (its Pinball Map roster, history,
  inventory, or a score there).
- **Window:** starts now, at a chosen time (≤ 30 days out), or **when everyone has answered**; runs
  1 hour to 90 days.

**What counts** — the integrity rules:
- Matching machine (per match mode), the locked venue if any, **has a photo** (the thumbnail counts),
  **both played time and logged time inside the window**, played time not in the future, and the
  score must be **visible to every other participant**.
- A counting score is **locked** against edit/delete (admins included) for good.

**Lifecycle**
- Invitees accept, decline (**"can't reach it"** or **"no thanks"**), or counter.
- **Groups:** it proceeds once at least one invitee accepts. When nobody's left pending it starts; the
  challenger can **"Start with who's in"** early (unanswered players are marked **missed**). An
  accepted player may **back out** before it starts. A fixed start begins with whoever accepted.
- **Counter-offers are proposals to the challenger** (1:1 and groups): a suggestion doesn't end the
  original. The challenger either **takes it for everyone** (the original is replaced, everyone is
  re-invited and re-accepts) or **keeps hers** (the proposer stays out). Proposals lapse if the
  original starts, is cancelled, expires, or their own window passes. One reminder after 24 h.
- Participants can forfeit after accepting; the challenger can cancel before it resolves.
- **Outcomes:** win / loss / tie / forfeit / no-show / **abandoned**. A race nobody beat, an average
  nobody qualified for, or **any challenge where nobody posted** is abandoned — worth nothing for
  anyone ("you signed up and were supposed to play"). The old "void" result is retired.
- Resolution happens lazily on reads, on every score upload, and in a daily sweep (which also sends
  "ending soon" notices).

**Records** (profile card, signed in): wins / losses / ties / abandoned, current and best streaks
(win and loss; anything but a win breaks a win streak). Below 1st in a group is a loss. **Head-to-head
is pairwise by rank**. Someone else's record shows their totals plus head-to-head against you only.

**Recommendations** — what to challenge a friend on, from three levels:
1. **"Challenge me on"** — up to 3 machines the friend picked (shown on their profile to friends).
2. Machines at their **challenge locations** — venues they can get to (seeded once from venues
   they've visited twice in 180 days, plus their home if inventoried; editable after).
3. Machines they've **played in the last 60 days**.

Ranked by whether *you* can reach it too, then whether you have a score. For groups, ranked by how
many of the friends can reach each machine. A friend's home appears as "at @name's", never by name.
**Recommendations make zero Pinball Map calls** (cached rosters only).

**Challenge locations** can include a place nobody has logged at yet: **Near me** (device location,
on tap only) or a Pinball Map / HERE place from search. Adding one creates the venue, matches and
links it to Pinball Map once, and caches its roster — reusing the Add Score endpoints, bounded to about
2 Pinball Map calls per added place.

#### "Did my score count?" (challenge fit)

After saving or editing a score, the player sees how it fared in each of their challenges on that
machine: counted, not yet started, or the **first** reason it didn't count — wrong venue, no photo,
played before start / after end, logged before start / after end, not visible to the other players,
or a played time in the future. Identical lines are grouped ("Counts in 4 of your challenges").

### Badges — [1] [2]

Public achievements on every profile.
- **Kinds:** **metric** (a count from a metric library ≥ N — scores posted, distinct machines, distinct
  venues, sign-in days, friend-request facts, and challenge facts), **rule** (declarative: date / day
  of week / time in the venue's zone, posted within N hours, machine or OPDB group, venue / city /
  state, min score, score type, photo, count + distinct), **manual** (granted by an admin).
- **Lifecycle:** draft → live → retired. **Retroactive** badges backfill everyone who already
  qualifies at go-live (or when retroactive is switched on later, or via "Backfill now"); forward-only
  ones count only from go-live. **Nothing is ever revoked automatically.**
- Awarded on score upload, friend actions, sign-in, challenge results / declines / counters /
  back-outs, and a daily sweep. A played time in the future never counts toward any badge.
- **Series** (tier ladders, e.g. Scores: 1 → 10 → 100 → 1,000): one color for every tier, one metric
  per series, a `{N}` description template ("Posted {N} scores."), and "Add tier" suggests the next
  threshold. Shelf and catalog follow the admin's order; a series shows once, as its highest earned
  tier with pips.
- **Profile shelf** (48px, "View all" past 12, tap for detail and ladder); **`/badges` catalog** with
  locked (not-yet-earned) badges and availability windows; a toast and a notification when earned. A
  challenge-earned badge links to its challenge for that challenge's participants only.
- Badge art: an uploaded image, or a lucide icon on a color disc.
- Seeded challenge badges (wins, losses, streaks, ties, abandoned) exist as **drafts** — which go live
  is Will's call.

### Notifications (`/notifications`) — [2] [3]

In-app only (bell with unread count, polled). Kinds: friend request / accepted; badge earned; and the
challenge lifecycle — received, accepted, declined, countered (proposal), counter accepted / rejected,
moved, started, missed, cancelled, voided, opponent scored (one notice per score, however many
challenges it counts in), ending soon, result. "Clear all"; read notices are deleted after 30 days,
unread ones are kept.

### User profile (`/users/:username`) — [1] [2]

- Display name, `@username`, score count, pod icons (the viewer's pods only).
- **Add friend** / request status, and **Challenge** for friends.
- **Challenge record** card (signed in; after a finished challenge); your own **"Challenge me on"**
  editor, or a friend's chips.
- **Badge shelf** (public).
- Score list: machine thumbnail, machine, played time (venue clock), venue link, type, score, photo
  button. Respects home-venue visibility.

### Admin area

Admins only (server-enforced on every admin route). Every action confirms first, takes an optional
reason and is recorded in the activity log.

| Page | What it does |
|------|--------------|
| **Overview** | People / play / system cards; last cron runs |
| **Users** / user detail | Clerk sign-in status, activity; **disable / re-enable** (app lockout + Clerk ban) |
| **Activity** | The append-only activity log, filterable by user, category and type |
| **Crew** | Friendships (remove), challenges (**void** — releases score locks, drops out of records), notifications |
| **Scores** | Delete a score (refused while challenge-locked), delete full photo / thumbnail; correct a locked played time (reason required) |
| **Badges** | Editor (kind, metric/rule, window, retroactive, image, series), preview, go live, retire, backfill, grant / revoke, drag-to-reorder |
| **Health** | Database (Neon storage), API server, external services, environment variables, Drizzle Studio launcher; reads stored Pinball Map state, never calls it |
| **Config** | Tabs: **Theme** (brand colors — per browser), **Data retention**, **Photo storage** (orphan sweep, dry run first), **Stats** (stat definitions + recent history) |

**Activity-log retention** has three tiers — high-volume (sign-ins, notifications, cron heartbeats;
default 90 days), standard (scores, social, challenges, repairs; 365 days) and admin (admin actions,
sign-ups; forever). Each tier takes forever / off (not recorded at all) / 1–36500 days. Turning the
admin tier off is itself audited. Purged daily.

---

## Cross-cutting rules

### Privacy
- Location privacy is enforced **server-side** on every path — venue rows, per-score coordinates,
  linkage ids, rosters and time zones. See [Home venues](#home-venues-and-privacy--3).
- Any endpoint that takes coordinates must keep others' private venues out of its results.
- Pod membership never leaves the server; friend lists are resolved server-side.
- Full-size photos have EXIF stripped; R2 keys, Pinball Map tokens and emails are never sent to the
  browser.

### Pinball Map etiquette (standing rule)
Pinball Map's maintainers granted Will a personal API token; **TiltTrack must never hammer their
API**. In product terms: every Pinball Map read is cached (rosters 6 h, catalog 24 h) and refreshed per
*venue*, not per page view; nothing calls Pinball Map from the browser or in a loop; every
Pinball-Map-touching action requires sign-in and is rate-limited per user; failures are cached, not
retried per request; features estimate worst-case calls/day before shipping. Displayed Pinball Map
data links back to that location on pinballmap.com (a licence condition). The full rule is in the
[root CLAUDE.md](./CLAUDE.md#pinball-map-api--standing-rule).

---

## Data Model

Source of truth: [`lib/db/src/schema.ts`](./lib/db/src/schema.ts). Tables by area:

| Area | Tables | Notes |
|------|--------|-------|
| People | `users` | Clerk id, username, display name, role (`admin`/`user`), Pinball Map connection, disabled state |
| Scores | `scores` | machine, venue (+ name snapshot), score (bigint), type casual/tournament, played/created times (naive UTC), per-score GPS, thumbnail, full-photo key/size, played-time source + admin correction |
| Machines | `machines` | unique name (Pinball Map's when known), OPDB/IPDB ids, manufacturer, year, image |
| Venues | `venues`, `venue_machine_history`, `venue_inventory` | HERE id (unique), Pinball Map id, owner / creator, residence + privacy tier, city centroid, IANA time zone, show-publicly switch |
| Pinball Map caches | `pm_location_cache`, `pm_catalog_cache` | rosters + location fields; the machine catalog |
| Stats | `stats`, `stat_history` | stat definitions; one row per stat per New York day |
| Social | `friendships`, `pods`, `pod_members`, `notifications` | one friendship row per pair with decline count; pods private to the owner |
| Challenges | `challenges`, `challenge_participants`, `challenge_scores`, `user_challenge_machines`, `user_challenge_venues` | proposals are challenge rows; `challenge_scores` is the lock |
| Badges | `badges`, `badge_series`, `user_badges`, `user_metric_marks` | image stored as WebP bytea; marks keep metric facts safe from log retention |
| Admin | `activity_events`, `app_settings` | append-only log; retention + sweep state |

---

## Tech Stack

### Monorepo (pnpm workspaces)
```
/
├── artifacts/
│   ├── pinball-tracker/    # React frontend (Vercel)
│   └── api-server/         # Express backend (Render) + numbered migrate*.ts scripts
├── lib/
│   └── db/                 # @workspace/db — Drizzle schema + DB client
└── .github/workflows/      # daily stat snapshot, daily challenge sweep + housekeeping, keepalive (disabled)
```

### Frontend (`artifacts/pinball-tracker`)
React + Vite + TypeScript · Wouter · TanStack Query · React Hook Form + Zod · Tailwind CSS · Radix UI
· Framer Motion · Lucide · Clerk · Leaflet / react-leaflet (Esri Dark Gray Canvas tiles, no key) ·
Recharts · date-fns (+ @date-fns/tz) · exifr + heic2any (in-browser EXIF and HEIC).

### Backend (`artifacts/api-server`)
Express (TypeScript via `tsx`) · Drizzle ORM + postgres.js on **Neon PostgreSQL** · Clerk (+ Svix-signed
webhook) · **Anthropic Claude** (`claude-sonnet-4-6`) for score reading · sharp (crops, badge images) ·
multer · **HERE** (browse, autosuggest, geocode, lookup, time zones) · **Pinball Map** (rosters,
catalog, score posting — all via one guarded client) · **Cloudflare R2** via the AWS S3 SDK · node-cron
(backup only; the real schedules are GitHub Actions).

### Data flow — Add Score
```
Browser: pick photo(s)/video → read EXIF (GPS, time) → HEIC→JPEG → downscale → sharpest video frames
  → POST /api/upload  → Claude reads every display (template + x's), crop pass if needed
                      → nearby venues (HERE + Pinball Map, cached) → signed played-time token
  → user picks venue (search / nearby / current location) → Pinball Map match on pick
  → user picks machine (roster / inventory / catalog), fills x's, confirms time
  → POST /api/scores  → venue upsert (+ PM link), machine upsert, provenance checks
                      → challenge sync + lock, challenge-fit summary, badge awards
  → background: full-size JPEG → presigned PUT to R2 → confirm
  → optional: post to Pinball Map
```

---

## Design System

### Visual identity
- **Name:** TILT**TRACK**, "TRACK" in the primary color. Trophy icon; the flippers `PinballIcon` for
  machines everywhere.
- **Vibe:** arcade / backglass — dark, high-contrast, glowing accents.

### Colors
- Near-black background, slightly lighter card surfaces, subtle white/10 borders.
- **Entity colors** (theme keys, editable in Admin → Config → Theme, stored per browser):
  **score** (primary pink), **machine** (blue), **venue** (lime), **username** (yellow — "you" on
  charts), **field** (purple — everyone else), **friend** (pale aqua). Pods each carry an owner-chosen
  color from a palette kept clear of the fixed theme colors.
- Chart colors were validated for color-vision safety, not eyeballed.

### Typography
- **Inter** (400/500/600/700). Headings uppercase, bold, wide tracking. Scores large, bold, pink,
  always whole numbers unless abbreviated (K/M).

### Layout
- `max-w-7xl` content; sticky blurred header on desktop, **bottom tab bar** on phones.
- Mobile-first: long machine / venue / user names wrap rather than overflow; dialogs scroll within
  90vh.

### Key UI patterns
- Sortable columns only for comparable data; otherwise search + filter chips.
- The **TT / V / PM** venue tags, the house icon for home venues, amber x's for unread digits.
- One shared component per job: one edit-score dialog, one duplicate-venue prompt, one badge renderer,
  one photo viewer.
- Confirm before anything destructive; inline errors for things to fix; toasts for news.

---

## Environment & external services

Setup, env files and deploy steps: [root CLAUDE.md](./CLAUDE.md) and the deploy skill
(`.claude/skills/deploy/SKILL.md`).

| Service | Purpose | Env |
|---------|---------|-----|
| Clerk | Auth (email/password, Google), bans, sign-in webhook | `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`; frontend `VITE_CLERK_PUBLISHABLE_KEY` |
| Anthropic | Score reading | `ANTHROPIC_API_KEY` |
| HERE | Places, geocoding, time zones | `HERE_API_KEY` |
| Pinball Map | Rosters, catalog, score posting | `PINBALL_MAP_API_TOKEN` (required on every endpoint) |
| Neon PostgreSQL | Database | `DATABASE_URL` |
| Cloudflare R2 | Full-size photos (optional) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| GitHub Actions | Daily cron triggers | `CRON_SECRET`; `GITHUB_TOKEN` for the health page |
| Vercel / Render | Hosting | frontend `VITE_API_URL` → Render |

Foursquare, listed in the original spec, was never used.

---

## Planned, changed, or not built

**Changed from the original spec**
- Routes: Map folded into Venues; Friends/Pods/Challenges live under Crew; `/stats` needs sign-in;
  the app is behind a welcome/access gate.
- Machines page is an alphabetical, sortable table with filters, not a "ranked by personal best" list.
- The Add Score flow is venue-first with required venue picks, multi-photo/video input and partial
  reads; the "Suggested machines / AI read banner" design evolved into the roster picker described
  above.
- Played times are shown on the venue's clock and camera times are locked.
- The shared `lib/api-spec` (OpenAPI) and `lib/api-client-react` (Orval) packages were never built;
  the frontend calls the API through a hand-written client (`src/lib/api.ts`).
- The hamburger menu was replaced by a bottom tab bar; the Add Score step indicator has 4 steps.
- Challenge "void" (nobody played) was replaced by **abandoned**; counter-offers became proposals.

**Not built yet** (ideas on record)
- Push / email notifications (in-app only today); revenge nudges, rivalry cards.
- Follow a venue + machine for new-score notices.
- Per-machine achievements ("did you get Tiger Multiball?").
- Chart ideas: percentile rank over time; you vs. the running all-time high.
- Pod visibility to members (no column yet; pods are owner-only).
- Moving `scores.played_at` / `created_at` to `timestamptz` (correct today only because production runs
  in UTC).
- Server-side (DB-backed) theme colors — they're per browser.

**Out of scope:** live, in-person tournament bracket management.
