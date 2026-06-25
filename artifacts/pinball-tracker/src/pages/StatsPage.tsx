import { useQuery } from '@tanstack/react-query';
import { Trophy, Gamepad2 } from 'lucide-react';
import { useApi } from '../lib/useApi';

export default function StatsPage() {
  const api = useApi();
  const { data: stats, isLoading } = useQuery({ queryKey: ['stats'], queryFn: api.stats.get });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!stats) return null;

  const maxPlays = Math.max(...(stats.mostPlayed?.map((m: any) => m.plays) ?? [1]));

  return (
    <div>
      <h1 className="text-4xl font-black uppercase tracking-widest text-white mb-1">Player Stats</h1>
      <p className="text-sm text-muted-foreground mb-8">Career metrics and performance analysis.</p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <div className="rounded-xl border border-white/10 bg-card p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            <Gamepad2 className="w-4 h-4" /> Total Games Logged
          </div>
          <p className="text-5xl font-black text-white">{stats.totalGames}</p>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            <Trophy className="w-4 h-4" /> All-Time High Score
          </div>
          <p className="text-4xl font-black text-primary">{Number(stats.allTimeHigh?.score ?? 0).toLocaleString()}</p>
          <p className="text-sm text-white mt-1">{stats.allTimeHigh?.machineName}</p>
          {stats.allTimeHigh?.venueName && (
            <p className="text-xs text-muted-foreground">Achieved at {stats.allTimeHigh.venueName}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Most Played Machines</h2>
          <div className="flex items-end gap-3 h-32">
            {stats.mostPlayed?.map((m: any) => (
              <div key={m.name} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-primary"
                  style={{ height: `${(m.plays / maxPlays) * 100}%`, minHeight: 4 }}
                />
                <p className="text-xs text-muted-foreground text-center truncate w-full">{m.name.split(':')[0]}</p>
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
              Tournament games account for {stats.totalGames ? Math.round((stats.playStyle?.tournament / stats.totalGames) * 100) : 0}% of your total recorded plays.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
