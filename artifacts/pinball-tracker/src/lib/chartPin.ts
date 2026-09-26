import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';
import { usePlotArea, useXAxisScale, useYAxisScale } from 'recharts';

// Tap-to-pin chart popups on touch screens.
//
// Recharts tooltips follow the pointer and are `pointer-events: none`, so an @username inside one
// can't be tapped. On a touch-primary device we therefore don't use Recharts' Tooltip at all: a tap
// on the chart is hit-tested here, against point positions read from the chart's own scales, and the
// popup is an ordinary absolutely-positioned element we render and control. It stays until × is
// tapped, another point is tapped (it moves there) or empty chart area is tapped (it closes).
//
// Why not Recharts' `trigger="click"` (the first attempt): for item charts (scatter) it pins only
// when the tap lands on the SVG dot itself, and those dots are 7–8px across — a fingertip on a real
// phone lands a few px off, so nothing opened. Emulated taps hit exact centers, so it looked fine.
// Here a tap snaps to the nearest point within HIT_RADIUS, and all of the tap handling is one plain
// React onClick on a `cursor: pointer` div (which iOS Safari reliably dispatches clicks to), with no
// dependence on Recharts' hover/click state machine.
//
// Desktop (a hovering pointer) is untouched: plain Recharts hover tooltips.

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

  const onWrapperClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    // Taps inside the popup (its text, padding) leave it alone; its link and × handle themselves.
    if (popupRef.current?.contains(e.target as Node)) return;
    const el = wrapperRef.current;
    const g = geometry.current;
    if (!el || !g) return;
    const r = el.getBoundingClientRect();
    setPin(hitTest(e.clientX - r.left, e.clientY - r.top, g));
  };

  return {
    /** True on touch-primary screens: render Recharts' `<Tooltip>` only when this is false. */
    touch,
    pin: touch ? pin : null,
    close: () => setPin(null),
    geometry,
    wrapperRef,
    popupRef,
    /** Spread onto the `relative` div wrapping the chart. */
    wrapperProps: touch
      ? { ref: wrapperRef, onClick: onWrapperClick, style: { cursor: 'pointer', WebkitTapHighlightColor: 'transparent' } as const }
      : { ref: wrapperRef },
  };
}

