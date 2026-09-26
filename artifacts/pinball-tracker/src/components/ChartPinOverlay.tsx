import { useEffect, useLayoutEffect, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import type { ChartGeometry, Pin } from '../lib/chartPin';

/**
 * The pinned popup for a touch-screen chart tap (lib/chartPin.ts): a marker on the tapped point (a
 * ring, or a vertical rule for a per-column popup) plus the popup itself, kept inside the chart's
 * width and placed below the point when it fits, else above. Render it inside the chart's `relative`
 * wrapper; `children` is the popup content (which draws its own close button).
 */
export default function ChartPinOverlay<T>({ pin, popupRef, wrapperRef, geometry, color, children }: {
  pin: Pin<T>;
  popupRef: MutableRefObject<HTMLDivElement | null>;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  geometry: MutableRefObject<ChartGeometry | null>;
  /** Ring color for a point pin. */
  color?: string;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = popupRef.current;
    const wrap = wrapperRef.current;
    if (!el || !wrap) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const GAP = 14;
    const left = Math.max(0, Math.min(pin.x - w / 2, W - w));
    // Below the point if it fits in the chart, else above. A popup too tall for either side (Each
    // Player with many players) hangs just under the chart instead, so it covers none of the points
    // and tapping another one still moves it.
    const top = pin.y + GAP + h <= H ? pin.y + GAP
      : pin.y - GAP - h >= 0 ? pin.y - GAP - h
      : H + 4;
    setPos({ left, top });
  }, [pin, popupRef, wrapperRef]);
  // Once placed, make sure its top part is on screen: it may hang below the chart, past the bottom
  // of the viewport. Scroll only as far as needed to show ~200px of it, so the chart stays in view.
  useEffect(() => {
    const el = popupRef.current;
    if (!pos || !el) return;
    const r = el.getBoundingClientRect();
    const overflow = Math.min(r.bottom, r.top + 200) + 8 - window.innerHeight;
    if (overflow > 0) window.scrollBy({ top: overflow, behavior: 'smooth' });
  }, [pos, popupRef]);

  const plot = geometry.current?.plot;
  return (
    <>
      {pin.kind === 'point' ? (
        <div
          aria-hidden
          className="absolute pointer-events-none rounded-full border-2 bg-white/10"
          style={{ left: pin.x - 9, top: pin.y - 9, width: 18, height: 18, borderColor: color ?? 'white' }}
        />
      ) : plot && (
        <div
          aria-hidden
          className="absolute pointer-events-none bg-white/25"
          style={{ left: pin.x - 0.5, top: plot.y, width: 1, height: plot.height }}
        />
      )}
      <div
        ref={popupRef}
        data-chart-pin=""
        className="absolute z-20 cursor-auto"
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      >
        {children}
      </div>
    </>
  );
}
