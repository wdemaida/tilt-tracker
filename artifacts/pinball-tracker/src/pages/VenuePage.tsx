import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, ChevronUp, ChevronDown, Home, Pencil, EyeOff } from 'lucide-react';
import { formatScoreTime } from '../lib/scoreTime';
import { useApi } from '../lib/useApi';
import { useComparisonScope, scopeQuery, scopeKey } from '../lib/comparisonScope';
import { usePodMembership } from '../lib/myPods';
import ComparisonScopePicker from '../components/ComparisonScopePicker';
import PodMemberIcons from '../components/PodMemberIcons';
import VenueMapThumbnail from '../components/VenueMapThumbnail';
import VenueMachinesModal from '../components/VenueMachinesModal';
import VenueRepairPanel from '../components/VenueRepairPanel';
import VenueInventoryPanel from '../components/VenueInventoryPanel';
import EditVenueDialog, { editTargetFromVenue, type EditVenueTarget } from '../components/EditVenueDialog';

type SortKey = 'playedAt' | 'machineName' | 'type' | 'username' | 'score';
type SortDir = 'asc' | 'desc';
/** How the scoped scores are shown — never who is in them (that's the Compare picker's job). */
type View = 'scores' | 'machines';

interface MachineRow {
  name: string;
  plays: number;
  top: any;
  yourBest: number | null;
}

