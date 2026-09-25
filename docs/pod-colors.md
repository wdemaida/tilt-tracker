# Pod colors: design note (spike, step 1 of Pods)

Each pod stores one owner-chosen hex (the future `pods.color`). Everything that shows a pod's
members (chart lines and dots, name labels, chips) renders in that color. This spike checks that
an unbounded set of runtime colors fits the current theming, and adds the helper that step 2+ will use.

## How colors work today (verified 2026-09-25)

- **Fixed keys.** `DEFAULT_COLORS` in `src/lib/theme.tsx` holds `primary`, `machine`, `venue`,
  `username` and `field`, stored as HSL channel strings (`'270 91% 65%'`). `ThemeProvider` writes
  them to `document.documentElement` as `--<key>`. `tailwind.config.ts` maps each one to
  `hsl(var(--key) / <alpha-value>)`, which is why `text-venue` and `bg-username/20` work.
- **Admin > Config** (`AdminConfigPage.tsx`) is a native `<input type="color">` per key that calls
  `setColor(key, hex)` (hex converted to HSL). The only persistence is **`localStorage`
  (`tilttrack-theme`)**. There's no DB row and no API.
- **"All other players" purple** is the `field` key. Charts pass `"hsl(var(--field))"` straight to
  Recharts `stroke`/`fill`. That works because the SVG sits under `<html>`, where the var is set.
- **Chaos mode** (`MachinePage.tsx`) does split scores into one `<Line>` per user, but
  `chaosLineColor(u)` gives every user except you the same `--field` color (at 0.5 opacity). So
  there's a precedent for per-user *series*, not for per-user *colors*. The only multi-color chart
  precedent is `VENUE_COLORS`, a hardcoded array of 6 hex values for the venue-comparison mode.
- **No light theme.** `:root` in `index.css` defines a single dark palette, there's no
  `prefers-color-scheme` or `dark:` usage, and pages hardcode `text-white` and `border-white/10`.

## Things that contradict the brief

1. **Admin > Config isn't global.** It saves to the admin's own browser only, so no other user
   sees the change. A global `friend` key "configured in Admin > Config like the existing keys"
   would have the same limitation. A key that's global for real needs a server-side setting
   (a `site_config` row plus a public GET), and `ThemeProvider` would then have to layer it.
   This probably applies to the existing keys too, which may not be what Will thinks they do.
2. **Chaos mode doesn't color users individually** (see above). All non-self lines are purple.
3. **There's no light theme to be readable in.** The helper takes a `surface` argument and handles
   both directions, and the demo shows a light panel. In the app itself, only the dark card is live.

## Approach

Utility classes can't be generated for arbitrary colors at build time. The trick is the same one
the theme already uses: Tailwind classes that point at CSS variables, with the variables scoped
per element instead of set on `:root`.

- `tailwind.config.ts` gets three static colors: `pod`, `pod-text` and `pod-on`, each
  `hsl(var(--pod…) / <alpha-value>)`.
- `podColorVars(hex)` returns an inline `style` that sets those vars on one wrapper element.
  Everything inside can use ordinary classes (`bg-pod/15 border-pod/40 text-pod-text`), and two
  sibling wrappers can show two different pods. Opacity modifiers keep working because the values
  are HSL channels, the same as the existing keys.
- **Recharts gets plain hex** from `podColorTokens(hex).graphic`. A single chart can hold several
  pods, so one scoped var can't serve every `<Line>`. It's the same pattern as `VENUE_COLORS`.

## API (`src/lib/podColor.ts`)

| Export | Purpose |
|---|---|
| `POD_PALETTE` | 6 default hex colors, in assignment order |
| `nextPodColor(used[])` | First palette color not already used by the user's pods; cycles once all are taken |
| `normalizePodColor(input)` | Returns `#rrggbb` lowercase, or `null`. Accepts `#abc`, `abc` and any case. Rejects named colors, alpha and `rgb()` |
| `isValidPodColor(input)` | Boolean form of the above. **The server must run the same check** before writing `pods.color` |
| `podColorTokens(hex, surface?)` | `{ base, graphic, text, tint, onGraphic }`, all opaque hex |
| `podColorVars(hex, surface?)` | Inline style setting `--pod`, `--pod-text` and `--pod-on` |
| `usePodColor(hex, surface?)` | Memoized `{ tokens, style }` |
| `nearReservedColor(hex, {name: hex})` | Name of a reserved color within ΔE 15, for a picker warning ("looks like the You color") |
| `contrastRatio`, `colorDistance` | WCAG ratio and OKLab ΔE×100 |
| `DARK_SURFACE` / `LIGHT_SURFACE` | `#111113` (the app's `--card`) and `#ffffff` |

`src/components/PodChip.tsx` is a reusable pill (`color`, `solid?`, `surface?`). Invalid stored
colors fall back to palette[0] instead of throwing, so one bad row can't blank a chart.

## Contrast strategy

The stored hex is the owner's intent. What gets rendered is derived from it, keeping the hue and
saturation and moving only the HSL lightness, away from the surface:

- `graphic`: at least 3:1 against the surface (WCAG non-text contrast). Use it for lines, dots,
  borders, legend marks and solid chip fills.
- `tint`: `graphic` at 15% alpha, composited onto the surface.
- `text`: at least 4.5:1 against the **tint**, so a label stays readable on its own chip. In the
  code the targets are 3.1 and 4.6, to absorb integer-HSL rounding in the CSS vars.
- `onGraphic`: black or white, whichever has more contrast on a solid `graphic` fill.

On a dark surface this lightens, so navy `#1e3a8a` renders as `#2e59d1` for graphics and `#6484dd`
for text. On a light surface it darkens, so butter `#fef08a` renders as `#a28f02` / `#746701`.
Palette colors mostly pass through unchanged on dark.

**Palette validation.** I ran the dataviz skill's validator with `--surface #111113`. Every slot
clears CVD ΔE ≥ 8 and normal-vision ΔE ≥ 15 against `username` yellow and `field` purple, with all
pairs checked, since those three share a chart. Adjacent slots pass the same checks, and the first
three pass with all pairs checked. Yellow and violet are left out of the palette because they'd
collide with "you" and "all other players". The validator's *lightness band* check fails for the
blue and teal, but it also fails the app's own neon keys. The band is tuned for a different house
style, so I treated it as out of scope. User-picked colors aren't validated for CVD. Instead,
`nearReservedColor` lets the picker warn about them.

## Where the future global `friend` key fits

`friend` is **one fixed color**, so it belongs with the existing keys: an entry in `DEFAULT_COLORS`
and `COLOR_CONFIG`, a `--friend` var, and a `friend` Tailwind color, handled exactly like `field`.
That's separate from pods. Pod colors are per-pod DB data applied through `podColorVars`. If
`friend` needs a readable text shade too, `podColorTokens(hslToHex(colors.friend))` works on it
unchanged. Keep in mind contradiction 1: as things stand it would be per-browser, not global.

Precedence to decide in step 2: when a user is both a friend and a pod member and a pod is
selected, the pod color should probably win, because it's the comparison the user asked for.

## Demo (dev-only, delete later)

`src/dev/PodColorsDemo.tsx` is routed at **`/dev/pod-colors`** only when `import.meta.env.DEV`
(a lazy import in `App.tsx`). A production build drops it, which I confirmed by grepping `dist`.
It shows chips, solid chips, labelled rows, a Recharts line chart and a scatter for 5 sample
colors on dark and light surfaces, plus a hex-input playground. To remove it, delete the file and
the `PodColorsDemo` lines in `App.tsx`.
