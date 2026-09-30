import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { dismissToast, subscribeToasts, type Toast } from '../lib/toast';

// Renders lib/toast.ts's stack. Bottom-centre on phones (above the tab bar), bottom-right from md.
// role="status" + aria-live so screen readers announce it without stealing focus. Hovering or
// focusing a toast pauses its timer.

const TONE = {
  success: { Icon: CheckCircle2, cls: 'text-emerald-400', border: 'border-emerald-500/30' },
  error: { Icon: AlertTriangle, cls: 'text-red-400', border: 'border-red-500/40' },
  info: { Icon: Info, cls: 'text-friend', border: 'border-friend/30' },
} as const;

function ToastItem({ t }: { t: Toast }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!t.duration || paused) return;
    const h = window.setTimeout(() => dismissToast(t.id), t.duration);
    return () => window.clearTimeout(h);
  }, [t.id, t.duration, paused]);
  const tone = TONE[t.tone];
  const content = (
    <span className="flex items-start gap-3 min-w-0 flex-1">
      <span className="flex-shrink-0 mt-0.5">{t.icon ?? <tone.Icon className={`w-5 h-5 ${tone.cls}`} aria-hidden />}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-white [overflow-wrap:anywhere]">{t.title}</span>
        {t.body && <span className="block text-xs text-white/70 mt-0.5 [overflow-wrap:anywhere]">{t.body}</span>}
      </span>
    </span>
  );
  return (
    <div
      className={`pointer-events-auto flex items-start gap-2 w-full rounded-xl border ${tone.border} bg-[#1a1a2e]/95 backdrop-blur px-4 py-3 shadow-2xl`}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    >
      {t.href
        ? <Link href={t.href} onClick={() => dismissToast(t.id)} className="flex min-w-0 flex-1 hover:opacity-90">{content}</Link>
        : content}
      <button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss" className="flex-shrink-0 text-muted-foreground hover:text-white -mr-1">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setList), []);
  return (
    <div
      role="status" aria-live="polite"
      className="fixed z-[60] inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6 md:inset-x-auto md:right-6 flex flex-col items-center md:items-end gap-2 px-4 md:px-0 pointer-events-none"
    >
      {list.map(t => <div key={t.id} className="w-full max-w-sm"><ToastItem t={t} /></div>)}
    </div>
  );
}
