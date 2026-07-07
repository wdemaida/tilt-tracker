import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Trophy, Repeat, CalendarDays, CalendarClock, MapPin, UploadCloud, Building2, Boxes, TrendingUp, X,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { PinballIcon } from '../components/PinballIcon';
import { useApi } from '../lib/useApi';
import { useScopeContext } from '../lib/ScopeContext';
import { ScopeToggle } from '../components/ScopeToggle';

// stat_history's period_date is a plain "YYYY-MM-DD" calendar date (America/New_York), not a UTC
// instant — parsing it with `new Date(str)` treats it as UTC midnight, which can display as the
// previous day in timezones behind UTC. Build the Date from local components instead.
function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function StatTrendModal({ statKey, label, onClose }: { statKey: string; label: string; onClose: () => void }) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['stat-trend', statKey],
    queryFn: () => api.stats.history(statKey, 90),
  });

  const points = data?.points ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-black uppercase tracking-widest text-white">{label} Trend</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : points.length < 2 ? (
          <p className="text-muted-foreground text-sm">Not enough history yet — check back after a few more daily snapshots.</p>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <LineChart data={points} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                <XAxis
                  dataKey="periodDate"
                  tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }}
                  tickFormatter={d => parseDateOnly(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
                />
                <YAxis tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }} allowDecimals={false} width={40} />
                <Tooltip
                  contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                  labelStyle={{ color: 'rgba(255,255,255,0.7)' }}
                  labelFormatter={d => parseDateOnly(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  formatter={v => [Number(v ?? 0).toLocaleString(), label]}
                />
                <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon, label, value, statKey, onShowTrend,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  statKey?: string;
  onShowTrend?: (key: string, label: string) => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-card p-5">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground min-w-0">
          <Icon className="w-4 h-4 flex-shrink-0" /> <span className="truncate">{label}</span>
        </div>
        {statKey && onShowTrend && (
          <button
            onClick={() => onShowTrend(statKey, label)}
            className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0"
            aria-label={`View ${label} trend`}
          >
            <TrendingUp className="w-4 h-4" />
          </button>
        )}
      </div>
      <p className="text-3xl font-black text-white">{value}</p>
    </div>
  );
}

export default function StatsPage() {
  const api = useApi();
  const { mine } = useScopeContext();
  const [trend, setTrend] = useState<{ key: string; label: string } | null>(null);
  const { data: stats, isLoading } = useQuery({
    queryKey: ['stats', mine],
    queryFn: () => api.stats.get(mine),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!stats) return null;

  const top5 = (stats.mostPlayed ?? []).slice(0, 5);
  const maxPlays = Math.max(...top5.map((m: any) => m.plays), 1);

  const getNiceStep = (max: number): number => {
    if (max <= 0) return 1;
    const rough = Math.max(max / 4, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    if (norm <= 1) return mag;
    if (norm <= 2) return 2 * mag;
    if (norm <= 5) return 5 * mag;
    return 10 * mag;
  };
  const yStep = getNiceStep(maxPlays);
  const yMax  = Math.max(Math.ceil(maxPlays / yStep) * yStep, yStep);
  const yTicks = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep);

  const showTrend = (key: string, label: string) => setTrend({ key, label });

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-4xl font-black uppercase tracking-widest text-white">{mine ? 'My Stats' : 'Site Stats'}</h1>
        <ScopeToggle />
      </div>
      <p className="text-sm text-muted-foreground mb-8">{mine ? 'Career metrics and performance analysis.' : 'Aggregate stats across all players.'}</p>

      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Totals</h2>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard icon={PinballIcon} label="Plays" value={stats.totalGames.toLocaleString()} statKey="total_plays" onShowTrend={showTrend} />
        <StatCard icon={MapPin} label="Visits" value={(stats.totalVisits ?? 0).toLocaleString()} statKey="total_visits" onShowTrend={showTrend} />
        <StatCard icon={Building2} label="Venues" value={(stats.totalVenues ?? 0).toLocaleString()} statKey="total_venues" onShowTrend={showTrend} />
        <StatCard icon={Trophy} label="Machines w/ Score" value={(stats.uniqueMachines ?? 0).toLocaleString()} statKey="machines_with_score" onShowTrend={showTrend} />
        <StatCard icon={Boxes} label="Machines in System" value={(stats.totalMachinesInSystem ?? 0).toLocaleString()} statKey="total_machines" onShowTrend={showTrend} />
      </div>

      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Monthly / Rates</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Repeat} label="Plays / Visit" value={(stats.playHabits?.avgPlaysPerVisit ?? 0).toFixed(1)} />
        <StatCard icon={CalendarDays} label="Plays This Month" value={(stats.playHabits?.playsThisMonth ?? 0).toLocaleString()} statKey="plays" onShowTrend={showTrend} />
        <StatCard icon={CalendarClock} label="Visits This Month" value={(stats.playHabits?.visitsThisMonth ?? 0).toLocaleString()} statKey="visits" onShowTrend={showTrend} />
        <StatCard icon={UploadCloud} label="Overall Scores Submitted / Day" value={(stats.playHabits?.avgScoresSubmittedPerDay ?? 0).toFixed(1)} />
      </div>

      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Charts</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Most Played Machines</h3>
          <div className="flex gap-1">
            {/* Y-axis */}
            <div className="flex-shrink-0 relative border-r border-white/10" style={{ width: 28, height: 120 }}>
              {yTicks.map(tick => (
                <span
                  key={tick}
                  className="absolute right-1 text-muted-foreground"
                  style={{ bottom: `${(tick / yMax) * 100}%`, fontSize: 9, lineHeight: 1, transform: 'translateY(50%)' }}
                >
                  {tick}
                </span>
              ))}
            </div>
            {/* Bars + baseline + labels */}
            <div className="flex-1 min-w-0">
              {/* Bar area with gridlines */}
              <div className="relative" style={{ height: 120 }}>
                {yTicks.filter(t => t > 0).map(tick => (
                  <div
                    key={tick}
                    className="absolute left-0 right-0 border-t border-white/5"
                    style={{ bottom: `${(tick / yMax) * 100}%` }}
                  />
                ))}
                <div className="flex items-end justify-around h-full">
                  {top5.map((m: any) => (
                    <div key={m.name} className="flex-1 flex justify-center items-end h-full">
                      <div
                        className="rounded-t bg-primary"
                        style={{ width: 28, height: `${(m.plays / yMax) * 100}%`, minHeight: 4 }}
                      />
                    </div>
                  ))}
                </div>
              </div>
              {/* Baseline */}
              <div className="border-t border-white/20" />
              {/* Labels: pivot at right-top so last char sits at x-axis, text descends below */}
              <div className="flex justify-around" style={{ height: 110 }}>
                {top5.map((m: any) => (
                  <div key={m.name} className="flex-1 relative" style={{ overflow: 'visible' }}>
                    <span
                      className="absolute text-machine"
                      style={{
                        top: 0,
                        right: '50%',
                        fontSize: 10,
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                        transformOrigin: 'right top',
                        transform: 'rotate(-45deg)',
                      }}
                    >
                      {m.name.split(':')[0]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-card p-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Play Style</h3>
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

      {trend && <StatTrendModal statKey={trend.key} label={trend.label} onClose={() => setTrend(null)} />}
    </div>
  );
}
