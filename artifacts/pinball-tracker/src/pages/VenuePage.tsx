import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, ChevronUp, ChevronDown, Home } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';
import VenueMapThumbnail from '../components/VenueMapThumbnail';
import VenueMachinesModal from '../components/VenueMachinesModal';

type SortKey = 'playedAt' | 'machineName' | 'type' | 'username' | 'score';
type SortDir = 'asc' | 'desc';

export default function VenuePage() {
  const { id } = useParams<{ id: string }>();
  const [sortKey, setSortKey] = useState<SortKey>('playedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showMachinesModal, setShowMachinesModal] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['venue-scores', id],
    queryFn: () => api.venues.scores(Number(id)),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Venue not found.</p>;

  const { venue, scores } = data;

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

  return (
    <div>
      <Link href="/venues" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> All Venues
      </Link>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-3xl font-black uppercase tracking-widest text-venue leading-tight flex items-center gap-2">
            {venue.name}
            {venue.isResidence && <Home className="w-5 h-5 text-venue/70 flex-shrink-0" />}
          </h1>
          {venue.address && (
            <p className="text-sm text-muted-foreground mt-1">{venue.address}</p>
          )}
          <p className="text-sm text-muted-foreground mt-1">
            {scores.length} {scores.length === 1 ? 'score' : 'scores'} recorded on{' '}
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
        </div>
        <VenueMapThumbnail venueId={venue.id} latitude={venue.latitude} longitude={venue.longitude} />
      </div>

      {scores.length === 0 ? (
        <p className="text-muted-foreground">No scores recorded at this venue yet.</p>
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
                    {format(new Date(s.playedAt), 'MMM d, yyyy')}
                    <span className="block text-xs opacity-60">{format(new Date(s.playedAt), 'h:mm a')}</span>
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
                    <Link href={`/users/${s.username}`} className="text-sm text-username hover:text-username/80 transition-colors">
                      @{s.username}
                    </Link>
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
    </div>
  );
}

