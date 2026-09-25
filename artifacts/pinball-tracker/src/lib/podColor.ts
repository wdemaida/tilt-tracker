/**
 * Runtime colors for pods (owner-chosen hex per pod, stored in the DB).
 *
 * The fixed theme keys (primary/machine/venue/username/field) are CSS vars on
 * <html> with matching Tailwind colors. Pods can't work that way — there are any
 * number of them, each with its own color — so this module derives a full set of
 * readable shades from ONE stored hex and hands them out two ways:
 *
 *  - `podColorVars(hex)` → a `style` object that sets `--pod`, `--pod-text` and
 *    `--pod-on` on a wrapper element. Inside it, the static Tailwind colors
 *    `pod`, `pod-text` and `pod-on` (tailwind.config.ts) resolve to that pod —
 *    so `bg-pod/15 border-pod/40 text-pod-text` just works, per element.
 *  - `podColorTokens(hex)` → plain hex strings for Recharts, which takes
 *    stroke/fill props directly. Several pods can share one chart, so a single
 *    scoped CSS var can't serve all of them there — pass `tokens.graphic`.
 *
 * Contrast: the stored hex is only the owner's *intent*. `graphic` is nudged in
 * lightness until it clears 3:1 against the surface (WCAG non-text contrast, for
 * lines/dots/borders); `text` until it clears 4.5:1 against the pod's own tint
 * composited on the surface (so a chip's label is readable on the chip). Dark
 * surfaces push lighter, light surfaces push darker. Hue is kept, so the pod
 * still looks like the color its owner picked.
 */
import { useMemo, type CSSProperties } from 'react';
import { hexToHsl } from './theme';

// ── palette ────────────────────────────────────────────────────────────────

/**
 * Default colors for new pods, in assignment order. Validated with the dataviz
 * skill's validator on the app's dark card surface (#111113), alongside the
 * reserved `username` yellow and `field` purple: every slot clears CVD ΔE ≥ 8
 * and normal-vision ΔE ≥ 15 against both, adjacent slots clear the same
 * floors, and the first three clear them all-pairs. Yellow and violet are left
 * out on purpose — they'd collide with "you" and "all other players".
 */
export const POD_PALETTE = [
  '#60a5fa', // blue
  '#d95926', // orange
  '#2dd4bf', // teal
  '#d55181', // magenta
  '#008300', // green
  '#e66767', // red
] as const;

/** First palette color not already used by one of the user's pods; cycles once all are taken. */
export function nextPodColor(usedColors: readonly string[]): string {
  const used = new Set(usedColors.map(c => normalizePodColor(c)).filter(Boolean));
  const free = POD_PALETTE.find(c => !used.has(c));
  return free ?? POD_PALETTE[usedColors.length % POD_PALETTE.length];
}

// ── validation ─────────────────────────────────────────────────────────────

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Canonical form of user hex input: `#rrggbb`, lowercase. Accepts `#abc`,
 * `abc`, `#AABBCC`, surrounding whitespace. Returns null for anything else
 * (named colors, rgb(), alpha, 4/8-digit hex). Store only what this returns —
 * the server should run the same check before writing `pods.color`.
 */
export function normalizePodColor(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const m = input.trim().match(HEX_RE);
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return `#${h}`;
}

export function isValidPodColor(input: string | null | undefined): boolean {
  return normalizePodColor(input) !== null;
}

// ── color math (sRGB / WCAG / OKLab) ───────────────────────────────────────

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as RGB;
}

