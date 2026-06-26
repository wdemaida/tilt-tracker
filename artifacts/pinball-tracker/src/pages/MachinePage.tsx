import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { Trophy, ArrowLeft, MapPin, PlusCircle, ChevronUp, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../lib/api';

type SortKey = 'playedAt' | 'username' | 'type' | 'score';
type SortDir = 'asc' | 'desc';

export default function MachinePage() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const { data, isLoading } = useQuery({
    queryKey: ['machine', decodedName],
    queryFn: () => api.machines.get(decodedName),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Machine not found.</p>;

  const { machine, scores } = data;
  const best = scores.reduce((a: any, b: any) => (b.score > a.score ? b : a), scores[0]);

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
    else if (sortKey === 'username') cmp = (a.username ?? '').localeCompare(b.username ?? '');
    else if (sortKey === 'type') cmp = (a.type ?? '').localeCompare(b.type ?? '');
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
      <Link href="/machines" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> All Machines
      </Link>

      {/* Header with optional backglass image */}
      <div className="flex items-start gap-5 mb-6">
        {machine.imageUrl && (
          <img
            src={machine.imageUrl}
            alt={machine.name}
            className="w-24 h-24 rounded-xl object-cover border border-white/10 flex-shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-black uppercase tracking-widest text-white leading-tight">{machine.name}</h1>
              {(machine.manufacturer || machine.year) && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  {[machine.manufacturer, machine.year].filter(Boolean).join(' · ')}
                </p>
              )}
              <p className="text-sm text-muted-foreground mt-1">{scores.length} scores recorded</p>
            </div>
            <Link
              href="/add"
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary text-primary text-sm font-bold uppercase tracking-wider hover:bg-primary hover:text-white transition-colors flex-shrink-0"
            >
              <PlusCircle className="w-4 h-4" /> Add Score
            </Link>
          </div>
        </div>
      </div>

      {best && (
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-5 flex items-center gap-4 mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/50">
            <Trophy className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Top Score</p>
            <p className="text-3xl font-black text-primary">{Number(best.score).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">
              {best.displayName ?? best.username}
              {' · '}
              {format(new Date(best.playedAt), 'MMM d, yyyy')}
              {best.venueName && ` · ${best.venueName}`}
            </p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-card overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead>
            <tr className="border-b border-white/10">
              <SortableHeader col="playedAt" label="Date & Venue" />
              <SortableHeader col="username" label="User" />
              <SortableHeader col="type" label="Type" />
              <SortableHeader col="score" label="Score" align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s: any) => (
              <tr key={s.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-3 py-3">
                  <div>
                    <p className="font-semibold text-white">
                      {format(new Date(s.playedAt), 'MMM d, yyyy')}
                      <span className="text-muted-foreground ml-2">{format(new Date(s.playedAt), 'h:mm a')}</span>
                      {s.id === best?.id && (
                        <span className="ml-2 text-xs font-bold bg-primary text-white px-1.5 py-0.5 rounded">BEST</span>
                      )}
                    </p>
                    {s.venueName && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3" />{s.venueName}
                      </p>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <Link href={`/users/${s.username}`} className="text-sm text-muted-foreground hover:text-white transition-colors">
                    {s.displayName ?? s.username}
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <span className="text-xs font-bold uppercase tracking-wider border border-white/20 rounded px-2 py-0.5 text-muted-foreground">
                    {s.type}
                  </span>
                </td>
                <td className="px-3 py-3 text-right font-bold text-lg text-primary">
                  {Number(s.score).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
