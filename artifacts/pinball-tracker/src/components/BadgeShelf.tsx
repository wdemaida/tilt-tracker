import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { Award, Check, Circle, X } from 'lucide-react';
import BadgeImage from './BadgeImage';
import { useBadgesApi, userBadgesKey, availabilityText, shelfItems, type Badge, type ShelfBadge, type ShelfItem } from '../lib/badges';

// The profile's Badges section (any user's profile — badges are public). A 48px grid in the admin's
// sort order (not newest first), "View all" past 12; tapping one opens BadgeDetail at 96px. A
// series (a ladder of tiers) shows once, as the highest tier earned with pips under it — filled =
// tiers earned, hollow = the remaining live tiers — and its detail lists the whole ladder. The
// collapsing is the server's (`items`, badgeSeries.ts). A profile with no badges hides the section,
// except your own, which points at the catalog.

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
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm max-h-[90vh] overflow-y-auto p-5 sm:p-6 flex flex-col items-center gap-3 text-center"
        onClick={e => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="absolute top-3 right-3 text-muted-foreground hover:text-white" aria-label="Close">
          <X className="w-5 h-5" />
        </button>
        <BadgeImage badge={badge} size={96} locked={locked} />
        {badge.series && (
          <p className="-mb-2 text-[11px] font-bold uppercase tracking-widest" style={{ color: badge.series.color }}>
            {badge.series.name} · Tier {badge.series.tier} of {badge.series.tierCount}
          </p>
        )}
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

/** Progress pips for a series: `earned` filled dots, then hollow ones up to `total`, in the series color. */
export function SeriesPips({ earned, total, color, size = 6 }: { earned: number; total: number; color: string; size?: number }) {
  return (
    <span className="flex flex-wrap justify-center gap-[3px] max-w-[64px]" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="rounded-full" style={{
          width: size, height: size,
          ...(i < earned ? { backgroundColor: color } : { border: `1.5px solid ${color}`, opacity: 0.7 }),
        }} />
      ))}
    </span>
  );
}

