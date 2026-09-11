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
