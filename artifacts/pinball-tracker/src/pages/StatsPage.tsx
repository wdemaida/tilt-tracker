import { useQuery } from '@tanstack/react-query';
import { Trophy } from 'lucide-react';
import { PinballIcon } from '../components/PinballIcon';
import { useApi } from '../lib/useApi';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';

export default function StatsPage() {
  const api = useApi();
  const { mine } = useScopeContext();
  const { data: stats, isLoading } = useQuery({
    queryKey: ['stats', mine],
    queryFn: () => api.stats.get(mine),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!stats) return null;

  const top5 = (stats.mostPlayed ?? []).slice(0, 5);
  const maxPlays = Math.max(...top5.map((m: any) => m.plays), 1);

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">{mine ? 'My Stats' : 'Site Stats'}</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-8">{mine ? 'Career metrics and performance analysis.' : 'Aggregate stats across all players.'}</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="rounded-xl border border-white/10 bg-card p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            <PinballIcon className="w-4 h-4" /> Total Games Logged
          </div>
          <p className="text-5xl font-black text-white">{stats.totalGames}</p>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            <Trophy className="w-4 h-4" /> Unique Machines
          </div>
          <p className="text-5xl font-black text-white">{stats.mostPlayed?.length ?? 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Most Played Machines</h2>
          {/* Bars — equal fixed width per column */}
          <div className="flex items-end justify-around" style={{ height: 120 }}>
            {top5.map((m: any) => (
              <div key={m.name} className="flex-1 flex justify-center items-end h-full">
                <div
                  className="rounded-t bg-primary"
                  style={{ width: 28, height: `${(m.plays / maxPlays) * 100}%`, minHeight: 4 }}
                />
              </div>
            ))}
          </div>
          {/* Baseline */}
          <div className="border-t border-white/10" />
          {/* Labels at 45° — end of name anchored at bar center */}
          <div className="flex justify-around" style={{ height: 110 }}>
            {top5.map((m: any) => (
              <div key={m.name} className="flex-1 relative" style={{ overflow: 'visible' }}>
                <span
                  className="absolute text-muted-foreground"
                  style={{
                    bottom: 0,
                    right: '50%',
                    fontSize: 10,
                    lineHeight: 1,
                    whiteSpace: 'nowrap',
                    transformOrigin: 'right bottom',
                    transform: 'rotate(45deg)',
                  }}
                >
                  {m.name.split(':')[0]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Play Style</h2>
          <div className="flex flex-col gap-3">
            {[
              { label: 'Casual Drops', value: stats.playStyle?.casual ?? 0 },
              { label: 'Tournament Play', value: stats.playStyle?.tournament ?? 0 },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-bold text-white">{value}</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${stats.totalGames ? (value / stats.totalGames) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground mt-2">
              Tournament games account for {stats.totalGames ? Math.round((stats.playStyle?.tournament / stats.totalGames) * 100) : 0}% of {mine ? 'your' : 'all'} recorded plays.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
