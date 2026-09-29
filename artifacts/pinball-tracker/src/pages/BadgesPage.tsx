import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { Link } from 'wouter';
import { Award, Loader2 } from 'lucide-react';
import BadgeImage from '../components/BadgeImage';
import { BadgeDetail } from '../components/BadgeShelf';
import { useBadgesApi, BADGES_KEY, availabilityText, type CatalogBadge } from '../lib/badges';

// /badges — the catalog: every live badge, what earns it and when, and how many players have it.
// Signed in, the ones you haven't earned are shown locked (grayscale); guests see them all locked.

export default function BadgesPage() {
  const api = useBadgesApi();
  const { isSignedIn, isLoaded } = useAuth();
  const q = useQuery({ queryKey: [...BADGES_KEY, isSignedIn ? 'me' : 'guest'], queryFn: api.catalog, enabled: isLoaded });
  const [open, setOpen] = useState<CatalogBadge | null>(null);
  const items = q.data ?? [];
  const earned = items.filter(b => b.earnedAt);

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">Badges</h1>
        {isSignedIn && items.length > 0 && (
          <p className="text-sm text-muted-foreground"><span className="text-white font-bold">{earned.length}</span> of {items.length} earned</p>
        )}
      </div>
      {!isSignedIn && isLoaded && (
        <p className="text-sm text-muted-foreground mb-4"><Link href="/sign-in" className="text-primary font-bold hover:underline">Sign in</Link> to start earning badges.</p>
      )}
      {q.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : q.isError ? (
        <p className="text-sm text-red-400">Couldn’t load the badges.</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
          <Award className="w-8 h-8 text-muted-foreground mx-auto mb-3" aria-hidden />
          <p className="text-sm text-white font-bold mb-1">No badges yet</p>
          <p className="text-sm text-muted-foreground">Check back soon.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map(b => {
            const locked = !b.earnedAt;
            const when = availabilityText(b);
            return (
              <li key={b.id}>
                <button type="button" onClick={() => setOpen(b)}
                  className={`w-full text-left flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors hover:border-white/25 ${locked ? 'border-white/10 bg-card' : 'border-primary/30 bg-primary/5'}`}>
                  <BadgeImage badge={b} size={48} locked={locked} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-bold uppercase tracking-wider ${locked ? 'text-white/70' : 'text-white'} [overflow-wrap:anywhere]`}>{b.name}</span>
                    <span className="block text-xs text-muted-foreground">{b.requirement}</span>
                    {when && <span className="block text-[11px] font-bold text-amber-300 mt-0.5">{when}</span>}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">{b.earnedCount.toLocaleString()}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && <BadgeDetail badge={open} earnedAt={open.earnedAt} earnedCount={open.earnedCount} locked={!open.earnedAt} onClose={() => setOpen(null)} />}
    </div>
  );
}
