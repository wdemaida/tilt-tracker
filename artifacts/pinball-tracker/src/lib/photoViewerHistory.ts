// A browser-history entry for an open PhotoViewer, so the phone's back gesture closes the photo
// instead of whatever the page underneath would do with it (AddScorePage: step back out of step 3).
//
// Opening pushes a same-URL entry, `{ ...history.state, photoViewer: <token> }`. A popstate that
// leaves it closes the viewer. Closing any other way (×, Escape, backdrop, swipe down) unmounts the
// viewer, and the cleanup calls `history.back()` to consume the entry, so history and screen don't
// drift. Pages with their own popstate handler call `isPhotoViewerPop()` first and ignore the pop
// when it's true — both the back gesture's pop and the one our own `history.back()` fires.
//
// React StrictMode mounts effects twice in development; the `history.back()` waits a tick so the
// re-mount can cancel it, and the push is skipped when our entry is still on top.

import { useEffect, useRef } from 'react';

/** A viewer's entry is on top of history right now. */
let entryOpen = false;
/** `history.back()` calls made by a closing viewer whose popstate hasn't arrived yet. */
let closingPops = 0;

/** True when the current popstate belongs to a photo viewer, not to the page. */
export function isPhotoViewerPop(): boolean {
  return entryOpen || closingPops > 0;
}

export function usePhotoViewerHistory(enabled: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tokenRef = useRef<string | null>(null);
  const pendingBack = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (pendingBack.current != null) { window.clearTimeout(pendingBack.current); pendingBack.current = null; }
    if (!tokenRef.current || window.history.state?.photoViewer !== tokenRef.current) {
      tokenRef.current = `pv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.history.pushState({ ...(window.history.state ?? {}), photoViewer: tokenRef.current }, '');
    }
    entryOpen = true;
    const token = tokenRef.current;

    const onPop = () => {
      if (window.history.state?.photoViewer === token) return;
      // Our entry was popped (back gesture): it's already gone, so don't go back again.
      entryOpen = false;
      tokenRef.current = null;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('popstate', onPop);
      if (tokenRef.current !== token) return; // closed by its own pop
      pendingBack.current = window.setTimeout(() => {
        pendingBack.current = null;
        entryOpen = false;
        tokenRef.current = null;
        // Only consume the entry if it's still ours and on top (a route change may have moved on).
        if (window.history.state?.photoViewer !== token) return;
        closingPops++;
        window.addEventListener('popstate', () => { closingPops = Math.max(0, closingPops - 1); }, { once: true });
        window.history.back();
      }, 0);
    };
  }, [enabled]);
}
