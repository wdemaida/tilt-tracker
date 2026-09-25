import { useState, type ReactNode } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Trophy, Repeat, CalendarDays, CalendarClock, MapPin, UploadCloud, Building2, Boxes, TrendingUp, X,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { PinballIcon } from '../components/PinballIcon';
import ComparisonScopePicker from '../components/ComparisonScopePicker';
import { useApi } from '../lib/useApi';
import { useComparisonScope, scopeQuery, scopeKey, type ComparisonScope } from '../lib/comparisonScope';
import { podColorTokens, podColorVars } from '../lib/podColor';
import type { PodRef } from '../lib/myPods';

// stat_history's period_date is a plain "YYYY-MM-DD" calendar date (America/New_York), not a UTC
// instant — parsing it with `new Date(str)` treats it as UTC midnight, which can display as the
// previous day in timezones behind UTC. Build the Date from local components instead.
function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

type Group = 'self' | 'pod' | 'other';

// Who a scoped number is about, in words — for the subtitle, the trend modal and the play-style note.
function whoLabel(scope: ComparisonScope, pod: PodRef | null): string {
  if (scope.kind === 'mine') return 'you';
  if (scope.kind === 'pod') return `you + ${pod?.name ?? 'your pod'}${scope.others ? ' + everyone else' : ''}`;
  return 'all players';
}

// Venue and machine-roster counts aren't about players, so Compare never changes them — their
// trend is always the site-wide daily snapshot.
const SITE_WIDE_KEYS = new Set(['total_venues', 'total_machines']);

