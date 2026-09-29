// "A new version is available — Reload": shown when /version.json names a different build than the
// one running (see lib/appVersion.ts). Checked when the tab becomes visible, throttled. Non-blocking,
// dismissible, and it never reloads on its own.

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { RefreshCw, X } from 'lucide-react';
import { APP_BUILD_ID, CHECK_EVERY_MS, fetchDeployedBuildId } from '../lib/appVersion';

export default function UpdateBanner() {
  const [location] = useLocation();
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const lastCheck = useRef(0);

  useEffect(() => {
    // The dev server has no version.json (it's emitted at build time).
    if (import.meta.env.DEV) return;
    // Loading the page counts as a check: a freshly loaded tab is the newest build.
    lastCheck.current = Date.now();
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastCheck.current < CHECK_EVERY_MS) return;
      lastCheck.current = now;
      const deployed = await fetchDeployedBuildId();
      if (deployed && deployed !== APP_BUILD_ID) setAvailable(true);
    };
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  if (!available || dismissed) return null;

  function reload() {
    // A score half-entered in the wizard would be lost.
    if (location.startsWith('/add') && !window.confirm('Reloading will lose the score you’re entering. Reload anyway?')) return;
    window.location.reload();
  }

  return (
    <div role="status" className="fixed inset-x-0 top-2 z-40 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-white/15 bg-[#1a1a2e]/95 px-4 py-2 text-xs text-white shadow-lg">
        <span>A new version is available</span>
        <button type="button" onClick={reload}
          className="inline-flex items-center gap-1 font-bold uppercase tracking-wider text-primary hover:text-primary/80">
          <RefreshCw className="w-3.5 h-3.5" /> Reload
        </button>
        <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="text-muted-foreground hover:text-white">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
