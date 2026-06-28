import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import {
  Trophy, ArrowLeft, MapPin, PlusCircle,
  ChevronUp, ChevronDown, TrendingUp, Users, ChevronDown as ChevronDownIcon,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import {
  ComposedChart, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';

// ─── constants ────────────────────────────────────────────────────────────────

const VENUE_COLORS = ['#22d3ee', '#f97316', '#34d399', '#f472b6', '#60a5fa', '#e879f9'];

type SortKey  = 'playedAt' | 'username' | 'type' | 'score';
type SortDir  = 'asc' | 'desc';
type ChartMode = 'date' | 'session';
type ViewMode  = 'aggregate' | 'chaos';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatScore(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${Math.round(v / 1_000)}K`;
  return String(v);
}

function statsMedian(arr: number[]): number | null {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ─── chart data builders ──────────────────────────────────────────────────────

function buildAggregateData(scores: any[], myUsername: string | null, mode: ChartMode) {
  if (mode === 'date') {
    const map = new Map<string, { mineArr: number[]; mineRaw?: any; fieldArr: number[] }>();
    for (const s of scores) {
      const key = format(new Date(s.playedAt), 'yyyy-MM-dd');
      if (!map.has(key)) map.set(key, { mineArr: [], fieldArr: [] });
      const e = map.get(key)!;
      if (s.username === myUsername) {
        e.mineArr.push(Number(s.score));
        if (!e.mineRaw || s.score > e.mineRaw.score) e.mineRaw = s;
      } else {
        e.fieldArr.push(Number(s.score));
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, e]) => ({
      x: key,
      my:    e.mineArr.length ? Math.max(...e.mineArr) : null,
      field: statsMedian(e.fieldArr),
      my_date:  e.mineRaw?.playedAt,
      my_venue: e.mineRaw?.venueName,
    }));
  }

  // session mode
  const mySessions = myUsername
    ? [...scores.filter(s => s.username === myUsername)]
        .sort((a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime())
    : [];
  const others = [...new Set(scores.filter(s => s.username !== myUsername).map(s => s.username as string))];
  const otherMap: Record<string, any[]> = {};
  for (const u of others) {
    otherMap[u] = [...scores.filter(s => s.username === u)]
      .sort((a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime());
  }
  const maxN = Math.max(mySessions.length, ...others.map(u => otherMap[u].length), 0);

  return Array.from({ length: maxN }, (_, i) => {
    const mine = mySessions[i];
    const fieldScores = others.map(u => otherMap[u][i]?.score).filter(v => v != null).map(Number);
    return {
      x: i + 1,
      my:    mine ? Number(mine.score) : null,
      field: statsMedian(fieldScores),
      my_date:  mine?.playedAt,
      my_venue: mine?.venueName,
    };
  });
}

function buildVenueComparisonData(
  scores: any[],
  selectedVenueIds: number[],
  myUsername: string | null,
  mode: ChartMode,
) {
  const venues = [...new Map(
    scores
      .filter(s => selectedVenueIds.includes(s.venueId) && s.venueId != null && s.venueName)
      .map(s => [s.venueId as number, s.venueName as string]),
  ).entries()].map(([id, name]) => ({ id, name }));

  if (mode === 'date') {
    const map = new Map<string, Record<string, any>>();
    for (const s of scores) {
      if (!selectedVenueIds.includes(s.venueId) || s.username !== myUsername) continue;
      const key = format(new Date(s.playedAt), 'yyyy-MM-dd');
      if (!map.has(key)) map.set(key, { x: key });
      const e = map.get(key)!;
      const vk = s.venueName as string;
      if (e[vk] == null || s.score > e[vk]) {
        e[vk] = Number(s.score);
        e[`${vk}_date`] = s.playedAt;
      }
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  }

  // session mode — per venue
  const venueRows: Record<number, any[]> = {};
  for (const v of venues) {
    venueRows[v.id] = [...scores.filter(s => s.venueId === v.id && s.username === myUsername)]
      .sort((a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime());
  }
  const maxN = Math.max(...venues.map(v => venueRows[v.id].length), 0);

  return Array.from({ length: maxN }, (_, i) => {
    const entry: any = { x: i + 1 };
    for (const v of venues) {
      const s = venueRows[v.id][i];
      if (s) { entry[v.name] = Number(s.score); entry[`${v.name}_date`] = s.playedAt; }
    }
    return entry;
  });
}

function buildChaosData(scores: any[], selectedVenueIds: number[], myUsername: string | null, mode: ChartMode) {
  const filtered = selectedVenueIds.length > 0
    ? scores.filter(s => selectedVenueIds.includes(s.venueId))
    : scores;
  const usernames = [...new Set<string>(filtered.map(s => s.username))];
  const ordered   = myUsername ? [myUsername, ...usernames.filter(u => u !== myUsername)] : usernames;

  if (mode === 'date') {
    const map = new Map<string, Record<string, any>>();
    for (const s of filtered) {
      const key = format(new Date(s.playedAt), 'yyyy-MM-dd');
      if (!map.has(key)) map.set(key, { x: key });
      const e = map.get(key)!;
      if (e[s.username] == null || s.score > e[s.username]) {
        e[s.username] = Number(s.score);
        e[`${s.username}_date`]  = s.playedAt;
        e[`${s.username}_venue`] = s.venueName;
      }
    }
    return { data: [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v), ordered };
  }

  const sessions: Record<string, any[]> = {};
  for (const u of ordered) {
    sessions[u] = [...filtered.filter(s => s.username === u)]
      .sort((a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime());
  }
  const maxN = Math.max(...ordered.map(u => sessions[u].length), 0);
  const data = Array.from({ length: maxN }, (_, i) => {
    const entry: any = { x: i + 1 };
    for (const u of ordered) {
      const s = sessions[u][i];
      if (s) { entry[u] = Number(s.score); entry[`${u}_date`] = s.playedAt; entry[`${u}_venue`] = s.venueName; }
    }
    return entry;
  });
  return { data, ordered };
}

// ─── tooltip ──────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, chartMode, myUsername }: any) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter((p: any) => p.value != null);
  if (!visible.length) return null;
  return (
    <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-3 text-xs shadow-xl min-w-[180px]">
      <p className="font-bold text-white mb-2">
        {chartMode === 'date' ? format(parseISO(String(label)), 'MMM d, yyyy') : `Session ${label}`}
      </p>
      {visible.map((p: any) => {
        const display = p.dataKey === 'my' ? `You (${myUsername ?? 'you'})` : p.dataKey === 'field' ? 'Field median' : p.dataKey;
        const dateVal = p.payload[`${p.dataKey}_date`];
        const venue   = p.payload[`${p.dataKey}_venue`];
        return (
          <div key={p.dataKey} className="mb-1.5 last:mb-0">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
              <span style={{ color: p.color }} className="font-semibold truncate max-w-[140px]">{display}</span>
            </div>
            <div className="pl-3.5 font-bold text-white">{Number(p.value).toLocaleString()}</div>
            {dateVal && <div className="pl-3.5 text-muted-foreground">{format(new Date(dateVal), 'MMM d, yyyy')}{venue ? ` · ${venue}` : ''}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── venue dropdown ───────────────────────────────────────────────────────────

interface VenueOption { venueId: number; venueName: string }

function VenueDropdown({ venues, selectedIds, onToggle, onClear }: {
  venues: VenueOption[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  onClear: () => void;
}) {
  const label = selectedIds.length === 0
    ? 'All Venues'
    : selectedIds.length === 1
      ? venues.find(v => v.venueId === selectedIds[0])?.venueName ?? '1 venue'
      : `${selectedIds.length} venues`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 bg-white/5 text-xs font-bold text-muted-foreground hover:text-white hover:border-white/40 transition-colors outline-none">
        <MapPin className="w-3 h-3" />
        {label}
        <ChevronDownIcon className="w-3 h-3 ml-0.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-[180px] rounded-xl border border-white/15 bg-zinc-900 p-1 shadow-xl"
          sideOffset={6}
          align="end"
        >
          <DropdownMenu.CheckboxItem
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer outline-none hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
            checked={selectedIds.length === 0}
            onCheckedChange={onClear}
          >
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${selectedIds.length === 0 ? 'bg-primary border-primary' : 'border-white/30'}`}>
              {selectedIds.length === 0 && <ChevronUp className="w-2.5 h-2.5 text-white" />}
            </div>
            All Venues
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 border-t border-white/10" />
          {venues.map(v => (
            <DropdownMenu.CheckboxItem
              key={v.venueId}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer outline-none hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
              checked={selectedIds.includes(v.venueId)}
              onCheckedChange={() => onToggle(v.venueId)}
            >
              <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${selectedIds.includes(v.venueId) ? 'bg-primary border-primary' : 'border-white/30'}`}>
                {selectedIds.includes(v.venueId) && <ChevronUp className="w-2.5 h-2.5 text-white" />}
              </div>
              <span className="truncate">{v.venueName}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ─── venue difficulty ─────────────────────────────────────────────────────────

function difficultyLabel(pct: number): { text: string; color: string } {
  if (pct <= -15) return { text: 'Much Easier',  color: '#34d399' };
  if (pct <= -5)  return { text: 'Easier',        color: '#86efac' };
  if (pct <   5)  return { text: 'Average',       color: '#71717a' };
  if (pct <  15)  return { text: 'Harder',        color: '#fb923c' };
  return               { text: 'Much Harder',   color: '#f87171' };
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function MachinePage() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name);

  const [sortKey,  setSortKey]  = useState<SortKey>('score');
  const [sortDir,  setSortDir]  = useState<SortDir>('desc');
  const [chartMode, setChartMode] = useState<ChartMode>('date');
  const [viewMode,  setViewMode]  = useState<ViewMode>('aggregate');
  const [selectedVenueIds, setSelectedVenueIds] = useState<number[]>([]);

  const authApi = useApi();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: authApi.users.me, retry: false });
  const myUsername = (me as any)?.username as string | null | undefined ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ['machine', decodedName],
    queryFn: () => api.machines.get(decodedName),
  });

  // ── derived data ────────────────────────────────────────────────────────────

  const uniqueVenues = useMemo<VenueOption[]>(() => {
    if (!data?.scores) return [];
    return [...new Map<number, VenueOption>(
      (data.scores as any[])
        .filter((s: any) => s.venueId != null && s.venueName)
        .map((s: any) => [s.venueId as number, { venueId: s.venueId, venueName: s.venueName }]),
    ).values()];
  }, [data]);

  const venueDifficulty = useMemo(() => {
    if (!data?.scores || uniqueVenues.length < 2) return [];
    const scores = data.scores as any[];
    const globalAvg = scores.reduce((sum: number, s: any) => sum + Number(s.score), 0) / scores.length;
    return uniqueVenues.map(v => {
      const vScores = scores.filter((s: any) => s.venueId === v.venueId).map((s: any) => Number(s.score));
      const avg = vScores.reduce((a, b) => a + b, 0) / vScores.length;
      const diffPct = ((avg - globalAvg) / globalAvg) * 100;
      return { ...v, avgScore: Math.round(avg), count: vScores.length, diffPct };
    }).sort((a, b) => a.diffPct - b.diffPct);
  }, [data, uniqueVenues]);

  const { chartData, chaosOrdered, venueLines } = useMemo(() => {
    if (!data?.scores || data.scores.length < 2) {
      return { chartData: [], chaosOrdered: [] as string[], venueLines: [] as string[] };
    }
    const scores = data.scores as any[];

    if (viewMode === 'chaos') {
      const { data: cd, ordered } = buildChaosData(scores, selectedVenueIds, myUsername, chartMode);
      return { chartData: cd, chaosOrdered: ordered, venueLines: [] };
    }

    // aggregate mode
    if (selectedVenueIds.length > 0) {
      // venue comparison
      const cd = buildVenueComparisonData(scores, selectedVenueIds, myUsername, chartMode);
      const lines = [...new Set<string>(
        scores.filter((s: any) => selectedVenueIds.includes(s.venueId)).map((s: any) => s.venueName as string),
      )];
      return { chartData: cd, chaosOrdered: [], venueLines: lines };
    }

    // you vs field
    const cd = buildAggregateData(scores, myUsername, chartMode);
    return { chartData: cd, chaosOrdered: [], venueLines: [] };
  }, [data, viewMode, selectedVenueIds, myUsername, chartMode]);

  // ── sort table ──────────────────────────────────────────────────────────────

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Machine not found.</p>;

  const { machine, scores } = data;
  const best = (scores as any[]).reduce((a: any, b: any) => (b.score > a.score ? b : a), scores[0]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'score' ? 'desc' : 'asc'); }
  }
  const sorted = [...(scores as any[])].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'playedAt') cmp = new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime();
    else if (sortKey === 'username') cmp = (a.username ?? '').localeCompare(b.username ?? '');
    else if (sortKey === 'type')     cmp = (a.type ?? '').localeCompare(b.type ?? '');
    else if (sortKey === 'score')    cmp = a.score - b.score;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronUp className="w-3 h-3 opacity-20" />;
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3 text-primary" /> : <ChevronDown className="w-3 h-3 text-primary" />;
  }
  function SortableHeader({ col, label, align = 'left' }: { col: SortKey; label: string; align?: 'left' | 'right' }) {
    return (
      <th className={`py-3 px-3 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button
          onClick={() => toggleSort(col)}
          className={`flex items-center gap-1 text-xs font-bold uppercase tracking-wider transition-colors ${sortKey === col ? 'text-primary' : 'text-muted-foreground hover:text-white'} ${align === 'right' ? 'ml-auto' : ''}`}
        >
          {label}<SortIcon col={col} />
        </button>
      </th>
    );
  }

  const showChart = (scores as any[]).length >= 2;
  const isVenueComparison = viewMode === 'aggregate' && selectedVenueIds.length > 0;

  // chaos mode: yellow = me, muted purple for others
  function chaosColor(u: string) { return u === myUsername ? '#facc15' : '#a855f7'; }

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div>
      <Link href="/machines" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors mb-4">
        <ArrowLeft className="w-4 h-4" /> All Machines
      </Link>

      {/* Header */}
      <div className="flex items-start gap-5 mb-6">
        {machine.imageUrl && (
          <img src={machine.imageUrl} alt={machine.name} className="w-24 h-24 rounded-xl object-cover border border-white/10 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-black uppercase tracking-widest text-white leading-tight">{machine.name}</h1>
              {(machine.manufacturer || machine.year) && (
                <p className="text-sm text-muted-foreground mt-0.5">{[machine.manufacturer, machine.year].filter(Boolean).join(' · ')}</p>
              )}
              <p className="text-sm text-muted-foreground mt-1">{scores.length} scores recorded</p>
            </div>
            <Link href="/add" className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary text-primary text-sm font-bold uppercase tracking-wider hover:bg-primary hover:text-white transition-colors flex-shrink-0">
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
              {best.displayName ?? best.username}{' · '}{format(new Date(best.playedAt), 'MMM d, yyyy')}{best.venueName && ` · ${best.venueName}`}
            </p>
          </div>
        </div>
      )}

      {/* Trend Chart */}
      {showChart && (
        <div className="rounded-xl border border-white/10 bg-card p-5 mb-6">
          {/* Chart header row */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="flex items-center gap-2 mr-auto">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-white">Score Trend</h2>
            </div>

            {/* Venue filter — only when 2+ venues */}
            {uniqueVenues.length >= 2 && viewMode === 'aggregate' && (
              <VenueDropdown
                venues={uniqueVenues}
                selectedIds={selectedVenueIds}
                onToggle={id => setSelectedVenueIds(prev =>
                  prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
                )}
                onClear={() => setSelectedVenueIds([])}
              />
            )}

            {/* Date / Session toggle */}
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

            {/* Chaos mode toggle */}
            <button
              onClick={() => { setViewMode(v => v === 'chaos' ? 'aggregate' : 'chaos'); setSelectedVenueIds([]); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors ${viewMode === 'chaos' ? 'border-fuchsia-500 text-fuchsia-400 bg-fuchsia-500/10' : 'border-white/20 text-muted-foreground hover:text-white hover:border-white/40'}`}
              title="Show all individual players"
            >
              <Users className="w-3 h-3" />
              All Players
            </button>
          </div>

          {/* Legend for aggregate mode */}
          {viewMode === 'aggregate' && !isVenueComparison && (
            <div className="flex items-center gap-4 mb-3 text-xs">
              {myUsername && (
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-0.5 rounded bg-yellow-400" />
                  <span className="text-muted-foreground">You ({myUsername})</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="#a855f7" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                <span className="text-muted-foreground">Field median</span>
              </div>
            </div>
          )}

          {/* Venue comparison legend */}
          {isVenueComparison && venueLines.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
              {venueLines.map((vn, i) => (
                <div key={vn} className="flex items-center gap-1.5">
                  <div className="w-3 h-0.5 rounded" style={{ background: VENUE_COLORS[i % VENUE_COLORS.length] }} />
                  <span className="text-muted-foreground truncate max-w-[120px]">{vn}</span>
                </div>
              ))}
            </div>
          )}

          <ResponsiveContainer width="100%" height={220}>
            {viewMode === 'aggregate' && !isVenueComparison ? (
              <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="x" tick={{ fill: '#71717a', fontSize: 11 }} tickLine={false} axisLine={false}
                  tickFormatter={chartMode === 'date' ? (v) => format(parseISO(String(v)), 'MMM d') : (v) => `#${v}`} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatScore} width={48} />
                <Tooltip content={<ChartTooltip chartMode={chartMode} myUsername={myUsername} />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />
                <Line type="monotone" dataKey="field" stroke="#a855f7" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
                {myUsername && (
                  <Line type="monotone" dataKey="my" stroke="#facc15" strokeWidth={2.5}
                    dot={{ fill: '#facc15', r: 4, strokeWidth: 0 }} activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                )}
              </ComposedChart>
            ) : (
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="x" tick={{ fill: '#71717a', fontSize: 11 }} tickLine={false} axisLine={false}
                  tickFormatter={chartMode === 'date' ? (v) => format(parseISO(String(v)), 'MMM d') : (v) => `#${v}`} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatScore} width={48} />
                <Tooltip content={<ChartTooltip chartMode={chartMode} myUsername={myUsername} />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />
                {isVenueComparison
                  ? venueLines.map((vn, i) => (
                      <Line key={vn} type="monotone" dataKey={vn}
                        stroke={VENUE_COLORS[i % VENUE_COLORS.length]} strokeWidth={2}
                        dot={{ fill: VENUE_COLORS[i % VENUE_COLORS.length], r: 4, strokeWidth: 0 }}
                        activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                    ))
                  : chaosOrdered.map(u => (
                      <Line key={u} type="monotone" dataKey={u}
                        stroke={chaosColor(u)}
                        strokeWidth={u === myUsername ? 2.5 : 1.5}
                        strokeOpacity={u === myUsername ? 1 : 0.5}
                        dot={{ fill: chaosColor(u), r: u === myUsername ? 4 : 3, strokeWidth: 0, fillOpacity: u === myUsername ? 1 : 0.6 }}
                        activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                    ))
                }
              </LineChart>
            )}
          </ResponsiveContainer>

          <p className="text-xs text-muted-foreground text-center mt-2">
            {chartMode === 'date'
              ? 'X-axis is calendar date — gaps in play appear as spacing.'
              : isVenueComparison
                ? 'Sessions numbered chronologically per venue.'
                : 'Sessions numbered chronologically per player — calendar gaps are not shown.'}
          </p>
        </div>
      )}

      {/* Venue Difficulty */}
      {venueDifficulty.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-card p-5 mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wider text-white mb-1">Venue Difficulty</h2>
          <p className="text-xs text-muted-foreground mb-4">
            Relative score averages across venues — lower scores indicate harder local setup (steeper slope, tighter tilt, etc.).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {venueDifficulty.map(v => {
              const { text, color } = difficultyLabel(v.diffPct);
              const lowConf = v.count < 3;
              return (
                <div key={v.venueId} className="rounded-lg border border-white/10 bg-white/3 p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-sm font-semibold text-white truncate">{v.venueName}</p>
                    <span className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0" style={{ color, background: `${color}20` }}>
                      {text}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Avg {formatScore(v.avgScore)} · {v.count} score{v.count !== 1 ? 's' : ''}
                    {v.diffPct !== 0 && (
                      <> · {v.diffPct > 0 ? '+' : ''}{v.diffPct.toFixed(1)}% vs avg</>
                    )}
                    {lowConf && <span className="ml-1 opacity-60">(low confidence)</span>}
                  </p>
                </div>
              );
            })}
          </div>
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
                      {s.id === best?.id && <span className="ml-2 text-xs font-bold bg-primary text-white px-1.5 py-0.5 rounded">BEST</span>}
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
                  <span className="text-xs font-bold uppercase tracking-wider border border-white/20 rounded px-2 py-0.5 text-muted-foreground">{s.type}</span>
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
