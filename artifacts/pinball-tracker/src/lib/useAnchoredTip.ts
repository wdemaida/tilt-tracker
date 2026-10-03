import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const TIP_GAP = 8;
const EDGE = 8;

/**
 * Positions a portaled, `position: fixed` tooltip next to its anchor: centered above it (below if
 * there's no room above), clamped inside the viewport. While open, a scroll or resize calls
 * `onDismiss`, since a fixed tooltip would otherwise be stranded away from its anchor.
 *
 * Put `anchorRef` on the trigger and `tipRef` on the tooltip, and spread `tipStyle` into the
 * tooltip's style — it keeps the tooltip invisible until it has been measured.
 *
 * Copied from BadgeShelf's ShelfTile (which still has its own inline copy and can adopt this).
 */
export function useAnchoredTip<A extends HTMLElement = HTMLButtonElement>(open: boolean, onDismiss: () => void) {
  const anchorRef = useRef<A>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const anchor = anchorRef.current, tip = tipRef.current;
    if (!anchor || !tip) return;
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), Math.max(EDGE, vw - w - EDGE));
    let top = r.top - h - TIP_GAP;
    if (top < EDGE) top = Math.min(r.bottom + TIP_GAP, vh - h - EDGE);
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const hide = () => dismissRef.current();
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [open]);

  const tipStyle: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' };
  return { anchorRef, tipRef, tipStyle };
}