function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function channelToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(channelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHslNum([r, g, b]: RGB): [number, number, number] {
  const [h, s, l] = hexToHsl(rgbToHex([r, g, b])).match(/[\d.]+/g)!.map(Number);
  return [h, s, l];
}

function hslNumToHex(h: number, s: number, l: number): string {
  const sat = s / 100, lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lig - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** Alpha-composite `fg` at `alpha` over `bg`. */
function mix(fg: string, bg: string, alpha: number): string {
  const f = hexToRgb(fg), b = hexToRgb(bg);
  return rgbToHex([0, 1, 2].map(i => f[i] * alpha + b[i] * (1 - alpha)) as RGB);
}

/**
 * Move `hex` in HSL lightness (hue and saturation kept) away from `against`
 * until it reaches `target` contrast, or hits white/black trying.
 */
function ensureContrast(hex: string, against: string, target: number): string {
  if (contrastRatio(hex, against) >= target) return hex;
  const [h, s, l] = rgbToHslNum(hexToRgb(hex));
  const step = luminance(hexToRgb(against)) < 0.18 ? 1 : -1; // dark surface → lighten
  for (let next = l + step; next >= 0 && next <= 100; next += step) {
    const candidate = hslNumToHex(h, s, next);
    if (contrastRatio(candidate, against) >= target) return candidate;
  }
  return step > 0 ? '#ffffff' : '#000000';
}

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(channelToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Perceptual distance (OKLab ΔE ×100 — same scale as the dataviz validator). */
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = toOklab(a), [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

/**
 * Name of the first reserved color `hex` is too close to (normal-vision
 * ΔE < 15), else null. For the picker: warn "looks like the 'You' color".
 * Pass the live theme values, e.g. `{ You: hslToHex(colors.username) }`.
 */
export function nearReservedColor(hex: string, reserved: Record<string, string>): string | null {
  const c = normalizePodColor(hex);
  if (!c) return null;
  for (const [name, r] of Object.entries(reserved)) {
    const rc = normalizePodColor(r);
    if (rc && colorDistance(c, rc) < 15) return name;
  }
  return null;
}

// ── tokens ─────────────────────────────────────────────────────────────────

/** The app's card surface (`--card`, hsl 240 10% 7%). The only surface the app has today. */
export const DARK_SURFACE = '#111113';
/** For a future light theme, and for the dev demo's light panel. */
export const LIGHT_SURFACE = '#ffffff';

/** Alpha of the chip/background tint; `bg-pod/15` in Tailwind terms. */
export const POD_TINT_ALPHA = 0.15;

export interface PodColorTokens {
  /** The stored color, normalized. Use for swatches/pickers only — not guaranteed readable. */
  base: string;
  /** ≥ 3:1 vs surface. Chart strokes/fills, borders, legend marks, solid chip fill. */
  graphic: string;
  /** ≥ 4.5:1 vs the tint over the surface. Names/labels in the pod's color. */
  text: string;
  /** `graphic` at POD_TINT_ALPHA, pre-composited on the surface (opaque hex). */
  tint: string;
  /** Black or white — whichever reads better on a solid `graphic` fill. */
  onGraphic: string;
}

const FALLBACK_COLOR = POD_PALETTE[0];

/**
 * Derive every shade a pod needs from its stored hex. Invalid input falls back
 * to the first palette color rather than throwing — a bad row shouldn't blank
 * a chart. `surface` defaults to the app's dark card.
 */
export function podColorTokens(hex: string, surface: string = DARK_SURFACE): PodColorTokens {
  const base = normalizePodColor(hex) ?? FALLBACK_COLOR;
  // Small margins over 3 / 4.5: podColorVars re-rounds to integer HSL channels.
  const graphic = ensureContrast(base, surface, 3.1);
  const tint = mix(graphic, surface, POD_TINT_ALPHA);
  const text = ensureContrast(base, tint, 4.6);
  const onGraphic = contrastRatio('#ffffff', graphic) >= contrastRatio('#09090b', graphic) ? '#ffffff' : '#09090b';
  return { base, graphic, text, tint, onGraphic };
}

/**
 * Inline style that scopes one pod's color to an element and its children.
 * Values are HSL channels, matching the existing theme vars, so Tailwind's
 * `<alpha-value>` works: `bg-pod/15`, `border-pod/40`, `text-pod-text`,
 * `bg-pod text-pod-on`.
 */
export function podColorVars(hex: string, surface: string = DARK_SURFACE): CSSProperties {
  const t = podColorTokens(hex, surface);
  return {
    '--pod': hexToHsl(t.graphic),
    '--pod-text': hexToHsl(t.text),
    '--pod-on': hexToHsl(t.onGraphic),
  } as CSSProperties;
}

/** Memoized tokens + scoped style for one pod. */
export function usePodColor(hex: string, surface: string = DARK_SURFACE) {
  return useMemo(
    () => ({ tokens: podColorTokens(hex, surface), style: podColorVars(hex, surface) }),
    [hex, surface],
  );
}
