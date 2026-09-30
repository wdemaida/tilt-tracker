import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { Link } from 'wouter';
import { Award, Loader2 } from 'lucide-react';
import BadgeImage from '../components/BadgeImage';
import { BadgeDetail, SeriesLadder, SeriesPips } from '../components/BadgeShelf';
import { useBadgesApi, BADGES_KEY, availabilityText, groupCatalog, type CatalogBadge } from '../lib/badges';

// /badges — the catalog: every live badge, what earns it and when, and how many players have it, in
// the admin's sort order. A series shows as one ladder (every live tier, each locked/unlocked for
// you); singles as before. Signed in, the ones you haven't earned are shown locked (grayscale);
// guests see them all locked.

function BadgeRow({ b, onOpen, compact = false }: { b: CatalogBadge; onOpen: () => void; compact?: boolean }) {
  const locked = !b.earnedAt;
  const when = availabilityText(b);
  return (
    <button type="button" onClick={onOpen}
      className={`w-full text-left flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors hover:border-white/25 ${locked ? 'border-white/10 bg-card' : 'border-primary/30 bg-primary/5'} ${compact ? 'py-2.5' : ''}`}>
      <BadgeImage badge={b} size={compact ? 40 : 48} locked={locked} />
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-bold uppercase tracking-wider ${locked ? 'text-white/70' : 'text-white'} [overflow-wrap:anywhere]`}>
          {b.series && <span className="sr-only">Tier {b.series.tier} of {b.series.tierCount}: </span>}{b.name}
        </span>
        <span className="block text-xs text-muted-foreground">{b.requirement}</span>
        {when && <span className="block text-[11px] font-bold text-amber-300 mt-0.5">{when}</span>}
      </span>
      <span className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">{b.earnedCount.toLocaleString()}</span>
    </button>
  );
}

export default function BadgesPage() {
  const api = useBadgesApi();
  const { isSignedIn, isLoaded } = useAuth();
  const q = useQuery({ queryKey: [...BADGES_KEY, isSignedIn ? 'me' : 'guest'], queryFn: api.catalog, enabled: isLoaded });
  const [open, setOpen] = useState<CatalogBadge | null>(null);
  const items = q.data ?? [];
  const groups = groupCatalog(items);
  const earned = items.filter(b => b.earnedAt);
  // The detail of a tier also shows its whole ladder.
  const openLadder = open?.series ? items.filter(b => b.series?.id === open.series!.id) : null;

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
          {groups.map(g => g.type === 'badge' ? (
            <li key={`b${g.badge.id}`}><BadgeRow b={g.badge} onOpen={() => setOpen(g.badge)} /></li>
          ) : (
            <li key={`s${g.series.id}`} className="sm:col-span-2 rounded-xl border border-white/10 p-3 flex flex-col gap-2" style={{ borderColor: `${g.series.color}40` }}>
              <div className="flex items-center justify-between gap-3 px-1">
                <h2 className="text-xs font-black uppercase tracking-widest" style={{ color: g.series.color }}>{g.series.name}</h2>
                <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {isSignedIn && <span>{g.tiers.filter(t => t.earnedAt).length} of {g.tiers.length}</span>}
                  <SeriesPips earned={g.tiers.filter(t => t.earnedAt).length} total={g.tiers.length} color={g.series.color} />
                </span>
              </div>
              <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-label={`${g.series.name} tiers`}>
                {g.tiers.map(b => <li key={b.id}><BadgeRow b={b} compact onOpen={() => setOpen(b)} /></li>)}
              </ol>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <BadgeDetail badge={open} earnedAt={open.earnedAt} earnedCount={open.earnedCount} locked={!open.earnedAt} onClose={() => setOpen(null)}
          extra={openLadder && openLadder.length > 1 ? <SeriesLadder tiers={openLadder.map(b => ({ badge: b, earnedAt: b.earnedAt }))} current={open.id} /> : undefined} />
      )}
    </div>
  );
}
