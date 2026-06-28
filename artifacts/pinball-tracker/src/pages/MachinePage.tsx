import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { Trophy, ArrowLeft, MapPin, PlusCircle, ChevronUp, ChevronDown, TrendingUp } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';

type SortKey = 'playedAt' | 'username' | 'type' | 'score';
type SortDir = 'asc' | 'desc';
type ChartMode = 'date' | 'session';

// Yellow = current user (matches app convention); rest are accent colors
const PALETTE = ['#facc15', '#a855f7', '#22d3ee', '#f97316', '#34d399', '#f472b6', '#60a5fa'];

function formatScore(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(v);
}

function computeChartData(scores: any[], usernames: string[], mode: ChartMode) {
  if (scores.length < 2) return [];

  if (mode === 'date') {
    const dateMap = new Map<string, Record<string, any>>();
    for (const s of scores) {
      const key = format(new Date(s.playedAt), 'yyyy-MM-dd');
      if (!dateMap.has(key)) dateMap.set(key, { x: key });
      const entry = dateMap.get(key)!;
      if (entry[s.username] === undefined || s.score > entry[s.username]) {
        entry[s.username] = s.score;
        entry[`${s.username}_date`] = s.playedAt;
        entry[`${s.username}_venue`] = s.venueName;
      }
    }
    return [...dateMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v);
  }

  // Session mode — per-user chronological sessions
  const sessions: Record<string, any[]> = {};
  for (const u of usernames) {
    sessions[u] = scores
      .filter(s => s.username === u)
      .sort((a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime());
  }
  const maxLen = Math.max(...usernames.map(u => sessions[u].length));
  return Array.from({ length: maxLen }, (_, i) => {
    const entry: any = { x: i + 1 };
    for (const u of usernames) {
      const s = sessions[u][i];
      if (s) {
        entry[u] = s.score;
        entry[`${u}_date`] = s.playedAt;
        entry[`${u}_venue`] = s.venueName;
      }
    }
    return entry;
  });
}

function CustomTooltip({ active, payload, label, mode }: any) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter((p: any) => p.value != null);
  if (!visible.length) return null;
  return (
    <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-3 text-xs shadow-xl min-w-[160px]">
      <p className="font-bold text-white mb-2">
        {mode === 'date'
          ? format(parseISO(String(label)), 'MMM d, yyyy')
          : `Session ${label}`}
      </p>
      {visible.map((p: any) => (
        <div key={p.dataKey} className="flex flex-col mb-1.5 last:mb-0">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span style={{ color: p.color }} className="font-semibold">{p.dataKey}</span>
          </div>
          <div className="pl-3.5 text-white font-bold">{Number(p.value).toLocaleString()}</div>
          {p.payload[`${p.dataKey}_date`] && (
            <div className="pl-3.5 text-muted-foreground">
              {format(new Date(p.payload[`${p.dataKey}_date`]), 'MMM d, yyyy')}
              {p.payload[`${p.dataKey}_venue`] && ` · ${p.payload[`${p.dataKey}_venue`]}`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function MachinePage() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [chartMode, setChartMode] = useState<ChartMode>('date');

  const authApi = useApi();
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: authApi.users.me,
    retry: false,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['machine', decodedName],
    queryFn: () => api.machines.get(decodedName),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Machine not found.</p>;

  const { machine, scores } = data;
  const best = scores.reduce((a: any, b: any) => (b.score > a.score ? b : a), scores[0]);

  // Build ordered username list: current user first (yellow), then others
  const myUsername = (me as any)?.username;
  const allUsernames = [...new Set<string>(scores.map((s: any) => s.username))] as string[];
  const orderedUsernames = myUsername
    ? [myUsername, ...allUsernames.filter(u => u !== myUsername)]
    : allUsernames;

  const chartData = computeChartData(scores, orderedUsernames, chartMode);
  const showChart = scores.length >= 2;

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

      {/* Header */}
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

      {/* Top Score */}
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

      {/* Trend Chart */}
      {showChart && (
        <div className="rounded-xl border border-white/10 bg-card p-5 mb-6">
          <div className="flex items-center justify-between mb-4 gap-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-white">Score Trend</h2>
            </div>
            <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider">
              <button
                onClick={() => setChartMode('date')}
                className={`px-3 py-1.5 rounded-md transition-colors ${chartMode === 'date' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'}`}
              >
                By Date
              </button>
              <button
                onClick={() => setChartMode('session')}
                className={`px-3 py-1.5 rounded-md transition-colors ${chartMode === 'session' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'}`}
              >
                By Session
              </button>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                dataKey="x"
                tick={{ fill: '#71717a', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={chartMode === 'date'
                  ? (v) => format(parseISO(String(v)), 'MMM d')
                  : (v) => `#${v}`}
              />
              <YAxis
                tick={{ fill: '#71717a', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatScore}
                width={48}
              />
              <Tooltip
                content={<CustomTooltip mode={chartMode} />}
                cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
              />
              {orderedUsernames.length > 1 && (
                <Legend
                  formatter={(value) => (
                    <span style={{ color: PALETTE[orderedUsernames.indexOf(value)] ?? '#888', fontSize: 11 }}>
                      {value}
                    </span>
                  )}
                />
              )}
              {orderedUsernames.map((u, i) => (
                <Line
                  key={u}
                  type="monotone"
                  dataKey={u}
                  stroke={PALETTE[i] ?? '#888'}
                  strokeWidth={i === 0 && myUsername ? 2.5 : 1.5}
                  dot={{ fill: PALETTE[i] ?? '#888', r: 4, strokeWidth: 0 }}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>

          {chartMode === 'session' && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Sessions are numbered chronologically per player — gaps in calendar time are not shown.
            </p>
          )}
          {chartMode === 'date' && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              X-axis is actual calendar date — gaps in play appear as spacing.
            </p>
          )}
        </div>
      )}

      {/* Scores Table */}
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
