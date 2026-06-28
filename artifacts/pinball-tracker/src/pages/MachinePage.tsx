import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import {
  Trophy, ArrowLeft, MapPin, PlusCircle,
  ChevronUp, ChevronDown, TrendingUp, Users, ChevronDown as ChevronDownSmall,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import {
  ComposedChart, LineChart, Line, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';

// ─── constants ────────────────────────────────────────────────────────────────

const VENUE_COLORS  = ['#22d3ee', '#f97316', '#34d399', '#f472b6', '#60a5fa', '#e879f9'];
const USER_COLORS   = ['#a855f7', '#22d3ee', '#f97316', '#34d399', '#f472b6', '#60a5fa'];
const VISIT_GAP_MS  = 6 * 3600 * 1000; // 6-hour gap = new visit
const ROLLING_WINDOW = 5;

type ChartMode = 'play' | 'visit' | 'scatter';
type VisitAgg  = 'best' | 'average';
type ViewMode  = 'aggregate' | 'chaos';
type SortKey   = 'playedAt' | 'username' | 'type' | 'score';
type SortDir   = 'asc' | 'desc';

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

function clusterVisits(plays: any[]): any[][] {
  if (!plays.length) return [];
  const sorted = [...plays].sort(
    (a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime(),
  );
  const visits: any[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].playedAt).getTime() - new Date(sorted[i - 1].playedAt).getTime();
    if (gap > VISIT_GAP_MS) visits.push([]);
    visits[visits.length - 1].push(sorted[i]);
  }
  return visits;
}

function rollingAvg(plays: { x: number; y: number }[], window = ROLLING_WINDOW) {
  return plays.map((p, i) => {
    const slice = plays.slice(Math.max(0, i - window + 1), i + 1);
    return { x: p.x, trend: slice.reduce((s, d) => s + d.y, 0) / slice.length };
  });
}

// ─── line-chart data builders ─────────────────────────────────────────────────

/** Shared helper: build ordinal data for one user set */
function userOrdinalData(userPlays: any[], agg: VisitAgg | 'play') {
  if (agg === 'play') {
    return userPlays
      .sort((a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime())
      .map((s, i) => ({ idx: i + 1, score: Number(s.score), playedAt: s.playedAt, venueName: s.venueName }));
  }
  return clusterVisits(userPlays).map((visit, i) => {
    const scores = visit.map((s: any) => Number(s.score));
    const score  = agg === 'best' ? Math.max(...scores) : scores.reduce((a, b) => a + b, 0) / scores.length;
    return {
      idx:      i + 1,
      score:    Math.round(score),
      playedAt: visit[visit.length - 1].playedAt,
      venueName: visit[0].venueName,
      count:    visit.length,
    };
  });
}

function buildLineData(
  scores: any[],
  myUsername: string | null,
  selectedVenueIds: number[],
  viewMode: ViewMode,
  agg: VisitAgg | 'play',
) {
  const filtered = selectedVenueIds.length
    ? scores.filter(s => selectedVenueIds.includes(s.venueId))
    : scores;

  // chaos mode — one series per user
  if (viewMode === 'chaos') {
    const users = [...new Set<string>(filtered.map(s => s.username as string))];
    const ordered = myUsername ? [myUsername, ...users.filter(u => u !== myUsername)] : users;
    const seriesMap: Record<string, { idx: number; score: number; date?: string; venue?: string }[]> = {};
    for (const u of ordered) {
      seriesMap[u] = userOrdinalData(filtered.filter(s => s.username === u), agg).map(d => ({
        idx:   d.idx,
        score: d.score,
        date:  d.playedAt,
        venue: d.venueName,
      }));
    }
    const maxLen = Math.max(...ordered.map(u => seriesMap[u].length), 0);
    const data = Array.from({ length: maxLen }, (_, i) => {
      const entry: any = { x: i + 1 };
      for (const u of ordered) {
        const p = seriesMap[u][i];
        if (p) { entry[u] = p.score; entry[`${u}_date`] = p.date; entry[`${u}_venue`] = p.venue; }
      }
      return entry;
    });
    return { data, lineKeys: ordered, type: 'chaos' as const };
  }

  // venue comparison mode
  if (selectedVenueIds.length > 0) {
    const venues = [...new Map<number, string>(
      filtered.filter(s => s.venueName).map(s => [s.venueId as number, s.venueName as string]),
    ).entries()].map(([id, name]) => ({ id, name }));
    const seriesMap: Record<string, { idx: number; score: number; date?: string }[]> = {};
    for (const v of venues) {
      const vPlays = filtered.filter(s => s.venueId === v.id && s.username === myUsername);
      seriesMap[v.name] = userOrdinalData(vPlays, agg).map(d => ({
        idx: d.idx, score: d.score, date: d.playedAt,
      }));
    }
    const maxLen = Math.max(...venues.map(v => seriesMap[v.name].length), 0);
    const data = Array.from({ length: maxLen }, (_, i) => {
      const entry: any = { x: i + 1 };
      for (const v of venues) {
        const p = seriesMap[v.name][i];
        if (p) { entry[v.name] = p.score; entry[`${v.name}_date`] = p.date; }
      }
      return entry;
    });
    return { data, lineKeys: venues.map(v => v.name), type: 'venue' as const };
  }

  // aggregate mode — you vs field
  const mySeries   = userOrdinalData(filtered.filter(s => s.username === myUsername), agg);
  const otherUsers = [...new Set(filtered.filter(s => s.username !== myUsername).map(s => s.username as string))];
  const otherMap: Record<string, ReturnType<typeof userOrdinalData>> = {};
  for (const u of otherUsers) otherMap[u] = userOrdinalData(filtered.filter(s => s.username === u), agg);
  const maxLen = Math.max(mySeries.length, ...otherUsers.map(u => otherMap[u].length), 0);

  const data = Array.from({ length: maxLen }, (_, i) => {
    const mine = mySeries[i];
    const fieldScores = otherUsers.map(u => otherMap[u][i]?.score).filter(v => v != null) as number[];
    return {
      x:         i + 1,
      my:        mine?.score ?? null,
      field:     statsMedian(fieldScores),
      my_date:   mine?.playedAt,
      my_venue:  mine?.venueName,
      my_count:  (mine as any)?.count,
    };
  });
  return { data, lineKeys: [] as string[], type: 'aggregate' as const };
}

// ─── scatter data builder ─────────────────────────────────────────────────────

function buildScatterData(
  scores: any[],
  myUsername: string | null,
  selectedVenueIds: number[],
  viewMode: ViewMode,
) {
  const filtered = selectedVenueIds.length
    ? scores.filter(s => selectedVenueIds.includes(s.venueId))
    : scores;
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime(),
  );

  if (viewMode === 'chaos') {
    const users = [...new Set<string>(sorted.map(s => s.username as string))];
    const ordered = myUsername ? [myUsername, ...users.filter(u => u !== myUsername)] : users;
    const perUser = ordered.map(u => ({
      username: u,
      dots: sorted.filter(s => s.username === u).map(s => ({
        x: new Date(s.playedAt).getTime(), y: Number(s.score),
        venue: s.venueName, playedAt: s.playedAt,
      })),
    }));
    return { type: 'chaos' as const, perUser, trendLine: [] };
  }

  if (selectedVenueIds.length > 0) {
    const venues = [...new Map<number, string>(
      filtered.filter(s => s.venueName).map(s => [s.venueId as number, s.venueName as string]),
    ).entries()].map(([id, name]) => ({ id, name }));
    const perVenue = venues.map(v => ({
      venueName: v.name,
      dots: sorted.filter(s => s.venueId === v.id && s.username === myUsername).map(s => ({
        x: new Date(s.playedAt).getTime(), y: Number(s.score), playedAt: s.playedAt,
      })),
    }));
    return { type: 'venue' as const, perVenue, trendLine: [] };
  }

  // aggregate
  const myDots = sorted.filter(s => s.username === myUsername).map(s => ({
    x: new Date(s.playedAt).getTime(), y: Number(s.score),
    venue: s.venueName, playedAt: s.playedAt,
  }));
  const fieldDots = sorted.filter(s => s.username !== myUsername).map(s => ({
    x: new Date(s.playedAt).getTime(), y: Number(s.score),
    username: s.username, playedAt: s.playedAt,
  }));
  const trendLine = rollingAvg(myDots);
  return { type: 'aggregate' as const, myDots, fieldDots, trendLine };
}

// ─── tooltips ─────────────────────────────────────────────────────────────────

function LineTooltip({ active, payload, label, chartMode, visitAgg, myUsername, lineType }: any) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter((p: any) => p.value != null);
  if (!visible.length) return null;
  return (
    <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-3 text-xs shadow-xl min-w-[180px]">
      <p className="font-bold text-white mb-2">
        {chartMode === 'visit' ? `Visit ${label}` : `Play #${label}`}
      </p>
      {visible.map((p: any) => {
        const key     = p.dataKey as string;
        const display = lineType === 'aggregate'
          ? (key === 'my' ? `You (${myUsername ?? 'you'})` : 'Field median')
          : key;
        const dateVal = p.payload[`${key}_date`];
        const venue   = p.payload[`${key}_venue`];
        const count   = p.payload[`${key}_count`];
        return (
          <div key={key} className="mb-1.5 last:mb-0">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
              <span style={{ color: p.color }} className="font-semibold truncate max-w-[140px]">{display}</span>
            </div>
            <div className="pl-3.5 font-bold text-white">{Number(p.value).toLocaleString()}</div>
            {dateVal && (
              <div className="pl-3.5 text-muted-foreground">
                {format(new Date(dateVal), 'MMM d, yyyy')}
                {venue ? ` · ${venue}` : ''}
                {count && count > 1 ? ` · ${count} plays` : ''}
                {chartMode === 'visit' && visitAgg === 'average' ? ' (avg)' : ''}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScatterTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  // trend line hover
  if ('trend' in d) {
    return (
      <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-2.5 text-xs shadow-xl">
        <p className="text-muted-foreground">Rolling avg ({ROLLING_WINDOW}-play)</p>
        <p className="font-bold text-white">{Number(d.trend).toLocaleString()}</p>
        <p className="text-muted-foreground">{format(new Date(d.x), 'MMM d, yyyy')}</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-2.5 text-xs shadow-xl">
      <p className="font-bold text-white">{Number(d.y).toLocaleString()}</p>
      {d.playedAt && <p className="text-muted-foreground">{format(new Date(d.playedAt), 'MMM d, yyyy · h:mm a')}</p>}
      {d.venue    && <p className="text-muted-foreground">{d.venue}</p>}
      {d.username && <p className="text-muted-foreground">{d.username}</p>}
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
        <MapPin className="w-3 h-3" />{label}<ChevronDownSmall className="w-3 h-3 ml-0.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="z-50 min-w-[180px] rounded-xl border border-white/15 bg-zinc-900 p-1 shadow-xl" sideOffset={6} align="end">
          <DropdownMenu.CheckboxItem
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer outline-none hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
            checked={selectedIds.length === 0} onCheckedChange={onClear}
          >
            <Checkbox checked={selectedIds.length === 0} /> All Venues
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Separator className="my-1 border-t border-white/10" />
          {venues.map(v => (
            <DropdownMenu.CheckboxItem
              key={v.venueId}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer outline-none hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
              checked={selectedIds.includes(v.venueId)} onCheckedChange={() => onToggle(v.venueId)}
            >
              <Checkbox checked={selectedIds.includes(v.venueId)} />
              <span className="truncate">{v.venueName}</span>
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${checked ? 'bg-primary border-primary' : 'border-white/30'}`}>
      {checked && <ChevronUp className="w-2.5 h-2.5 text-white" />}
    </div>
  );
}

// ─── venue difficulty ─────────────────────────────────────────────────────────

function difficultyLabel(pct: number): { text: string; color: string } {
  if (pct <= -15) return { text: 'Much Easier', color: '#34d399' };
  if (pct <=  -5) return { text: 'Easier',      color: '#86efac' };
  if (pct <    5) return { text: 'Average',      color: '#71717a' };
  if (pct <   15) return { text: 'Harder',       color: '#fb923c' };
  return               { text: 'Much Harder',  color: '#f87171' };
}

// ─── shared chart axes ────────────────────────────────────────────────────────

const AXIS_STYLE = { fill: '#71717a', fontSize: 11 };

// ─── main page ────────────────────────────────────────────────────────────────

export default function MachinePage() {
  const { name } = useParams<{ name: string }>();
  const decodedName = decodeURIComponent(name);

  const [sortKey,  setSortKey]  = useState<SortKey>('score');
  const [sortDir,  setSortDir]  = useState<SortDir>('desc');
  const [chartMode, setChartMode] = useState<ChartMode>('play');
  const [visitAgg,  setVisitAgg]  = useState<VisitAgg>('best');
  const [viewMode,  setViewMode]  = useState<ViewMode>('aggregate');
  const [selectedVenueIds, setSelectedVenueIds] = useState<number[]>([]);

  const authApi = useApi();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: authApi.users.me, retry: false });
  const myUsername = (me as any)?.username as string | null ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ['machine', decodedName],
    queryFn: () => api.machines.get(decodedName),
  });

  // ── derived ─────────────────────────────────────────────────────────────────

  const scores = useMemo(() => (data?.scores ?? []) as any[], [data]);

  const uniqueVenues = useMemo<VenueOption[]>(() => {
    return [...new Map<number, VenueOption>(
      scores.filter(s => s.venueId != null && s.venueName)
            .map(s => [s.venueId, { venueId: s.venueId, venueName: s.venueName }]),
    ).values()];
  }, [scores]);

  const venueDifficulty = useMemo(() => {
    if (uniqueVenues.length < 2) return [];
    const globalAvg = scores.reduce((s: number, r: any) => s + Number(r.score), 0) / scores.length;
    return uniqueVenues.map(v => {
      const vs = scores.filter(s => s.venueId === v.venueId).map(s => Number(s.score));
      const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
      return { ...v, avgScore: Math.round(avg), count: vs.length, diffPct: ((avg - globalAvg) / globalAvg) * 100 };
    }).sort((a, b) => a.diffPct - b.diffPct);
  }, [scores, uniqueVenues]);

  const lineResult = useMemo(() => {
    if (chartMode === 'scatter' || scores.length < 2) return null;
    const agg = chartMode === 'visit' ? visitAgg : 'play';
    return buildLineData(scores, myUsername, selectedVenueIds, viewMode, agg);
  }, [scores, chartMode, visitAgg, myUsername, selectedVenueIds, viewMode]);

  const scatterResult = useMemo(() => {
    if (chartMode !== 'scatter' || scores.length < 2) return null;
    return buildScatterData(scores, myUsername, selectedVenueIds, viewMode);
  }, [scores, chartMode, myUsername, selectedVenueIds, viewMode]);

  // ── guards ──────────────────────────────────────────────────────────────────

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">Machine not found.</p>;

  const { machine } = data;
  const best = scores.reduce((a: any, b: any) => b.score > a.score ? b : a, scores[0]);
  const showChart = scores.length >= 2;

  // ── sort table ──────────────────────────────────────────────────────────────

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'score' ? 'desc' : 'asc'); }
  }
  const sorted = [...scores].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'playedAt') cmp = new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime();
    else if (sortKey === 'username') cmp = (a.username ?? '').localeCompare(b.username ?? '');
    else if (sortKey === 'type')     cmp = (a.type ?? '').localeCompare(b.type ?? '');
    else cmp = a.score - b.score;
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

  // ── chaos color helpers ─────────────────────────────────────────────────────

  function chaosLineColor(u: string) { return u === myUsername ? '#facc15' : '#a855f7'; }

  // ── chart description ───────────────────────────────────────────────────────

  function chartDescription() {
    const venueNote = selectedVenueIds.length > 0 ? ' (filtered by selected venue' + (selectedVenueIds.length > 1 ? 's' : '') + ')' : '';
    if (chartMode === 'scatter') {
      return viewMode === 'chaos'
        ? `Every individual play as a dot on its actual date. Multiple dots close together are plays from the same visit${venueNote}.`
        : `Every individual play as a dot on its actual date. Multiple dots on the same day are plays from the same visit. The dashed line is a ${ROLLING_WINDOW}-play rolling average${venueNote}.`;
    }
    if (chartMode === 'visit') {
      const aggNote = visitAgg === 'best' ? 'best score' : 'average score';
      return viewMode === 'chaos'
        ? `${aggNote.charAt(0).toUpperCase() + aggNote.slice(1)} per venue visit (plays within 6 hours of each other = one visit)${venueNote}.`
        : `Your ${aggNote} per venue visit vs. the field median. Visits = groups of plays within 6 hours of each other${venueNote}.`;
    }
    return viewMode === 'chaos'
      ? `Every play numbered chronologically per player. Plays from the same visit are consecutive${venueNote}.`
      : `Your score on each play vs. the field median. Plays from the same visit appear as consecutive points${venueNote}.`;
  }

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

          {/* Controls row */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="flex items-center gap-2 mr-auto">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-white">Score Trend</h2>
            </div>

            {/* Venue filter */}
            {uniqueVenues.length >= 2 && viewMode === 'aggregate' && (
              <VenueDropdown
                venues={uniqueVenues}
                selectedIds={selectedVenueIds}
                onToggle={id => setSelectedVenueIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
                onClear={() => setSelectedVenueIds([])}
              />
            )}

            {/* Chart mode: By Play | By Visit | Scatter */}
            <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider">
              {(['play', 'visit', 'scatter'] as ChartMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => setChartMode(m)}
                  className={`px-3 py-1.5 rounded-md transition-colors ${chartMode === m ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'}`}
                >
                  {m === 'play' ? 'By Play' : m === 'visit' ? 'By Visit' : 'Scatter'}
                </button>
              ))}
            </div>

            {/* All Players toggle */}
            <button
              onClick={() => { setViewMode(v => v === 'chaos' ? 'aggregate' : 'chaos'); setSelectedVenueIds([]); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors ${viewMode === 'chaos' ? 'border-fuchsia-500 text-fuchsia-400 bg-fuchsia-500/10' : 'border-white/20 text-muted-foreground hover:text-white hover:border-white/40'}`}
            >
              <Users className="w-3 h-3" /> All Players
            </button>
          </div>

          {/* Visit sub-toggle */}
          {chartMode === 'visit' && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-muted-foreground">Show per visit:</span>
              <div className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider">
                <button
                  onClick={() => setVisitAgg('best')}
                  className={`px-3 py-1 rounded-md transition-colors ${visitAgg === 'best' ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
                >
                  Best Score
                </button>
                <button
                  onClick={() => setVisitAgg('average')}
                  className={`px-3 py-1 rounded-md transition-colors ${visitAgg === 'average' ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
                >
                  Average Score
                </button>
              </div>
            </div>
          )}

          {/* Aggregate mode legend */}
          {viewMode === 'aggregate' && chartMode !== 'scatter' && lineResult?.type === 'aggregate' && (
            <div className="flex items-center gap-4 mb-3 text-xs">
              {myUsername && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-yellow-400" /><span className="text-muted-foreground">You ({myUsername})</span></div>}
              <div className="flex items-center gap-1.5">
                <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="#a855f7" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                <span className="text-muted-foreground">Field median</span>
              </div>
            </div>
          )}
          {viewMode === 'aggregate' && chartMode === 'scatter' && scatterResult?.type === 'aggregate' && myUsername && (
            <div className="flex items-center gap-4 mb-3 text-xs">
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-yellow-400" /><span className="text-muted-foreground">Your plays</span></div>
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-purple-500 opacity-40" /><span className="text-muted-foreground">Others</span></div>
              <div className="flex items-center gap-1.5">
                <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="#facc15" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                <span className="text-muted-foreground">{ROLLING_WINDOW}-play rolling avg</span>
              </div>
            </div>
          )}

          {/* Venue comparison legend */}
          {lineResult?.type === 'venue' && lineResult.lineKeys.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
              {lineResult.lineKeys.map((vn, i) => (
                <div key={vn} className="flex items-center gap-1.5">
                  <div className="w-3 h-0.5 rounded" style={{ background: VENUE_COLORS[i % VENUE_COLORS.length] }} />
                  <span className="text-muted-foreground truncate max-w-[120px]">{vn}</span>
                </div>
              ))}
            </div>
          )}

          {/* Chart */}
          <ResponsiveContainer width="100%" height={220}>
            {chartMode !== 'scatter' && lineResult ? (
              <LineChart data={lineResult.data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="x" tick={AXIS_STYLE} tickLine={false} axisLine={false}
                  tickFormatter={v => chartMode === 'visit' ? `V${v}` : `#${v}`} />
                <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={formatScore} width={48} />
                <Tooltip
                  content={<LineTooltip chartMode={chartMode} visitAgg={visitAgg} myUsername={myUsername} lineType={lineResult.type} />}
                  cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
                />
                {lineResult.type === 'aggregate' && (
                  <>
                    <Line type="monotone" dataKey="field" stroke="#a855f7" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
                    {myUsername && (
                      <Line type="monotone" dataKey="my" stroke="#facc15" strokeWidth={2.5}
                        dot={{ fill: '#facc15', r: 4, strokeWidth: 0 }} activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                    )}
                  </>
                )}
                {lineResult.type === 'venue' && lineResult.lineKeys.map((vn, i) => (
                  <Line key={vn} type="monotone" dataKey={vn}
                    stroke={VENUE_COLORS[i % VENUE_COLORS.length]} strokeWidth={2}
                    dot={{ fill: VENUE_COLORS[i % VENUE_COLORS.length], r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                ))}
                {lineResult.type === 'chaos' && lineResult.lineKeys.map(u => (
                  <Line key={u} type="monotone" dataKey={u}
                    stroke={chaosLineColor(u)}
                    strokeWidth={u === myUsername ? 2.5 : 1.5}
                    strokeOpacity={u === myUsername ? 1 : 0.5}
                    dot={{ fill: chaosLineColor(u), r: u === myUsername ? 4 : 3, strokeWidth: 0, fillOpacity: u === myUsername ? 1 : 0.6 }}
                    activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                ))}
              </LineChart>
            ) : scatterResult ? (
              <ComposedChart margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                data={scatterResult.type === 'aggregate' ? scatterResult.trendLine : []}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="x" type="number" scale="time" domain={['auto', 'auto']}
                  tick={AXIS_STYLE} tickLine={false} axisLine={false}
                  tickFormatter={v => format(new Date(v), 'MMM d')} />
                <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={formatScore} width={48} />
                <Tooltip content={<ScatterTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />

                {scatterResult.type === 'aggregate' && (
                  <>
                    {scatterResult.fieldDots.length > 0 && (
                      <Scatter data={scatterResult.fieldDots} fill="#a855f7" fillOpacity={0.25} />
                    )}
                    {scatterResult.myDots.length > 0 && (
                      <Scatter data={scatterResult.myDots} fill="#facc15" />
                    )}
                    {scatterResult.trendLine.length >= 2 && (
                      <Line dataKey="trend" stroke="#facc15" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
                    )}
                  </>
                )}
                {scatterResult.type === 'chaos' && scatterResult.perUser.map((u, i) => (
                  <Scatter key={u.username} data={u.dots}
                    fill={u.username === myUsername ? '#facc15' : USER_COLORS[i % USER_COLORS.length]}
                    fillOpacity={u.username === myUsername ? 1 : 0.5} />
                ))}
                {scatterResult.type === 'venue' && scatterResult.perVenue.map((v, i) => (
                  <Scatter key={v.venueName} data={v.dots} fill={VENUE_COLORS[i % VENUE_COLORS.length]} />
                ))}
              </ComposedChart>
            ) : (
              <LineChart data={[]} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <XAxis /><YAxis />
              </LineChart>
            )}
          </ResponsiveContainer>

          {/* Description */}
          <p className="text-xs text-muted-foreground text-center mt-2 leading-relaxed">
            {chartDescription()}
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
              return (
                <div key={v.venueId} className="rounded-lg border border-white/10 bg-white/3 p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-sm font-semibold text-white truncate">{v.venueName}</p>
                    <span className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0" style={{ color, background: `${color}20` }}>{text}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Avg {formatScore(v.avgScore)} · {v.count} score{v.count !== 1 ? 's' : ''}
                    {v.diffPct !== 0 && <> · {v.diffPct > 0 ? '+' : ''}{v.diffPct.toFixed(1)}% vs avg</>}
                    {v.count < 3 && <span className="ml-1 opacity-60">(low confidence)</span>}
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
