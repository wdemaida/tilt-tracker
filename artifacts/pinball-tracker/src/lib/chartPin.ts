import { useEffect, useState } from 'react';

// Tap-to-pin chart tooltips on touch screens.
//
// Recharts tooltips follow the pointer and are `pointer-events: none`, so anything inside them (an
// @username link) can't be tapped: the tap falls through to the chart. On a touch-primary device we
// switch the tooltip to `trigger="click"` — a tap pins it on that point, where it stays — make it
// interactive, and give it a close button (the content component renders one when `pinned`).
// Desktop keeps plain hover tooltips; nothing changes there.
//
// Everything clickable inside a pinned tooltip must stop propagation (UsernameLink does), because a
// click that reaches the chart wrapper re-pins the tooltip to whatever point sits under the finger.

const TOUCH_QUERY = '(hover: none)';

function useTouchPrimary(): boolean {
  const [touch, setTouch] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(TOUCH_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(TOUCH_QUERY);
    if (!mq) return;
    const onChange = () => setTouch(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return touch;
}

/** `resetKey` closes the pinned tooltip whenever it changes (e.g. the chart mode). */
export function useTapToPinTooltip(resetKey?: unknown) {
  const touch = useTouchPrimary();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [resetKey]);

  return {
    /** Spread onto `<Tooltip>`. */
    tooltipProps: touch
      ? {
          trigger: 'click' as const,
          // Controlled only to hide it after the close button; otherwise Recharts' click state rules.
          active: open ? undefined : false,
          wrapperStyle: { pointerEvents: 'auto' as const, zIndex: 20 },
        }
      : {},
    /** Pass as the chart's `onClick`. */
    onChartClick: touch ? () => setOpen(true) : undefined,
    /** True while a tooltip is pinned open — the content shows its close button. */
    pinned: touch && open,
    close: () => setOpen(false),
  };
}
