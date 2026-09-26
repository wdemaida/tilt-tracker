import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, MutableRefObject } from 'react';
import { usePlotArea, useXAxisScale, useYAxisScale } from 'recharts';

// Click/tap-to-pin chart popups, for mouse and touch alike.
//
// Recharts tooltips follow the pointer and are `pointer-events: none`, so an @username inside one
// can't be clicked or tapped. So a click on the chart (a mouse click or a finger tap: one onClick,
// whatever the pointer) is hit-tested here, against point positions read from the chart's own
// scales, and the popup is an ordinary absolutely-positioned element we render and control. It stays
// until × is clicked, another point is clicked (it moves there), empty chart area is clicked, Escape
// is pressed, or the chart's mode/data changes (it closes).
//
// Why not Recharts' `trigger="click"` (the first attempt): for item charts (scatter) it pins only
// when the tap lands on the SVG dot itself, and those dots are 7–8px across — a fingertip on a real
// phone lands a few px off, so nothing opened. Emulated taps hit exact centers, so it looked fine.
// Here a click snaps to the nearest point within HIT_RADIUS, and all of the handling is one plain
// React onClick on the chart wrapper (on touch screens a `cursor: pointer` div, which iOS Safari
// reliably dispatches clicks to), with no dependence on Recharts' hover/click state machine.
//
// Hover: with a hovering pointer (a mouse), Recharts' lightweight hover tooltip still shows while
// nothing is pinned (`hover`); the cursor turns to a pointer over a point a click would pin. Touch
// screens have no hover, so they get no Recharts tooltip at all.

const TOUCH_QUERY = '(hover: none), (pointer: coarse)';
/** How far (px) from a point a tap may land and still pick it. */
export const HIT_RADIUS = 28;

function useTouchPrimary(): boolean {
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(TOUCH_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(TOUCH_QUERY);
    if (!mq) return;
    const onChange = () => setTouch(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return touch;
}

export interface ChartGeometry {
  /** Data value → pixel, relative to the chart's top-left corner. */
  x: (v: any) => number | undefined;
  y: (v: any) => number | undefined;
  plot: { x: number; y: number; width: number; height: number };
}

/**
 * Render inside a Recharts chart: publishes the chart's scales and plot area to `geometry`, so taps
 * can be hit-tested against the points as drawn.
 */
export function ChartGeometryProbe({ geometry }: { geometry: MutableRefObject<ChartGeometry | null> }) {
  const x = useXAxisScale();
  const y = useYAxisScale();
  const plot = usePlotArea();
  useLayoutEffect(() => {
    geometry.current = x && y && plot ? { x: x as ChartGeometry['x'], y: y as ChartGeometry['y'], plot } : null;
  });
  return null;
}

export interface Pin<T> {
  /** Where the popup points, in px relative to the chart wrapper. */
  x: number;
  y: number;
  /** 'point' rings one dot; 'column' marks an x position (a shared, per-column tooltip). */
  kind: 'point' | 'column';
  data: T;
}

/** A usable pixel value, or null (scales give undefined / NaN outside their domain, e.g. log of 0). */
export function px(v: number | undefined): number | null {
  return v == null || !Number.isFinite(v) ? null : v;
}

/**
 * `hitTest(tapX, tapY, geometry)` returns the pin for a tap (chart-relative px), or null for empty
 * area. The popup closes whenever any of `deps` changes (chart mode, the data, …).
 */
export function useChartPin<T>(
  hitTest: (x: number, y: number, g: ChartGeometry) => Pin<T> | null,
  deps: unknown[],
) {
  const touch = useTouchPrimary();
  const [pin, setPin] = useState<Pin<T> | null>(null);
  const geometry = useRef<ChartGeometry | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setPin(null); }, deps);

  // Escape closes a pinned popup.
  const pinned = pin != null;
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPin(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  /** The pin a click at viewport (clientX, clientY) would make, or null for empty chart area. */
  const pinAt = (clientX: number, clientY: number): Pin<T> | null => {
    const el = wrapperRef.current;
    const g = geometry.current;
    if (!el || !g) return null;
    const r = el.getBoundingClientRect();
    return hitTest(clientX - r.left, clientY - r.top, g);
  };

  const onWrapperClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    // Clicks inside the popup (its text, padding) leave it alone; its link and × handle themselves.
    if (popupRef.current?.contains(e.target as Node)) return;
    if (!wrapperRef.current || !geometry.current) return;
    setPin(pinAt(e.clientX, e.clientY));
  };

  // Mouse only: a pointer cursor over a point a click would pin. Set on the element directly, so
  // moving the mouse doesn't re-render the chart.
  const onWrapperPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = wrapperRef.current;
    if (!el || e.pointerType !== 'mouse') return;
    const overPopup = popupRef.current?.contains(e.target as Node);
    el.style.cursor = !overPopup && pinAt(e.clientX, e.clientY) ? 'pointer' : '';
  };
  const onWrapperPointerLeave = () => { if (wrapperRef.current && !touch) wrapperRef.current.style.cursor = ''; };

  return {
    /** True on touch-primary screens (no hover). */
    touch,
    /** Render Recharts' hover `<Tooltip>` (and hover-highlighted dots) only when this is true. */
    hover: !touch && !pin,
    pin,
    close: () => setPin(null),
    geometry,
    wrapperRef,
    popupRef,
    /** Spread onto the `relative` div wrapping the chart. */
    wrapperProps: touch
      ? { ref: wrapperRef, onClick: onWrapperClick, style: { cursor: 'pointer', WebkitTapHighlightColor: 'transparent' } as const }
      : { ref: wrapperRef, onClick: onWrapperClick, onPointerMove: onWrapperPointerMove, onPointerLeave: onWrapperPointerLeave },
  };
}
