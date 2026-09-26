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
| `nearReservedColor(hex, {name: hex})` | Name of a reserved color within ΔE 15, for a picker warning ("looks like the color TiltTrack uses for machine names") |
| `reservedThemeColors(colors)` | The five fixed keys from the live theme, named for that warning — what the picker passes to `nearReservedColor` |
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

**Palette validation (revised 2026-09-25).** The first palette only checked itself against
`username` and `field`, and its blue `#60a5fa` turned out to sit on top of the blue `machine` labels
(OKLab ΔE 6 — the owner spotted it on a pod called "Cape boys"). The palette is now checked against
**all five** fixed keys at their default values — primary `#dd47eb`, machine `#3ebaf4`, venue
`#82cb15`, username `#facc14`, field `#a655f7` — using the dataviz skill's validator math (OKLab
ΔE×100, Machado 2009 protan/deutan simulation) on the dark card `#111113`, for both the swatch
(`graphic`, identical to the stored hex for all six) and the lightened `text` shade.

Those five keys take most of the hue wheel (yellow, lime, sky blue, violet, magenta), so the
palette uses lightness as well as hue: vivid orange / jade / crimson, a pale lavender, and a deep
ochre and plum. Assignment order puts the three most separated colors first.

| # | Hex | Name | vs primary | vs machine | vs venue | vs username | vs field | contrast on card |
|---|---|---|---|---|---|---|---|---|
| 1 | `#fe7b32` | orange | 30 / 28 / 48 | 31 / 26 / 53 | 26 / **3** / 54 | 19 / 14 / 32 | 34 / 33 / 51 | 7.3 |
| 2 | `#e7b6fe` | lavender | 23 / 19 / 22 | 19 / **4** / 37 | 32 / 23 / 72 | 27 / 25 / 59 | 25 / 25 / 25 | 11.2 |
| 3 | `#1c9870` | jade | 38 / 17 / 49 | 20 / 19 / 36 | 20 / 19 / 26 | 31 / 23 / 42 | 33 / 22 / 47 | 5.2 |
| 4 | `#fa0246` | crimson | 24 / 24 / 31 | 39 / 24 / 62 | 40 / 13 / 77 | 35 / 24 / 56 | 30 / 28 / 36 | 4.6 |
| 5 | `#8c6d08` | ochre | 35 / 27 / 64 | 31 / 29 / 55 | 26 / 22 / 34 | 32 / 31 / 30 | 34 / 30 / 63 | 3.9 |
| 6 | `#9d5072` | plum | 22 / 18 / 23 | 30 / 23 / 55 | 37 / 28 / 71 | 39 / 38 / 61 | 20 / 21 / 24 | 3.4 |

Cells are normal-vision ΔE / CVD ΔE (min of protan, deutan) / CIEDE2000. Floors: normal ≥ 15 is
the validator's hard gate, CVD ≥ 8 its target.

- **vs fixed keys:** normal ΔE ≥ 18.9 everywhere (text shades ≥ 18.0; CIEDE2000 ≥ 20). CVD ≥ 13.6
  against `username` and `field`, the two that share every pod chart. Two CVD pairs are low and
  accepted: orange vs venue lime (3.1) and lavender vs machine blue (3.9). Neither pair meets as
  two chart series. Venue and machine appear as label text, and those labels are never the only
  thing identifying a pod.
- **Between slots:** all pairs normal ΔE ≥ 15.4 and CVD ≥ 7.1. Adjacent slots have CVD ≥ 8.3, and
  so do slots 1–3 pairwise, except orange↔jade at 7.6 (normal 29).
- **Text shades** (`podColorTokens().text`, lightened to 4.5:1 on the chip tint) are jade `#1d9f76`,
  crimson `#fd2b63`, ochre `#a9840a` and plum `#b6728f`. Orange and lavender pass through unchanged.
- **Lightness band:** the validator's dark band (OKLCH L 0.48–0.67) fails orange (0.72) and
  lavender (0.84). It also fails the app's own keys (username 0.86, machine 0.74). A search limited
  to the band found no 6-color set that clears the normal-vision floor against the five keys (its
  best was about 12), so the band is out of scope here, as it was for the first palette.
- **Existing pods keep their stored color** (no migration). A pod on the old blue or teal now gets
  the picker warning ("…uses for machine names") when its owner opens the color picker.

User-picked colors aren't validated for CVD. `nearReservedColor` (normal ΔE < 15) warns against
all five fixed keys, reading the live theme values through `reservedThemeColors`.

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
