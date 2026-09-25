import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import {
  Trophy, ArrowLeft, MapPin, PlusCircle, Home,
  ChevronUp, ChevronDown, TrendingUp, Users, ChevronDown as ChevronDownSmall,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { formatScoreTime } from '../lib/scoreTime';
import {
  ComposedChart, LineChart, Line, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useApi } from '../lib/useApi';
import ComparisonScopePicker from '../components/ComparisonScopePicker';
import PodMemberIcons from '../components/PodMemberIcons';
import { useComparisonScope, scopeQuery, scopeKey } from '../lib/comparisonScope';
import { usePodMembership } from '../lib/myPods';
import { podColorTokens, podColorVars } from '../lib/podColor';

// ─── constants ────────────────────────────────────────────────────────────────

const VENUE_COLORS  = ['#22d3ee', '#f97316', '#34d399', '#f472b6', '#60a5fa', '#e879f9'];
const VISIT_GAP_MS  = 6 * 3600 * 1000; // 6-hour gap = new visit
const ROLLING_WINDOW = 5;

type ChartMode = 'play' | 'visit' | 'scatter';
type VisitAgg  = 'best' | 'average';
type ViewMode  = 'aggregate' | 'chaos';
type SortKey   = 'playedAt' | 'username' | 'type' | 'score';
type SortDir   = 'asc' | 'desc';
/** Server-computed per score (GET /api/machines/:name): the viewer, the selected pod's members, everyone else. */
type Group     = 'self' | 'pod' | 'other';

const GROUP_RANK: Record<Group, number> = { self: 0, pod: 1, other: 2 };

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
  return s.length % 2 === 0 ? Math.round((s[m - 1] + s[m]) / 2) : s[m];
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

function groupOf(s: any, myUsername: string | null): Group {
  if (s.group === 'self' || s.group === 'pod' || s.group === 'other') return s.group;
  return myUsername && s.username === myUsername ? 'self' : 'other';
}

function rollingAvg(plays: { x: number; y: number }[], window = ROLLING_WINDOW) {
  return plays.map((p, i) => {
    const slice = plays.slice(Math.max(0, i - window + 1), i + 1);
    return { x: p.x, trend: Math.round(slice.reduce((s, d) => s + d.y, 0) / slice.length) };
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

/** One ordinal series per username. */
function seriesByUser(plays: any[], agg: VisitAgg | 'play') {
  const out: Record<string, ReturnType<typeof userOrdinalData>> = {};
  for (const u of new Set<string>(plays.map(s => s.username as string))) {
    out[u] = userOrdinalData(plays.filter(s => s.username === u), agg);
  }
  return out;
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

  const userGroup: Record<string, Group> = {};
  for (const s of filtered) userGroup[s.username] = groupOf(s, myUsername);

  // chaos mode — one series per user; you first, then pod members, then everyone else
  if (viewMode === 'chaos') {
    const users = [...new Set<string>(filtered.map(s => s.username as string))];
    const ordered = [...users].sort((a, b) => GROUP_RANK[userGroup[a]] - GROUP_RANK[userGroup[b]]);
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
    return { data, lineKeys: ordered, userGroup, hasPod: false, hasField: false, type: 'chaos' as const };
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
    return { data, lineKeys: venues.map(v => v.name), userGroup, hasPod: false, hasField: false, type: 'venue' as const };
  }

  // aggregate mode — you vs the pod's median (pod scope) vs the field median (everyone else)
  const mySeries = userOrdinalData(filtered.filter(s => userGroup[s.username] === 'self'), agg);
  const podMap   = seriesByUser(filtered.filter(s => userGroup[s.username] === 'pod'), agg);
  const otherMap = seriesByUser(filtered.filter(s => userGroup[s.username] === 'other'), agg);
  const podUsers = Object.keys(podMap), otherUsers = Object.keys(otherMap);
  const maxLen = Math.max(
    mySeries.length, ...podUsers.map(u => podMap[u].length), ...otherUsers.map(u => otherMap[u].length), 0,
  );

  const medianAt = (map: typeof otherMap, users: string[], i: number) =>
    statsMedian(users.map(u => map[u][i]?.score).filter(v => v != null) as number[]);
  const data = Array.from({ length: maxLen }, (_, i) => {
    const mine = mySeries[i];
    return {
      x:         i + 1,
      my:        mine?.score ?? null,
      pod:       medianAt(podMap, podUsers, i),
      field:     medianAt(otherMap, otherUsers, i),
      my_date:   mine?.playedAt,
      my_venue:  mine?.venueName,
      my_count:  (mine as any)?.count,
    };
  });
  return {
    data, lineKeys: [] as string[], userGroup,
    hasPod: podUsers.length > 0, hasField: otherUsers.length > 0, type: 'aggregate' as const,
  };
}

// ─── scatter data builder ─────────────────────────────────────────────────────

function buildScatterData(
  scores: any[],
  myUsername: string | null,
  selectedVenueIds: number[],
) {
  const filtered = selectedVenueIds.length
    ? scores.filter(s => selectedVenueIds.includes(s.venueId))
    : scores;
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime(),
  );

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
    return { type: 'venue' as const, perVenue };
  }

  // aggregate — mine (always) + the pod's (pod scope) + field. Field dots render in All scope only
  // when "All Players" is on; in pod scope whenever the server sent them ("All others" is on).
  const dotsFor = (grp: Group) => sorted.filter(s => groupOf(s, myUsername) === grp).map(s => ({
    x: new Date(s.playedAt).getTime(), y: Number(s.score),
    venue: s.venueName, venueTimezone: s.venueTimezone, playedAt: s.playedAt,
    ...(grp === 'self' ? {} : { username: s.username as string }),
  }));
  const myDots = dotsFor('self'), podDots = dotsFor('pod'), fieldDots = dotsFor('other');
  const trendLine = rollingAvg(myDots).map(p => ({ ...p, owner: 'me' as const }));
  const podTrendLine = rollingAvg(podDots).map(p => ({ ...p, owner: 'pod' as const }));
  const fieldTrendLine = rollingAvg(fieldDots).map(p => ({ ...p, owner: 'field' as const }));
  return { type: 'aggregate' as const, myDots, podDots, fieldDots, trendLine, podTrendLine, fieldTrendLine };
}

// ─── tooltips ─────────────────────────────────────────────────────────────────

function LineTooltip({ active, payload, label, chartMode, visitAgg, myUsername, lineType, podName, othersLabel }: any) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter((p: any) => p.value != null);
  if (!visible.length) return null;
  // Chaos lines are drawn back to front (you last, on top); list them front to back (you first).
  if (lineType === 'chaos') visible.reverse();
  return (
    <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-3 text-xs shadow-xl min-w-[180px]">
      <p className="font-bold text-white mb-2">
        {chartMode === 'visit' ? `Visit ${label}` : `Play #${label}`}
      </p>
      {visible.map((p: any) => {
        const key     = p.dataKey as string;
        const display = lineType === 'aggregate'
          ? (key === 'my' ? `You (${myUsername ?? 'you'})` : key === 'pod' ? `${podName} median` : `${othersLabel} median`)
          : lineType === 'chaos' && key === myUsername ? `You (${key})` : key;
        const dateVal = p.payload[`${key}_date`];
        const venue   = p.payload[`${key}_venue`];
        const count   = p.payload[`${key}_count`];
        return (
          <div key={key} className="mb-1.5 last:mb-0">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
              <span style={{ color: p.color }} className="font-semibold truncate max-w-[140px]">{display}</span>
            </div>
            <div className="pl-3.5 font-bold text-primary">{Number(p.value).toLocaleString()}</div>
            {dateVal && (
              <div className="pl-3.5 text-muted-foreground">
                {format(new Date(dateVal), 'MMM d, yyyy')}
                {venue ? <> · <span className="text-venue">{venue}</span></> : ''}
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

function ScatterTooltip({ active, payload, podName, podText, othersLabel }: any) {
  if (!active || !payload?.length) return null;
  // recharts always puts the trend-line entry first when a dot and a trend
  // point share the same x — prefer an actual dot's payload when one is present.
  const dotEntry = payload.find((p: any) => p.payload && !('trend' in p.payload));
  const d = (dotEntry ?? payload[0])?.payload;
  if (!d) return null;
  // trend line hover
  if ('trend' in d) {
    const isField = d.owner === 'field';
    const isPod = d.owner === 'pod';
    const who = isPod ? podName : isField ? othersLabel : 'Your';
    return (
      <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-2.5 text-xs shadow-xl">
        <p className="text-muted-foreground">{who} rolling avg ({ROLLING_WINDOW}-play)</p>
        <p className={`font-bold ${isField ? 'text-field' : isPod ? '' : 'text-primary'}`} style={isPod ? { color: podText } : undefined}>
          {Number(d.trend).toLocaleString()}
        </p>
        <p className="text-muted-foreground">{format(new Date(d.x), 'MMM d, yyyy')}</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-2.5 text-xs shadow-xl">
      <p className="font-bold text-primary">{Number(d.y).toLocaleString()}</p>
      {d.playedAt && <p className="text-muted-foreground">{formatScoreTime(d.playedAt, d.venueTimezone, 'MMM d, yyyy · h:mm a')}</p>}
      {d.venue    && <p className="text-venue">{d.venue}</p>}
      {d.username && <p className="text-username">@{d.username}</p>}
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

  // Comparison scope (All / Mine / one pod) — URL-backed, falls back to the ScopeContext toggle.
  // Everything below the picker (top score, chart, venue difficulty, table) reads the scoped scores.
  const cs = useComparisonScope();
  const { scope, pod } = cs;
  const podMembership = usePodMembership();

  const { data, isLoading, error } = useQuery({
    queryKey: ['machine', decodedName, scopeKey(scope)],
    // authApi, not the static client: scores at a private venue whose owner hides them are only
    // returned to the owner, admins and their authors, which the server can't tell without a token.
    queryFn: () => authApi.machines.get(decodedName, scopeQuery(scope)),
    enabled: cs.ready,
    // Keep the chart on screen while switching scope on the same machine — not across machines.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === decodedName ? prev : undefined),
  });

  // ── derived ─────────────────────────────────────────────────────────────────

  const scores = useMemo(() => (data?.scores ?? []) as any[], [data]);

  const podTokens = useMemo(() => (pod ? podColorTokens(pod.color) : null), [pod]);
  const podName = pod?.name ?? 'Pod';
  const othersLabel = scope.kind === 'pod' ? 'Others' : 'Field';
  // Mine has nobody to split out, so the individual-lines view collapses to the aggregate one.
  const effectiveViewMode: ViewMode = scope.kind === 'mine' ? 'aggregate' : viewMode;
  const scopeLabel =
    scope.kind === 'mine' ? 'Just you'
    : scope.kind === 'pod' ? `You + ${podName}${scope.others ? ' + everyone else' : ''}`
    : null;

  const uniqueVenues = useMemo<VenueOption[]>(() => {
    return [...new Map<number, VenueOption>(
      scores.filter(s => s.venueId != null && s.venueName)
            .map(s => [s.venueId, { venueId: s.venueId, venueName: s.venueName }]),
    ).values()];
  }, [scores]);

  const machineAvgScore = useMemo(() => {
    if (!scores.length) return 0;
    return Math.round(scores.reduce((s: number, r: any) => s + Number(r.score), 0) / scores.length);
  }, [scores]);

  const venueDifficulty = useMemo(() => {
    if (uniqueVenues.length < 2) return [];
    // Only include players who have played this machine at 2+ venues — single-venue players
    // always produce a ratio of 1.0 (their average equals their score there), adding pure noise.
    const playerVenueIds: Record<string, Set<number>> = {};
    for (const s of scores as any[]) {
      if (s.venueId == null) continue;
      if (!playerVenueIds[s.username]) playerVenueIds[s.username] = new Set();
      playerVenueIds[s.username].add(s.venueId);
    }
    const playerAvgs: Record<string, number> = {};
    for (const u of [...new Set<string>((scores as any[]).map((s: any) => s.username as string))]) {
      if ((playerVenueIds[u]?.size ?? 0) < 2) continue; // skip single-venue players
      const ps = (scores as any[]).filter((s: any) => s.username === u).map((s: any) => Number(s.score));
      playerAvgs[u] = ps.reduce((a: number, b: number) => a + b, 0) / ps.length;
    }
    return uniqueVenues.flatMap(v => {
      const vs = (scores as any[]).filter((s: any) => s.venueId === v.venueId);
      // Normalize each score by that player's own cross-venue average
      const ratios = vs
        .filter((s: any) => (playerAvgs[s.username] ?? 0) > 0)
        .map((s: any) => Number(s.score) / playerAvgs[s.username]);
      if (!ratios.length) return [];
      const avgRatio = ratios.reduce((a: number, b: number) => a + b, 0) / ratios.length;
      // positive diffPct = scores below player baseline = harder venue
      const diffPct = (1 - avgRatio) * 100;
      const avgScore = Math.round(vs.reduce((a: number, s: any) => a + Number(s.score), 0) / vs.length);
      const globalAvg = (scores as any[]).reduce((a: number, s: any) => a + Number(s.score), 0) / scores.length;
      const rawDiffPct = globalAvg ? ((avgScore - globalAvg) / globalAvg) * 100 : 0;
      return [{ ...v, avgScore, count: vs.length, diffPct, rawDiffPct, crossVenueCount: ratios.length }];
    }).sort((a, b) => b.diffPct - a.diffPct);
  }, [scores, uniqueVenues]);

  const lineResult = useMemo(() => {
    if (chartMode === 'scatter' || scores.length < 2) return null;
    const agg = chartMode === 'visit' ? visitAgg : 'play';
    return buildLineData(scores, myUsername, selectedVenueIds, effectiveViewMode, agg);
  }, [scores, chartMode, visitAgg, myUsername, selectedVenueIds, effectiveViewMode]);

  const scatterResult = useMemo(() => {
    if (chartMode !== 'scatter' || scores.length < 2) return null;
    return buildScatterData(scores, myUsername, selectedVenueIds);
  }, [chartMode, scores, myUsername, selectedVenueIds]);

  // ── guards ──────────────────────────────────────────────────────────────────

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

  // ── group colors ────────────────────────────────────────────────────────────
  // You = username yellow, the selected pod = its own color, everyone else = field purple.

  const FIELD_COLOR = 'hsl(var(--field))';
  function groupColor(g: Group) {
    return g === 'self' ? 'hsl(var(--username))' : g === 'pod' ? (podTokens?.graphic ?? FIELD_COLOR) : FIELD_COLOR;
  }
  function chaosLineColor(u: string) { return groupColor(lineResult?.userGroup[u] ?? 'other'); }
  // In All scope, field dots are the "All Players" toggle; in pod scope they're only present when
  // "All others" asked the server for them; in Mine there are none.
  const showFieldDots = scope.kind === 'all' ? effectiveViewMode === 'chaos' : true;

  // ── chart description ───────────────────────────────────────────────────────

  function chartDescription() {
    const venueNote = selectedVenueIds.length > 0 ? ' (filtered by selected venue' + (selectedVenueIds.length > 1 ? 's' : '') + ')' : '';
    const aggNoun = visitAgg === 'best' ? 'best score' : 'average score';
    if (scope.kind === 'mine') {
      if (chartMode === 'scatter') return `Every one of your plays as a dot on its actual date. The dashed line is a ${ROLLING_WINDOW}-play rolling average${venueNote}.`;
      if (chartMode === 'visit') return `Your ${aggNoun} per venue visit. Visits = groups of plays within 6 hours of each other${venueNote}.`;
      return `Your score on each play, in order. Plays from the same visit appear as consecutive points${venueNote}.`;
    }
    if (scope.kind === 'pod') {
      const others = scope.others ? ', everyone else in purple' : '';
      if (chartMode === 'scatter') {
        return `Every play as a dot on its actual date — yours in yellow, ${podName} in its color${others}. Dashed lines are each group's ${ROLLING_WINDOW}-play rolling average${venueNote}.`;
      }
      if (effectiveViewMode === 'chaos') {
        return `${chartMode === 'visit' ? `${aggNoun.charAt(0).toUpperCase() + aggNoun.slice(1)} per visit` : 'Every play numbered chronologically'}, one line per player — yours in yellow, ${podName} in its color${others}${venueNote}.`;
      }
      const vs = `the ${podName} median${scope.others ? " and everyone else's median" : ''}`;
      return chartMode === 'visit'
        ? `Your ${aggNoun} per venue visit vs. ${vs}. Visits = groups of plays within 6 hours of each other${venueNote}.`
        : `Your score on each play vs. ${vs}. Plays from the same visit appear as consecutive points${venueNote}.`;
    }
    if (chartMode === 'scatter') {
      return viewMode === 'chaos'
        ? `Every individual play as a dot on its actual date — yours in yellow, everyone else's in purple. Dashed lines are each group's ${ROLLING_WINDOW}-play rolling average${venueNote}.`
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
              <h1 className="text-3xl font-black uppercase tracking-widest text-machine leading-tight">{machine.name}</h1>
              {(machine.manufacturer || machine.year) && (
                <p className="text-sm text-muted-foreground mt-0.5">{[machine.manufacturer, machine.year].filter(Boolean).join(' · ')}</p>
              )}
              <p className="text-sm text-muted-foreground mt-1">
                {scores.length} scores {scopeLabel ? <>· {scopeLabel}</> : 'recorded'}
              </p>
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
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {scope.kind === 'mine' ? 'Your Top Score' : 'Top Score'}
              {scope.kind === 'pod' && <span className="normal-case font-normal"> · {scopeLabel}</span>}
            </p>
            <p className="text-3xl font-black text-primary">{Number(best.score).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">
              <Link href={`/users/${best.username}`} className="text-username hover:text-username/80 transition-colors">@{best.username}</Link>
              {' · '}{formatScoreTime(best.playedAt, best.venueTimezone, 'MMM d, yyyy')}
              {best.venueName && <> · <span className="text-venue">{best.venueName}</span></>}
            </p>
          </div>
        </div>
      )}

      {/* Comparison scope — sits with the chart it drives (it also scopes the Top Score above).
          The hairline + top padding separates it from the Top Score banner. */}
      {(cs.signedIn || cs.unknownPod) && (
        <div className="border-t border-white/10 pt-4 mb-3">
          {cs.signedIn && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Compare</span>
              <ComparisonScopePicker state={cs} />
            </div>
          )}
          {cs.unknownPod && (
            <p className={`text-xs text-muted-foreground ${cs.signedIn ? 'mt-2' : ''}`}>That pod isn't one of yours — showing all players.</p>
          )}
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
            {uniqueVenues.length >= 2 && effectiveViewMode === 'aggregate' && (
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

            {/* Individual-lines toggle. All scope: "All Players" (unchanged). Pod scope: "Each Player"
                — which players are in play is the scope picker's job there, so this only splits the
                medians into one line per player; it has no effect on the scatter, so it's hidden
                there. Mine: nobody to split, hidden. */}
            {(scope.kind === 'all' || (scope.kind === 'pod' && chartMode !== 'scatter')) && (
              <button
                onClick={() => { setViewMode(v => v === 'chaos' ? 'aggregate' : 'chaos'); setSelectedVenueIds([]); }}
                aria-pressed={viewMode === 'chaos'}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors ${viewMode === 'chaos' ? 'border-fuchsia-500 text-fuchsia-400 bg-fuchsia-500/10' : 'border-white/20 text-muted-foreground hover:text-white hover:border-white/40'}`}
              >
                <Users className="w-3 h-3" /> {scope.kind === 'pod' ? 'Each Player' : 'All Players'}
              </button>
            )}
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
          {effectiveViewMode === 'aggregate' && chartMode !== 'scatter' && lineResult?.type === 'aggregate' && (
            <div className="flex items-center gap-4 mb-3 text-xs flex-wrap">
              {myUsername && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-username" /><span className="text-muted-foreground">You ({myUsername})</span></div>}
              {pod && podTokens && lineResult.hasPod && (
                <div className="flex items-center gap-1.5" style={podColorVars(pod.color)}>
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={podTokens.graphic} strokeWidth="2" strokeDasharray="4 3" /></svg>
                  <span className="text-pod-text font-semibold truncate max-w-[10rem]">{pod.name}</span>
                  <span className="text-muted-foreground">median</span>
                </div>
              )}
              {(scope.kind === 'all' || lineResult.hasField) && (
                <div className="flex items-center gap-1.5">
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="hsl(var(--field))" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                  <span className="text-muted-foreground">{othersLabel} median</span>
                </div>
              )}
            </div>
          )}
          {/* Pod scope, one line per player: say which color is which */}
          {scope.kind === 'pod' && pod && chartMode !== 'scatter' && lineResult?.type === 'chaos' && (
            <div className="flex items-center gap-4 mb-3 text-xs flex-wrap">
              {myUsername && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-username" /><span className="text-muted-foreground">You</span></div>}
              <div className="flex items-center gap-1.5" style={podColorVars(pod.color)}>
                <div className="w-3 h-0.5 rounded bg-pod" /><span className="text-pod-text font-semibold truncate max-w-[10rem]">{pod.name}</span>
              </div>
              {scope.others && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-field" /><span className="text-muted-foreground">Everyone else</span></div>}
            </div>
          )}
          {chartMode === 'scatter' && scatterResult?.type === 'aggregate' && myUsername && (
            <div className="flex items-center gap-4 mb-3 text-xs flex-wrap">
              <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-username" /><span className="text-muted-foreground">Your plays</span></div>
              <div className="flex items-center gap-1.5">
                <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="hsl(var(--username))" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                <span className="text-muted-foreground">{ROLLING_WINDOW}-play rolling avg</span>
              </div>
              {pod && podTokens && scatterResult.podDots.length > 0 && (
                <div className="flex items-center gap-1.5" style={podColorVars(pod.color)}>
                  <div className="w-2 h-2 rounded-full bg-pod" />
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={podTokens.graphic} strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                  <span className="text-pod-text font-semibold truncate max-w-[10rem]">{pod.name}</span>
                  <span className="text-muted-foreground">plays &amp; avg</span>
                </div>
              )}
              {showFieldDots && (scope.kind === 'all' || scatterResult.fieldDots.length > 0) && (
                <>
                  <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-field opacity-40" /><span className="text-muted-foreground">Others' plays</span></div>
                  <div className="flex items-center gap-1.5">
                    <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="hsl(var(--field))" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                    <span className="text-muted-foreground">Others' rolling avg</span>
                  </div>
                </>
              )}
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
                  content={<LineTooltip chartMode={chartMode} visitAgg={visitAgg} myUsername={myUsername} lineType={lineResult.type} podName={podName} othersLabel={othersLabel} />}
                  cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }}
                />
                {lineResult.type === 'aggregate' && (
                  <>
                    <Line type="monotone" dataKey="field" stroke="hsl(var(--field))" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls={false} />
                    {lineResult.hasPod && podTokens && (
                      <Line type="monotone" dataKey="pod" stroke={podTokens.graphic} strokeWidth={2} strokeDasharray="5 3"
                        // Dots, unlike the field median: pods are small, so the median is often
                        // only a point or two, which a dot-less line wouldn't draw at all.
                        dot={{ r: 3, strokeWidth: 0, fill: podTokens.graphic }}
                        activeDot={{ r: 5, strokeWidth: 0, fill: podTokens.graphic }} connectNulls={false} />
                    )}
                    {myUsername && (
                      <Line type="monotone" dataKey="my" stroke="hsl(var(--username))" strokeWidth={2.5}
                        dot={{ fill: 'hsl(var(--username))', r: 4, strokeWidth: 0 }} activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                    )}
                  </>
                )}
                {lineResult.type === 'venue' && lineResult.lineKeys.map((vn, i) => (
                  <Line key={vn} type="monotone" dataKey={vn}
                    stroke={VENUE_COLORS[i % VENUE_COLORS.length]} strokeWidth={2}
                    dot={{ fill: VENUE_COLORS[i % VENUE_COLORS.length], r: 4, strokeWidth: 0 }}
                    activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                ))}
                {/* Drawn back to front: everyone else, then the pod, then you on top. */}
                {lineResult.type === 'chaos' && [...lineResult.lineKeys].reverse().map(u => {
                  const g = lineResult.userGroup[u] ?? 'other';
                  return (
                    <Line key={u} type="monotone" dataKey={u}
                      stroke={chaosLineColor(u)}
                      strokeWidth={g === 'self' ? 2.5 : g === 'pod' ? 2 : 1.5}
                      strokeOpacity={g === 'self' ? 1 : g === 'pod' ? 0.85 : 0.5}
                      dot={{ fill: chaosLineColor(u), r: g === 'self' ? 4 : 3, strokeWidth: 0, fillOpacity: g === 'other' ? 0.6 : 1 }}
                      activeDot={{ r: 6, strokeWidth: 0 }} connectNulls={false} />
                  );
                })}
              </LineChart>
            ) : scatterResult ? (
              <ComposedChart margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                data={
                  scatterResult.type === 'venue'
                    ? scatterResult.perVenue.flatMap(v => v.dots)
                    : [...scatterResult.myDots, ...scatterResult.podDots, ...(showFieldDots ? scatterResult.fieldDots : [])]
                }>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="x" type="number" scale="time" domain={['auto', 'auto']}
                  tick={AXIS_STYLE} tickLine={false} axisLine={false}
                  tickFormatter={v => format(new Date(v), 'MMM d')} />
                <YAxis dataKey="y" type="number" domain={['auto', 'auto']} tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={formatScore} width={48} />
                <Tooltip content={<ScatterTooltip podName={podName} podText={podTokens?.text} othersLabel="Others'" />} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1 }} />

                {scatterResult.type === 'aggregate' && (
                  <>
                    {showFieldDots && scatterResult.fieldDots.length > 0 && (
                      <Scatter dataKey="y" data={scatterResult.fieldDots} name="Others" fill="hsl(var(--field))" fillOpacity={0.4} />
                    )}
                    {podTokens && scatterResult.podDots.length > 0 && (
                      <Scatter dataKey="y" data={scatterResult.podDots} name={podName} fill={podTokens.graphic} fillOpacity={0.85} />
                    )}
                    {scatterResult.myDots.length > 0 && (
                      <Scatter dataKey="y" data={scatterResult.myDots} name={myUsername ?? 'You'} fill="hsl(var(--username))" />
                    )}
                    {scatterResult.trendLine.length >= 2 && (
                      <Line dataKey="trend" data={scatterResult.trendLine} stroke="hsl(var(--username))" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
                    )}
                    {showFieldDots && scatterResult.fieldTrendLine.length >= 2 && (
                      <Line dataKey="trend" data={scatterResult.fieldTrendLine} stroke="hsl(var(--field))" strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
                    )}
                    {podTokens && scatterResult.podTrendLine.length >= 2 && (
                      <Line dataKey="trend" data={scatterResult.podTrendLine} stroke={podTokens.graphic} strokeWidth={1.5} strokeDasharray="5 3" dot={false} connectNulls />
                    )}
                  </>
                )}
                {scatterResult.type === 'venue' && scatterResult.perVenue.map((v, i) => (
                  <Scatter key={v.venueName} dataKey="y" data={v.dots} name={v.venueName} fill={VENUE_COLORS[i % VENUE_COLORS.length]} />
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
          <h2 className="text-sm font-bold uppercase tracking-wider text-white mb-1">
            Venue Difficulty{' '}
            <span className="normal-case font-normal text-muted-foreground">
              (vs. machine overall average of <span className="text-primary font-semibold">{formatScore(machineAvgScore)}</span>)
            </span>
          </h2>
          <p className="text-xs text-muted-foreground mb-4">
            Player-normalized: based on players who have played this machine at multiple venues, isolating venue difficulty from player skill.
            {scopeLabel && <> Computed from the scores in this view ({scopeLabel.toLowerCase()}).</>}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {venueDifficulty.map(v => {
              const { text, color } = difficultyLabel(v.diffPct);
              const lowConf = v.crossVenueCount < 3;
              return (
                <div key={v.venueId} className="rounded-lg border border-venue/30 bg-white/3 p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-sm font-semibold text-venue truncate">{v.venueName}</p>
                    <span className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0" style={{ color, background: `${color}20` }}>{text}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Avg {formatScore(v.avgScore)} · {v.count} score{v.count !== 1 ? 's' : ''}
                    {v.rawDiffPct !== 0 && <> · {v.rawDiffPct > 0 ? '+' : ''}{v.rawDiffPct.toFixed(1)}% vs avg</>}
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
                      {formatScoreTime(s.playedAt, s.venueTimezone, 'MMM d, yyyy')}
                      <span className="text-muted-foreground ml-2">{formatScoreTime(s.playedAt, s.venueTimezone, 'h:mm a')}</span>
                      {s.id === best?.id && <span className="ml-2 text-xs font-bold bg-primary text-white px-1.5 py-0.5 rounded">BEST</span>}
                    </p>
                    {s.venueName && (
                      <p className="text-xs text-venue flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3" />{s.venueName}
                        {s.venueIsResidence && <Home className="w-3 h-3 flex-shrink-0" />}
                      </p>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Link href={`/users/${s.username}`} className="text-sm text-username hover:text-username/80 transition-colors truncate">
                      @{s.username}
                    </Link>
                    <PodMemberIcons pods={podMembership.get(s.username)} />
                  </div>
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