/** A series' whole ladder, lowest tier first: ✓ + earned date, or ○ + what it takes. */
export function SeriesLadder({ tiers, current }: { tiers: Array<{ badge: Badge; earnedAt: string | null }>; current?: number }) {
  return (
    <ol className="w-full flex flex-col gap-1.5 text-left" aria-label="Tiers">
      {tiers.map((t, i) => {
        const got = !!t.earnedAt;
        return (
          <li key={t.badge.id} aria-current={t.badge.id === current ? 'true' : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${t.badge.id === current ? 'bg-white/[0.06]' : ''}`}>
            <BadgeImage badge={t.badge} size={28} locked={!got} />
            <span className="min-w-0 flex-1">
              <span className={`block text-xs font-bold uppercase tracking-wider [overflow-wrap:anywhere] ${got ? 'text-white' : 'text-white/60'}`}>
                <span className="sr-only">Tier {i + 1}: </span>{t.badge.name}
              </span>
              <span className="block text-[11px] text-muted-foreground">{t.badge.requirement}</span>
            </span>
            {got ? (
              <span className="flex items-center gap-1 text-[11px] text-emerald-300 flex-shrink-0">
                <Check className="w-3.5 h-3.5" aria-hidden /><span>{format(new Date(t.earnedAt!), 'MMM d, yyyy')}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground flex-shrink-0">
                <Circle className="w-3.5 h-3.5" aria-hidden /><span>Not yet</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const TIP_GAP = 8;
const EDGE = 8;

/** One shelf item. A mouse hover (or keyboard focus) shows a small tooltip — name on top, description
 *  under it, both centered, plus "Tier 2 of 4" for a series — and a tap/click opens BadgeDetail.
 *  Touch never triggers the tooltip (pointerType check), so a tap goes straight to the detail. The
 *  tooltip is portaled and fixed-positioned above the badge (below if there's no room), clamped
 *  inside the viewport. */
function ShelfTile({ badge, tierLine, pips, label, onOpen }: {
  badge: Badge;
  tierLine?: string;
  pips?: React.ReactNode;
  label: string;
  onOpen: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const descId = useId();
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!show) { setPos(null); return; }
    const btn = btnRef.current, tip = tipRef.current;
    if (!btn || !tip) return;
    const r = btn.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const left = Math.min(Math.max(r.left + r.width / 2 - w / 2, EDGE), Math.max(EDGE, vw - w - EDGE));
    let top = r.top - h - TIP_GAP;
    if (top < EDGE) top = Math.min(r.bottom + TIP_GAP, vh - h - EDGE);
    setPos({ left, top });
  }, [show]);

  // A scroll or resize would strand the fixed tooltip away from its badge; just hide it.
  useEffect(() => {
    if (!show) return;
    const hide = () => setShow(false);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [show]);

  return (
    <>
      <button ref={btnRef} type="button" aria-label={label} aria-describedby={badge.description ? descId : undefined}
        onClick={() => { setShow(false); onOpen(); }}
        onPointerEnter={e => { if (e.pointerType === 'mouse') setShow(true); }}
        onPointerLeave={() => setShow(false)}
        onFocus={e => { if (e.currentTarget.matches(':focus-visible')) setShow(true); }}
        onBlur={() => setShow(false)}
        className="flex flex-col items-center justify-start gap-1 p-1 rounded-xl hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <BadgeImage badge={badge} size={48} />
        {pips}
        {badge.description && <span id={descId} className="sr-only">{badge.description}</span>}
      </button>
      {show && createPortal(
        <div ref={tipRef} role="tooltip" aria-hidden
          className="fixed z-40 pointer-events-none w-max max-w-[min(240px,calc(100vw-16px))] rounded-lg border border-white/10 bg-[#1a1a2e] px-3 py-2 shadow-xl text-center"
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}>
          <p className="text-xs font-black uppercase tracking-widest text-white [overflow-wrap:anywhere]">{badge.name}</p>
          {badge.description && <p className="mt-1 text-xs text-muted-foreground leading-snug">{badge.description}</p>}
          {tierLine && <p className="mt-1 text-[11px] font-bold" style={{ color: badge.color }}>{tierLine}</p>}
        </div>,
        document.body,
      )}
    </>
  );
}

/** What's earned by a shelf entry: the note, the source score, the source challenge. */
function EarnedExtra({ b }: { b: ShelfBadge }) {
  if (!b.note && !b.sourceScore && !b.sourceChallengeId) return null;
  return (
    <div className="text-xs text-white/70 flex flex-col gap-1">
      {b.note && <p className="italic">“{b.note}”</p>}
      {b.sourceScore && (
        <p>
          Earned with <span className="text-primary font-semibold">{Math.round(b.sourceScore.score).toLocaleString()}</span> on{' '}
          <Link href={`/machines/${encodeURIComponent(b.sourceScore.machineName)}`} className="text-machine font-semibold hover:underline">
            {b.sourceScore.machineName}
          </Link>
        </p>
      )}
      {b.sourceChallengeId && (
        <Link href={`/challenges/${b.sourceChallengeId}`} className="text-primary hover:underline">From a challenge</Link>
      )}
    </div>
  );
}

const itemKey = (it: ShelfItem) => (it.type === 'series' ? `s${it.series.id}` : `b${it.badge.id}`);

export default function BadgeShelf({ username }: { username: string }) {
  const api = useBadgesApi();
  const { data } = useQuery({
    queryKey: userBadgesKey(username),
    queryFn: () => api.forUser(username),
    retry: false,
  });
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<ShelfItem | null>(null);

  if (!data) return null;
  const { badges, isSelf } = data;
  const items = shelfItems(data);
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
  const shown = showAll ? items : items.slice(0, SHELF_LIMIT);
  return (
    <section className="mb-8" aria-label="Badges">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Badges · {badges.length}</h2>
        <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-wider">
          {items.length > SHELF_LIMIT && (
            <button type="button" onClick={() => setShowAll(s => !s)} className="text-primary hover:text-primary/80">
              {showAll ? 'Show fewer' : 'View all'}
            </button>
          )}
          <Link href="/badges" className="text-muted-foreground hover:text-white">All badges</Link>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-2">
        {shown.map(it => it.type === 'series' ? (
          <ShelfTile key={itemKey(it)} badge={it.top}
            label={`${it.top.name} — ${it.series.name}, tier ${it.tier} of ${it.tierCount}, ${it.earnedCount} earned`}
            tierLine={`Tier ${it.tier} of ${it.tierCount}`}
            pips={<SeriesPips earned={it.earnedCount} total={it.tierCount} color={it.series.color} />}
            onOpen={() => setOpen(it)} />
        ) : (
          <ShelfTile key={itemKey(it)} badge={it.badge} label={it.badge.name} onOpen={() => setOpen(it)} />
        ))}
      </div>
      {open && (open.type === 'series' ? (
        <BadgeDetail
          badge={open.top}
          earnedAt={open.top.earnedAt}
          earnedCount={open.top.earnedCount}
          onClose={() => setOpen(null)}
          extra={<>
            <EarnedExtra b={open.top} />
            <SeriesLadder tiers={open.tiers} current={open.top.id} />
          </>}
        />
      ) : (
        <BadgeDetail
          badge={open.badge}
          earnedAt={open.badge.earnedAt}
          earnedCount={open.badge.earnedCount}
          onClose={() => setOpen(null)}
          extra={<EarnedExtra b={open.badge} />}
        />
      ))}
    </section>
  );
}
