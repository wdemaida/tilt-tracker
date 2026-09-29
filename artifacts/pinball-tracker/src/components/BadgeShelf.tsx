import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { Award, X } from 'lucide-react';
import BadgeImage from './BadgeImage';
import { useBadgesApi, userBadgesKey, availabilityText, type Badge, type ShelfBadge } from '../lib/badges';

// The profile's Badges section (any user's profile — badges are public). A 48px grid, newest first,
// "View all" past 12; tapping one opens BadgeDetail at 96px. A profile with no badges hides the
// section, except your own, which points at the catalog.

const SHELF_LIMIT = 12;

/** The tap-to-open detail: name, description, what earns it, when earned, how many players have it. */
export function BadgeDetail({ badge, earnedAt, earnedCount, locked = false, extra, onClose }: {
  badge: Badge;
  earnedAt?: string | null;
  earnedCount?: number;
  locked?: boolean;
  extra?: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const when = availabilityText(badge);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div role="dialog" aria-modal="true" aria-label={badge.name}
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm p-5 sm:p-6 flex flex-col items-center gap-3 text-center"
        onClick={e => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="absolute top-3 right-3 text-muted-foreground hover:text-white" aria-label="Close">
          <X className="w-5 h-5" />
        </button>
        <BadgeImage badge={badge} size={96} locked={locked} />
        <h2 className="text-lg font-black uppercase tracking-widest text-white [overflow-wrap:anywhere]">{badge.name}</h2>
        {badge.description && <p className="text-sm text-white/80">{badge.description}</p>}
        <p className="text-xs text-muted-foreground">{badge.requirement}</p>
        {when && <p className="text-xs font-bold text-amber-300">{when}</p>}
        {extra}
        <div className="text-xs text-muted-foreground flex flex-col gap-0.5">
          {earnedAt && <span>Earned {format(new Date(earnedAt), 'MMM d, yyyy')}</span>}
          {earnedCount != null && (
            <span>{earnedCount === 0 ? 'Nobody has this yet' : `${earnedCount.toLocaleString()} ${earnedCount === 1 ? 'player has' : 'players have'} this`}</span>
          )}
          {badge.retired && <span>No longer awarded</span>}
        </div>
      </div>
    </div>
  );
}

export default function BadgeShelf({ username }: { username: string }) {
  const api = useBadgesApi();
  const { data } = useQuery({
    queryKey: userBadgesKey(username),
    queryFn: () => api.forUser(username),
    retry: false,
  });
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<ShelfBadge | null>(null);

  if (!data) return null;
  const { badges, isSelf } = data;
  if (!badges.length) {
    if (!isSelf) return null;
    return (
      <section className="mb-8 rounded-xl border border-dashed border-white/15 p-4 flex items-center gap-3">
        <Award className="w-5 h-5 text-muted-foreground flex-shrink-0" aria-hidden />
        <p className="text-sm text-muted-foreground">
          No badges yet. <Link href="/badges" className="text-primary font-bold hover:underline">See what you can earn</Link>
        </p>
      </section>
    );
  }
  const shown = showAll ? badges : badges.slice(0, SHELF_LIMIT);
  return (
    <section className="mb-8" aria-label="Badges">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Badges · {badges.length}</h2>
        <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-wider">
          {badges.length > SHELF_LIMIT && (
            <button type="button" onClick={() => setShowAll(s => !s)} className="text-primary hover:text-primary/80">
              {showAll ? 'Show fewer' : 'View all'}
            </button>
          )}
          <Link href="/badges" className="text-muted-foreground hover:text-white">All badges</Link>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-2">
        {shown.map(b => (
          <button key={b.id} type="button" onClick={() => setOpen(b)} title={b.name}
            className="flex items-center justify-center p-1 rounded-xl hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <BadgeImage badge={b} size={48} />
          </button>
        ))}
      </div>
      {open && (
        <BadgeDetail
          badge={open}
          earnedAt={open.earnedAt}
          earnedCount={open.earnedCount}
          onClose={() => setOpen(null)}
          extra={(open.note || open.sourceScore || open.sourceChallengeId) ? (
            <div className="text-xs text-white/70 flex flex-col gap-1">
              {open.note && <p className="italic">“{open.note}”</p>}
              {open.sourceScore && (
                <p>
                  Earned with <span className="text-primary font-semibold">{Math.round(open.sourceScore.score).toLocaleString()}</span> on{' '}
                  <Link href={`/machines/${encodeURIComponent(open.sourceScore.machineName)}`} className="text-machine font-semibold hover:underline">
                    {open.sourceScore.machineName}
                  </Link>
                </p>
              )}
              {open.sourceChallengeId && (
                <Link href={`/challenges/${open.sourceChallengeId}`} className="text-primary hover:underline">From a challenge</Link>
              )}
            </div>
          ) : null}
        />
      )}
    </section>
  );
}
