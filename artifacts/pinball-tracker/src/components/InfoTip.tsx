import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredTip } from '../lib/useAnchoredTip';

/**
 * A label that explains itself: a button wrapping `children` (the label, with its own Info icon)
 * that shows a small tooltip — `name` on top, `description` under it.
 *
 *  - mouse: hover opens it (pointerType check, so a touch's synthetic hover doesn't);
 *  - keyboard: focus-visible opens it, Enter/Space pins it;
 *  - touch: a tap toggles it — Radix Tooltip deliberately never opens on touch, which is why this
 *    isn't one;
 *  - a tap/click elsewhere, Escape, blur, scroll or resize closes it.
 *
 * Screen readers get the description through `aria-describedby` (an sr-only span); the visible
 * tooltip is aria-hidden so it isn't read twice. Positioning is `useAnchoredTip`.
 */
export default function InfoTip({ name, description, className, children }: {
  name: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  const descId = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || focus || pinned;
  const close = () => { setHover(false); setFocus(false); setPinned(false); };
  const { anchorRef, tipRef, tipStyle } = useAnchoredTip<HTMLButtonElement>(open, close);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onDown = (e: PointerEvent) => { if (!anchorRef.current?.contains(e.target as Node)) close(); };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, [open, anchorRef]);

  return (
    <>
      <button ref={anchorRef} type="button" aria-expanded={open} aria-describedby={descId}
        onClick={() => setPinned(p => !p)}
        onPointerEnter={e => { if (e.pointerType === 'mouse') setHover(true); }}
        onPointerLeave={e => { if (e.pointerType === 'mouse') { setHover(false); setPinned(false); } }}
        onFocus={e => { if (e.currentTarget.matches(':focus-visible')) setFocus(true); }}
        onBlur={close}
        className={`cursor-help rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className ?? ''}`}>
        {children}
        <span id={descId} className="sr-only">{description}</span>
      </button>
      {open && createPortal(
        <div ref={tipRef} role="tooltip" aria-hidden
          className="fixed z-40 pointer-events-none w-max max-w-[min(260px,calc(100vw-16px))] rounded-lg border border-white/10 bg-[#1a1a2e] px-3 py-2 shadow-xl"
          style={tipStyle}>
          <p className="text-xs font-black uppercase tracking-widest text-white [overflow-wrap:anywhere]">{name}</p>
          <p className="mt-1 text-xs text-muted-foreground leading-snug">{description}</p>
        </div>,
        document.body,
      )}
    </>
  );
}