export default function VenuePage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [sortKey, setSortKey] = useState<SortKey>('playedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [view, setView] = useState<View>('scores');
  const [showMachinesModal, setShowMachinesModal] = useState(false);
  const [editVenue, setEditVenue] = useState<EditVenueTarget | null>(null);

  // Compare scope (All / Mine / Friends / one pod) — URL-backed, falls back to the ScopeContext toggle, same
  // as the Machine page. It decides WHO is in the score list below the picker; the header, map,
  // machine count, repair and inventory panels are facts about the venue and ignore it.
  const cs = useComparisonScope();
  const { scope, pod } = cs;
  const podMembership = usePodMembership();

  const { data, isLoading, error } = useQuery({
    queryKey: ['venue-scores', id, scopeKey(scope)],
    queryFn: () => api.venues.scores(Number(id), scopeQuery(scope)),
    enabled: cs.ready,
    // Keep the page on screen while switching scope on the same venue — not across venues.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === id ? prev : undefined),
  });

  const venueInfo = data?.venue;
  // The machines payload (roster / home-venue inventory) is shared with VenueMachinesModal's cache
  // entry and unaffected by scope. Needed for a home venue's inventory panel, and by the By machine
  // view to list roster machines nobody in scope has played. Not fetched when the owner hides it.
  const { data: machinesData } = useQuery({
    queryKey: ['venue-machines', Number(id)],
    queryFn: () => api.venues.machines(Number(id)),
    enabled: !!venueInfo && !venueInfo.activityHidden && (!!venueInfo.ownerInventory || view === 'machines'),
  });

  const scores = useMemo(() => (data?.scores ?? []) as any[], [data]);

  const machineRows = useMemo<MachineRow[]>(() => {
    const byName = new Map<string, MachineRow>();
    for (const s of scores) {
      let row = byName.get(s.machineName);
      if (!row) { row = { name: s.machineName, plays: 0, top: s, yourBest: null }; byName.set(s.machineName, row); }
      row.plays++;
      if (s.score > row.top.score) row.top = s;
      if (s.group === 'self' && (row.yourBest === null || s.score > row.yourBest)) row.yourBest = s.score;
    }
    return [...byName.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
  }, [scores]);

  // Machines at the venue now (Pinball Map roster, or a home venue's inventory) with no scores in
  // this scope: listed after the played ones, without stats.
  const unplayedHere = useMemo<string[]>(() => {
    if (!machinesData) return [];
    const played = new Set(machineRows.map(m => m.name.toLowerCase()));
    const current: Array<{ name: string }> = machinesData.inventory?.machines ?? machinesData.pmMachines ?? [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of current) {
      const key = m.name.toLowerCase();
      if (played.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(m.name);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [machinesData, machineRows]);

  if (!cs.ready || isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data && (error as any)?.code === 'pod_not_found') {
    // The pod list said it was ours but the server disagrees (deleted in another tab, say).
    return (
      <p className="text-muted-foreground">
        That pod isn't available any more.{' '}
        <button type="button" onClick={() => cs.setScope({ kind: 'all' })} className="text-primary hover:underline">Show all players</button>
      </p>
    );
  }
  if (!data) return <p className="text-muted-foreground">Venue not found.</p>;

  const { venue } = data;
  // Venue-wide (every score here you may see), the same in every scope.
  const totalScores: number = data.totals?.scores ?? scores.length;
  const narrowed = scope.kind === 'mine' || ((scope.kind === 'pod' || scope.kind === 'friends') && !scope.others);
  const showYourBest = cs.signedIn && scope.kind !== 'mine';

  const whoLabel = scope.kind === 'mine' ? 'from you'
    : scope.kind === 'pod' && !scope.others ? `from you or ${pod?.name ?? 'your pod'}`
    : scope.kind === 'friends' && !scope.others ? 'from you or your friends'
    : 'yet';

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'score' ? 'desc' : 'asc');
    }
  }

  const sorted = [...scores].sort((a: any, b: any) => {
    let cmp = 0;
    if (sortKey === 'playedAt') cmp = new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime();
    else if (sortKey === 'machineName') cmp = (a.machineName ?? '').localeCompare(b.machineName ?? '');
    else if (sortKey === 'type') cmp = (a.type ?? '').localeCompare(b.type ?? '');
    else if (sortKey === 'username') cmp = (a.username ?? '').localeCompare(b.username ?? '');
    else if (sortKey === 'score') cmp = a.score - b.score;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronUp className="w-3 h-3 opacity-20" />;
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 text-primary" />
      : <ChevronDown className="w-3 h-3 text-primary" />;
  }

  function SortableHeader({ col, label, align = 'left' }: { col: SortKey; label: string; align?: 'left' | 'right' }) {
    return (
      <th className={`py-3 px-3 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button
          onClick={() => toggleSort(col)}
          className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors ${sortKey === col ? 'text-primary' : 'text-muted-foreground hover:text-white'} ${align === 'right' ? 'ml-auto' : ''}`}
        >
          {label}
          <SortIcon col={col} />
        </button>
      </th>
    );
  }

  function UserLink({ username, small = false }: { username: string; small?: boolean }) {
    return (
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <Link href={`/users/${username}`} title={`@${username}`} className={`${small ? 'text-xs' : 'text-sm'} text-username hover:text-username/80 transition-colors truncate`}>
          @{username}
        </Link>
        <PodMemberIcons pods={podMembership.get(username)} />
      </span>
    );
  }

  const viewSegment = (active: boolean) =>
    `px-3 py-1.5 rounded-md transition-colors ${active ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <Link href="/venues" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors">
          <ArrowLeft className="w-4 h-4" /> All Venues
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-3xl font-black uppercase tracking-widest text-venue leading-tight flex items-center gap-2">
            {venue.name}
            {venue.isResidence && <Home className="w-5 h-5 text-venue/70 flex-shrink-0" />}
            {/* Same pencil, dialog and permission as the Venues page card (server's canEdit). */}
            {venue.canEdit && (
              <button
                type="button"
                onClick={() => setEditVenue(editTargetFromVenue(venue))}
                className="p-1 rounded text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Edit venue"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}
          </h1>
          {venue.address ? (
            <p className="text-sm text-muted-foreground mt-1">{venue.address}</p>
          ) : venue.isResidence || venue.isPrivate ? (
            <p className="text-sm text-muted-foreground/60 italic mt-1">Address hidden</p>
          ) : null}
          {venue.activityHidden ? (
            <p className="text-sm text-muted-foreground mt-1">
              {totalScores === 1 ? 'Your score here is shown below. ' : totalScores > 1 ? `Your ${totalScores} scores here are shown below. ` : ''}
              The owner keeps this venue’s machines and scores private.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">
              {totalScores} {totalScores === 1 ? 'score' : 'scores'} recorded on{' '}
              <button
                type="button"
                onClick={() => setShowMachinesModal(true)}
                className="text-machine font-bold hover:text-machine/80 transition-colors underline decoration-dotted underline-offset-2"
              >
                {venue.pmMachineCount != null
                  ? `${venue.machineCount}/${venue.pmMachineCount} Machines`
                  : `${venue.machineCount} ${venue.machineCount === 1 ? 'Machine' : 'Machines'}`}
              </button>
            </p>
          )}
          {venue.canEdit && venue.isPrivate && venue.showMachinesAndScores === false && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
              <EyeOff className="w-3.5 h-3.5" />
              Only you and admins see the machines and scores here — players still see their own.
            </p>
          )}
        </div>
        <VenueMapThumbnail venueId={venue.id} latitude={venue.latitude} longitude={venue.longitude} />
      </div>

      {/* Keyed so a merge that navigates to another venue starts that panel fresh. */}
      <VenueRepairPanel key={venue.id} venueId={venue.id} />

      {venue.ownerInventory && !venue.activityHidden && machinesData && (
        <VenueInventoryPanel
          venueId={venue.id}
          inventory={machinesData.inventory ?? null}
          canManage={!!machinesData.canManageInventory}
        />
      )}

      {/* Compare (who) sits directly above the scores it scopes; the view toggle (how) shares its
          row on the right. The hairline separates it from the venue panels above, which it doesn't
          touch. Hidden where the owner keeps activity private — you only see your own there anyway. */}
      <div className="border-t border-white/10 pt-4 mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {cs.signedIn && !venue.activityHidden ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Compare</span>
              <ComparisonScopePicker state={cs} />
            </div>
          ) : <span />}
          {scores.length > 0 && (
            <div
              role="group"
              aria-label="Show scores as"
              className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider"
            >
              <button type="button" aria-pressed={view === 'scores'} onClick={() => setView('scores')} className={viewSegment(view === 'scores')}>
                Scores
              </button>
              <button type="button" aria-pressed={view === 'machines'} onClick={() => setView('machines')} className={viewSegment(view === 'machines')}>
                By machine
              </button>
            </div>
          )}
        </div>
        {cs.unknownPod && (
          <p className="text-xs text-muted-foreground mt-2">That pod isn't one of yours — showing all players.</p>
        )}
        {narrowed && totalScores > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            Showing {scores.length} of {totalScores} {totalScores === 1 ? 'score' : 'scores'} here
          </p>
        )}
      </div>

      {scores.length === 0 ? (
        <p className="text-muted-foreground">
          {narrowed && totalScores > 0 ? `No scores ${whoLabel} at this venue yet.` : 'No scores recorded at this venue yet.'}
        </p>
      ) : view === 'machines' ? (
        <div className="rounded-xl border border-white/10 bg-card overflow-hidden">
          <table className="w-full text-sm table-fixed">
            <thead>
              <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                <th className="py-3 px-2 sm:px-3 text-left">Machine</th>
                <th className={`py-3 px-2 sm:px-3 text-right ${showYourBest ? 'w-[40%]' : 'w-[45%]'}`}>{scope.kind === 'mine' ? 'Your best' : 'Top score'}</th>
                {showYourBest && <th className="py-3 px-2 sm:px-3 text-right w-[26%]">You</th>}
              </tr>
            </thead>
            <tbody>
              {machineRows.map(m => (
                <tr key={m.name} className="border-b border-white/5 hover:bg-white/5 transition-colors align-top">
                  <td className="px-2 sm:px-3 py-3 min-w-0">
                    <Link href={`/machines/${encodeURIComponent(m.name)}`} className="block font-semibold text-machine hover:text-machine/80 transition-colors break-words">
                      {m.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">{m.plays} {m.plays === 1 ? 'play' : 'plays'}</span>
                  </td>
                  <td className="px-2 sm:px-3 py-3 text-right">
                    <span className="block font-bold text-primary whitespace-nowrap">{Number(m.top.score).toLocaleString()}</span>
                    {scope.kind !== 'mine' && (
                      <span className="flex justify-end min-w-0"><UserLink username={m.top.username} small /></span>
                    )}
                  </td>
                  {showYourBest && (
                    <td className="px-2 sm:px-3 py-3 text-right font-bold whitespace-nowrap">
                      {m.yourBest !== null
                        ? <span className="text-username">{m.yourBest.toLocaleString()}</span>
                        : <span className="text-muted-foreground/50">—</span>}
                    </td>
                  )}
                </tr>
              ))}
              {unplayedHere.length > 0 && (
                <tr>
                  <td colSpan={showYourBest ? 3 : 2} className="px-2 sm:px-3 pt-4 pb-3">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Here now — no scores {whoLabel}
                    </p>
                    <p className="text-sm leading-relaxed">
                      {unplayedHere.map((name, i) => (
                        <span key={name}>
                          {i > 0 && <span className="text-muted-foreground/40"> · </span>}
                          <Link href={`/machines/${encodeURIComponent(name)}`} className="text-machine/60 hover:text-machine transition-colors">
                            {name}
                          </Link>
                        </span>
                      ))}
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-white/10">
                <SortableHeader col="playedAt" label="Date" />
                <SortableHeader col="machineName" label="Machine" />
                <SortableHeader col="type" label="Type" />
                <SortableHeader col="username" label="User" />
                <SortableHeader col="score" label="Score" align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s: any) => (
                <tr key={s.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                    {formatScoreTime(s.playedAt, venue?.timezone, 'MMM d, yyyy')}
                    <span className="block text-xs opacity-60">{formatScoreTime(s.playedAt, venue?.timezone, 'h:mm a')}</span>
                  </td>
                  <td className="px-3 py-3">
                    <Link href={`/machines/${encodeURIComponent(s.machineName)}`} className="font-semibold text-machine hover:text-machine/80 transition-colors">
                      {s.machineName}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <span className="text-xs font-bold uppercase tracking-wider border border-white/20 rounded px-2 py-0.5 text-muted-foreground">
                      {s.type}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <UserLink username={s.username} />
                  </td>
                  <td className="px-3 py-3 text-right font-bold text-lg text-primary whitespace-nowrap">
                    {Number(s.score).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <VenueMachinesModal venueId={showMachinesModal ? venue.id : null} onClose={() => setShowMachinesModal(false)} />
      <EditVenueDialog venue={editVenue} onClose={() => setEditVenue(null)} />
    </div>
  );
}