function StatTrendModal({ statKey, label, scope, pod, onClose }: {
  statKey: string; label: string; scope: ComparisonScope; pod: PodRef | null; onClose: () => void;
}) {
  const api = useApi();
  const siteWide = SITE_WIDE_KEYS.has(statKey);
  // Site-wide keys come back identical in every scope; key them once so switching scope doesn't refetch.
  const qs = siteWide ? '' : scopeQuery(scope);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['stat-trend', statKey, siteWide ? 'all' : scopeKey(scope)],
    queryFn: () => api.stats.history(statKey, 90, qs),
  });

  const points = data?.points ?? [];
  const live = data?.source === 'live';
  // Line color follows who the series is about: you = yellow, your pod = its color, otherwise the
  // app's primary (the whole site, or a pod view with everyone else switched back in).
  const stroke = live && scope.kind === 'mine' ? 'hsl(var(--username))'
    : live && scope.kind === 'pod' && !scope.others && pod ? podColorTokens(pod.color).graphic
    : 'hsl(var(--primary))';
  const note = siteWide ? 'Site-wide daily snapshots — the same in every Compare view.'
    : live ? `Rebuilt from the current scores of ${whoLabel(scope, pod)}, by the day each was submitted.`
    : 'Site-wide daily snapshots.';

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
        ) : isError ? (
          <p className="text-muted-foreground text-sm">Couldn't load this trend.</p>
        ) : points.length < 2 ? (
          <p className="text-muted-foreground text-sm">
            {live ? 'Not enough history yet — these scores span less than two days.' : 'Not enough history yet — check back after a few more daily snapshots.'}
          </p>
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
                <Line type="monotone" dataKey="value" stroke={stroke} strokeWidth={2} dot={points.length > 45 ? false : { r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {!isLoading && !isError && <p className="text-xs text-muted-foreground mt-3">{note}</p>}
      </div>
    </div>
  );
}

// Group colors, per the app-wide rule: you = yellow `username`, the pod = its own color (scoped by
// podColorVars on a wrapper), everyone else = purple `field`.
const GROUP_BG: Record<Group, string> = { self: 'bg-username', pod: 'bg-pod', other: 'bg-field' };
const GROUP_TEXT: Record<Group, string> = { self: 'text-username', pod: 'text-pod-text', other: 'text-field' };

/** Who a total is made of: a thin stacked bar and the per-group numbers, in group colors. */
function GroupSplit({ parts }: { parts: { group: Group; value: number }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return null;
  return (
    <div className="mt-2">
      <div className="flex h-1 rounded-full overflow-hidden bg-white/10">
        {parts.map(p => p.value > 0 && <div key={p.group} className={GROUP_BG[p.group]} style={{ width: `${(p.value / total) * 100}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-1 text-[11px] font-bold tabular-nums">
        {parts.map(p => <span key={p.group} className={GROUP_TEXT[p.group]}>{p.value.toLocaleString()}</span>)}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon, label, value, statKey, onShowTrend, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  statKey?: string;
  onShowTrend?: (key: string, label: string) => void;
  children?: ReactNode;
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
      {children}
    </div>
  );
}

export default function StatsPage() {
  const api = useApi();
  const cs = useComparisonScope();
  const { scope, pod } = cs;
  const [trend, setTrend] = useState<{ key: string; label: string } | null>(null);
  const { data: stats, isLoading, isError } = useQuery({
    queryKey: ['stats', scopeKey(scope)],
    queryFn: () => api.stats.get(scopeQuery(scope)),
    enabled: cs.ready,
    // Keep the last scope's numbers on screen while the next loads, so the picker doesn't blink away.
    placeholderData: keepPreviousData,
  });

  const title = scope.kind === 'mine' ? 'My Stats' : scope.kind === 'pod' ? 'Pod Stats' : 'Site Stats';
  const subtitle = scope.kind === 'mine' ? 'Career metrics and performance analysis.'
    : scope.kind === 'pod' ? `Aggregate stats for ${whoLabel(scope, pod)}.`
    : 'Aggregate stats across all players.';

  // The groups this scope can contain, in stacking order. Mine has only you.
  const groups: Group[] = scope.kind === 'mine' ? ['self']
    : scope.kind === 'pod' ? (scope.others ? ['self', 'pod', 'other'] : ['self', 'pod'])
    : ['self', 'other'];
  const split = stats?.split as Record<Group, { plays: number; visits: number; playsThisMonth: number; visitsThisMonth: number }> | undefined;
  // Only worth drawing when at least two groups actually have plays — "you: 46, everyone else: 0" is noise.
  const showSplit = !!split && groups.filter(g => split[g].plays > 0).length >= 2;
  const splitOf = (field: 'plays' | 'visits' | 'playsThisMonth' | 'visitsThisMonth') =>
    showSplit ? <GroupSplit parts={groups.map(g => ({ group: g, value: split![g][field] }))} /> : null;
  const groupLabel: Record<Group, string> = { self: 'You', pod: pod?.name ?? 'Pod', other: 'Everyone else' };
  const podStyle = pod ? podColorVars(pod.color) : undefined;

  const header = (
    <>
      <h1 className="text-4xl font-black uppercase tracking-widest text-white mb-1">{title}</h1>
      <p className="text-sm text-muted-foreground mb-6">{subtitle}</p>

      {/* Compare decides whose scores every section below counts — except the site-wide facts at
          the bottom, which sit under their own divider. Same picker, URL and ScopeContext sync as
          the Machine and Venue pages. */}
      <div className="border-t border-white/10 pt-4 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Compare</span>
          <ComparisonScopePicker state={cs} />
        </div>
        {cs.unknownPod && (
          <p className="text-xs text-muted-foreground mt-2">That pod isn't one of yours — showing all players.</p>
        )}
        {showSplit && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs" style={podStyle}>
            {groups.map(g => (
              <span key={g} className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${GROUP_BG[g]}`} />
                <span className={`${g === 'pod' ? 'text-pod-text font-semibold truncate max-w-[10rem]' : 'text-muted-foreground'}`}>{groupLabel[g]}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </>
  );

  if (!cs.ready || (isLoading && !stats)) return <div>{header}<p className="text-muted-foreground">Loading...</p></div>;
  if (isError || !stats) return <div>{header}<p className="text-muted-foreground">Couldn't load stats.</p></div>;

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
  const tournamentPct = stats.totalGames ? Math.round((stats.playStyle?.tournament / stats.totalGames) * 100) : 0;
  const playsOf = scope.kind === 'mine' ? 'your recorded plays'
    : scope.kind === 'pod' ? `recorded plays by ${whoLabel(scope, pod)}`
    : 'all recorded plays';

  return (
    <div style={podStyle}>
      {header}

      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Totals</h2>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <StatCard icon={PinballIcon} label="Plays" value={stats.totalGames.toLocaleString()} statKey="total_plays" onShowTrend={showTrend}>
          {splitOf('plays')}
        </StatCard>
        <StatCard icon={MapPin} label="Visits" value={(stats.totalVisits ?? 0).toLocaleString()} statKey="total_visits" onShowTrend={showTrend}>
          {splitOf('visits')}
        </StatCard>
        <StatCard icon={Trophy} label="Machines w/ Score" value={(stats.uniqueMachines ?? 0).toLocaleString()} statKey="machines_with_score" onShowTrend={showTrend} />
      </div>

      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Monthly / Rates</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <StatCard icon={Repeat} label="Plays / Visit" value={(stats.playHabits?.avgPlaysPerVisit ?? 0).toFixed(1)} />
        <StatCard icon={CalendarDays} label="Plays This Month" value={(stats.playHabits?.playsThisMonth ?? 0).toLocaleString()} statKey="plays" onShowTrend={showTrend}>
          {splitOf('playsThisMonth')}
        </StatCard>
        <StatCard icon={CalendarClock} label="Visits This Month" value={(stats.playHabits?.visitsThisMonth ?? 0).toLocaleString()} statKey="visits" onShowTrend={showTrend}>
          {splitOf('visitsThisMonth')}
        </StatCard>
        <StatCard icon={UploadCloud} label="Overall Scores Submitted / Day" value={(stats.playHabits?.avgScoresSubmittedPerDay ?? 0).toFixed(1)} />
      </div>

      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Charts</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
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
                      {showSplit ? (
                        // Stacked by group, you at the base — the same colors as the legend above.
                        <div
                          className="flex flex-col-reverse rounded-t overflow-hidden"
                          style={{ width: 28, height: `${(m.plays / yMax) * 100}%`, minHeight: 4 }}
                          title={groups.map(g => `${groupLabel[g]}: ${m.byGroup?.[g] ?? 0}`).join(' · ')}
                        >
                          {groups.map(g => (m.byGroup?.[g] ?? 0) > 0 && (
                            <div key={g} className={GROUP_BG[g]} style={{ height: `${(m.byGroup[g] / m.plays) * 100}%` }} />
                          ))}
                        </div>
                      ) : (
                        <div
                          className="rounded-t bg-primary"
                          style={{ width: 28, height: `${(m.plays / yMax) * 100}%`, minHeight: 4 }}
                        />
                      )}
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
              Tournament games account for {tournamentPct}% of {playsOf}.
            </p>
          </div>
        </div>
      </div>

      {/* Facts about TiltTrack itself, not about players — Compare doesn't touch them. */}
      <div className="border-t border-white/10 pt-4">
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">Across TiltTrack</h2>
        <p className="text-xs text-muted-foreground mb-3">Site-wide — the same in every Compare view.</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard icon={Building2} label="Venues" value={(stats.totalVenues ?? 0).toLocaleString()} statKey="total_venues" onShowTrend={showTrend} />
          <StatCard icon={Boxes} label="Machines in System" value={(stats.totalMachinesInSystem ?? 0).toLocaleString()} statKey="total_machines" onShowTrend={showTrend} />
        </div>
      </div>

      {trend && <StatTrendModal statKey={trend.key} label={trend.label} scope={scope} pod={pod} onClose={() => setTrend(null)} />}
    </div>
  );
}
