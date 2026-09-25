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
  ScatterChart, LineChart, Line, Scatter, XAxis, YAxis,
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

const VISIT_GAP_MS  = 6 * 3600 * 1000; // 6-hour gap = new visit
const ROLLING_WINDOW = 5;

type ChartMode = 'play' | 'visit' | 'scatter';
/** Scatter only: each group's rolling-average line (with its turning points), or every score as a dot. */
type ScatterView = 'trend' | 'scores';
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

interface ScatterDot {
  x: number; y: number; playedAt: string;
  venue?: string; venueTimezone?: string; username?: string;
}
type TrendOwner = 'me' | 'pod' | 'field';
interface TrendPoint { x: number; y: number; n: number; turn: boolean; owner: TrendOwner; play: ScatterDot }

/**
 * A group's rolling average over its plays in date order, one point per calendar day (the average
 * as it stood after that day's last play). Several plays on one day share almost the same x, so a
 * point per play drew vertical spikes. `turn` marks where the line changes direction (local peaks
 * and valleys) plus its first and last points — the only places the Trend view draws a dot.
 *
 * Until a group has ROLLING_WINDOW plays, a point averages all of its plays so far (the tooltip
 * says so), so the line covers the group's whole history rather than starting mid-series.
 */
function rollingTrend(dots: ScatterDot[], owner: TrendOwner, window = ROLLING_WINDOW): TrendPoint[] {
  const perPlay = dots.map((p, i) => {
    const slice = dots.slice(Math.max(0, i - window + 1), i + 1);
    return { x: p.x, y: Math.round(slice.reduce((s, d) => s + d.y, 0) / slice.length), n: slice.length, turn: false, owner, play: p };
  });
  const byDay = new Map<string, TrendPoint>();
  for (const p of perPlay) byDay.set(format(new Date(p.x), 'yyyy-MM-dd'), p); // last play of the day wins
  const pts = [...byDay.values()];
  let prevDir = 0;
  pts.forEach((p, i) => {
    if (i === 0 || i === pts.length - 1) { p.turn = true; }
    const next = pts[i + 1];
    if (!next) return;
    const dir = Math.sign(next.y - p.y);
    if (dir === 0) return; // a flat step keeps the previous direction
    if (i > 0 && prevDir !== 0 && dir !== prevDir) p.turn = true;
    prevDir = dir;
  });
  return pts;
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
  filtered: any[],
  myUsername: string | null,
  viewMode: ViewMode,
  agg: VisitAgg | 'play',
) {

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

function buildScatterData(filtered: any[], myUsername: string | null) {
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.playedAt).getTime() - new Date(b.playedAt).getTime(),
  );
  // Every group the Compare scope put in the response: you, the pod (pod scope) and everyone else
  // (All scope, or pod scope with "All others"). Nothing in the chart hides a group.
  const dotsFor = (grp: Group): ScatterDot[] => sorted.filter(s => groupOf(s, myUsername) === grp).map(s => ({
    x: new Date(s.playedAt).getTime(), y: Number(s.score),
    venue: s.venueName, venueTimezone: s.venueTimezone, playedAt: s.playedAt,
    ...(grp === 'self' ? {} : { username: s.username as string }),
  }));
  const myDots = dotsFor('self'), podDots = dotsFor('pod'), fieldDots = dotsFor('other');
  return {
    myDots, podDots, fieldDots,
    myTrend: rollingTrend(myDots, 'me'), podTrend: rollingTrend(podDots, 'pod'), fieldTrend: rollingTrend(fieldDots, 'field'),
  };
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
  const entry = payload[0];
  const d = entry?.payload;
  if (!d) return null;
  // A turning point on a rolling-average line (Trend view).
  if ('turn' in d) {
    const owner: TrendOwner = d.owner;
    const who = owner === 'pod' ? `${podName}` : owner === 'field' ? othersLabel : 'Your';
    const play: ScatterDot = d.play;
    return (
      <div className="rounded-lg border border-white/20 bg-zinc-900/95 p-2.5 text-xs shadow-xl max-w-[220px]">
        <p className="text-muted-foreground">
          {who} {d.n < ROLLING_WINDOW ? `avg of first ${d.n} play${d.n === 1 ? '' : 's'}` : `${ROLLING_WINDOW}-play avg`}
        </p>
        <p className={`font-bold ${owner === 'field' ? 'text-field' : owner === 'pod' ? '' : 'text-username'}`} style={owner === 'pod' ? { color: podText } : undefined}>
          {Number(d.y).toLocaleString()}
        </p>
        <p className="text-muted-foreground">{format(new Date(d.x), 'MMM d, yyyy')}</p>
        <div className="mt-1.5 pt-1.5 border-t border-white/10">
          <p className="text-muted-foreground">Latest play: <span className="text-white font-semibold">{Number(play.y).toLocaleString()}</span></p>
          {play.username && <p className="text-username">@{play.username}</p>}
          {play.venue && <p className="text-venue">{play.venue}</p>}
        </div>
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
  const [scatterView, setScatterView] = useState<ScatterView>('trend');
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
  // Everyone outside you (and the pod): "Field" in All scope, "Everyone else" next to a pod.
  const othersLabel = scope.kind === 'pod' ? 'Everyone else' : 'Field';
  // Compare decides WHO is on the chart; the Median | Each Player switch only decides HOW the other
  // players are drawn in By Play / By Visit. Mine has nobody to split out, and Scatter already plots
  // every individual play, so both always use the aggregate view (the switch is hidden there).
  const effectiveViewMode: ViewMode = scope.kind === 'mine' || chartMode === 'scatter' ? 'aggregate' : viewMode;
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

  // The venue picker is a pure filter on the chart's records: same series, same colors, fewer
  // points. It doesn't touch Top Score, Venue Difficulty or the table. Only venues still present in
  // the current Compare scope count (a selection can outlive a scope switch), and a picker that
  // isn't shown (scores at one venue) never filters.
  const activeVenueIds = useMemo(
    () => uniqueVenues.length < 2 ? [] : selectedVenueIds.filter(id => uniqueVenues.some(v => v.venueId === id)),
    [selectedVenueIds, uniqueVenues],
  );
  const chartScores = useMemo(
    () => activeVenueIds.length ? scores.filter(s => activeVenueIds.includes(s.venueId)) : scores,
    [scores, activeVenueIds],
  );

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
    return buildLineData(chartScores, myUsername, effectiveViewMode, agg);
  }, [scores.length, chartScores, chartMode, visitAgg, myUsername, effectiveViewMode]);

  const scatterResult = useMemo(() => {
    if (chartMode !== 'scatter' || scores.length < 2) return null;
    return buildScatterData(chartScores, myUsername);
  }, [chartMode, scores.length, chartScores, myUsername]);

  // Scatter axes. Recharts' 'auto' domains put the earliest/latest play and the top score exactly
  // on the plot edge, so those dots were cut in half. Pad the time axis a little on both sides and
  // leave headroom above the highest thing drawn (rolling averages in Trend, scores in Scores).
  const scatterAxes = useMemo(() => {
    if (!scatterResult) return null;
    const dots = [...scatterResult.myDots, ...scatterResult.podDots, ...scatterResult.fieldDots];
    if (!dots.length) return null;
    const xs = dots.map(d => d.x);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const xPad = Math.max((xMax - xMin) * 0.03, 12 * 3600 * 1000);
    const ys = scatterView === 'trend'
      ? [...scatterResult.myTrend, ...scatterResult.podTrend, ...scatterResult.fieldTrend].map(p => p.y)
      : dots.map(d => d.y);
    // Round, evenly spaced y ticks (0, 30M, 60M…) with the top one above the highest value.
    const yRaw = Math.max(...ys, 1) * 1.05;
    const mag = 10 ** Math.floor(Math.log10(yRaw / 4));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => yRaw / st <= 5) ?? 10 * mag;
    const yTicks = Array.from({ length: Math.ceil(yRaw / step) + 1 }, (_, i) => i * step);
    // Time ticks on month starts (or on Mondays for a span under ~2 months), so they read as dates
    // rather than the arbitrary days a numeric axis picks.
    const x0 = xMin - xPad, x1 = xMax + xPad;
    const monthly = x1 - x0 > 60 * 86_400_000;
    const xTicks: number[] = [];
    const d = new Date(x0);
    if (monthly) { d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1); }
    else { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); }
    while (d.getTime() <= x1) {
      xTicks.push(d.getTime());
      if (monthly) d.setMonth(d.getMonth() + 1); else d.setDate(d.getDate() + 7);
    }
    return {
      x: [x0, x1] as [number, number], xTicks, xFormat: monthly ? 'MMM' : 'MMM d',
      yTicks, yMax: yTicks[yTicks.length - 1],
    };
  }, [scatterResult, scatterView]);

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

  // ── chart description ───────────────────────────────────────────────────────

  function chartDescription() {
    const aggNoun = visitAgg === 'best' ? 'best score' : 'average score';
    const visitNote = 'Visits = groups of plays within 6 hours of each other';
    const n = activeVenueIds.length;
    const venueNote = n === 0 ? ''
      : n === 1 ? ` Only plays at ${uniqueVenues.find(v => v.venueId === activeVenueIds[0])?.venueName ?? 'the selected venue'}.`
      : ` Only plays at the ${n} selected venues.`;
    const trendNote = `Lines are ${ROLLING_WINDOW}-play rolling averages, one point per day; dots mark where a line turns.`;
    if (scope.kind === 'mine') {
      if (chartMode === 'scatter') {
        return (scatterView === 'trend'
          ? `Your ${ROLLING_WINDOW}-play rolling average over time, one point per day; dots mark where it turns.`
          : 'Every one of your plays as a dot on its actual date.') + venueNote;
      }
      if (chartMode === 'visit') return `Your ${aggNoun} per venue visit. ${visitNote}.${venueNote}`;
      return `Your score on each play, in order. Plays from the same visit appear as consecutive points.${venueNote}`;
    }
    // Who else Compare put on the chart, and in which color.
    const who = scope.kind === 'pod'
      ? `${podName} in its color${scope.others ? ', everyone else in purple' : ''}`
      : 'everyone else in purple';
    if (chartMode === 'scatter') {
      return (scatterView === 'trend'
        ? `Yours in yellow, ${who}. ${trendNote}`
        : `Every play as a dot on its actual date — yours in yellow, ${who}.`) + venueNote;
    }
    if (effectiveViewMode === 'chaos') {
      const what = chartMode === 'visit'
        ? `${aggNoun.charAt(0).toUpperCase() + aggNoun.slice(1)} per visit`
        : 'Every play numbered chronologically';
      return `${what}, one line per player — yours in yellow, ${who}.${chartMode === 'visit' ? ` ${visitNote}.` : ''}${venueNote}`;
    }
    const vs = scope.kind === 'pod'
      ? `the ${podName} median${scope.others ? " and everyone else's median" : ''}`
      : 'the field median (everyone else)';
    return (chartMode === 'visit'
      ? `Your ${aggNoun} per venue visit vs. ${vs}. ${visitNote}.`
      : `Your score on each play vs. ${vs}. Plays from the same visit appear as consecutive points.`) + venueNote;
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
            {uniqueVenues.length >= 2 && (
              <VenueDropdown
                venues={uniqueVenues}
                selectedIds={activeVenueIds}
                onToggle={id => setSelectedVenueIds(activeVenueIds.includes(id) ? activeVenueIds.filter(x => x !== id) : [...activeVenueIds, id])}
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

            {/* Median | Each Player — a display switch only. Compare (above) decides who is on the
                chart; this decides whether the other players are drawn as one median line per group
                or as one line per player. Same meaning in All and pod scope. Hidden in Mine (only
                you) and in Scatter (every play is already its own dot there). */}
            {scope.kind !== 'mine' && chartMode !== 'scatter' && (
              <div role="group" aria-label="Draw other players as"
                className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider">
                {(['aggregate', 'chaos'] as ViewMode[]).map(m => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={viewMode === m}
                    title={m === 'aggregate' ? 'One median line per group' : 'One line per player'}
                    onClick={() => setViewMode(m)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${viewMode === m ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
                  >
                    {m === 'chaos' && <Users className="w-3 h-3" />}
                    {m === 'aggregate' ? 'Median' : 'Each Player'}
                  </button>
                ))}
              </div>
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

          {/* Scatter sub-toggle: rolling-average lines, or every individual score. */}
          {chartMode === 'scatter' && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs text-muted-foreground">Show:</span>
              <div role="group" aria-label="Scatter shows"
                className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider">
                {(['trend', 'scores'] as ScatterView[]).map(v => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={scatterView === v}
                    title={v === 'trend' ? `Each group's ${ROLLING_WINDOW}-play rolling average` : 'Every individual score as a dot'}
                    onClick={() => setScatterView(v)}
                    className={`px-3 py-1 rounded-md transition-colors ${scatterView === v ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
                  >
                    {v === 'trend' ? `${ROLLING_WINDOW}-Play Avg` : 'Every Score'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Legends — one entry per group actually drawn. */}
          {lineResult?.type === 'aggregate' && (
            <div className="flex items-center gap-4 mb-3 text-xs flex-wrap">
              {myUsername && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-username" /><span className="text-muted-foreground">You ({myUsername})</span></div>}
              {pod && podTokens && lineResult.hasPod && (
                <div className="flex items-center gap-1.5" style={podColorVars(pod.color)}>
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke={podTokens.graphic} strokeWidth="2" strokeDasharray="4 3" /></svg>
                  <span className="text-pod-text font-semibold truncate max-w-[10rem]">{pod.name}</span>
                  <span className="text-muted-foreground">median</span>
                </div>
              )}
              {lineResult.hasField && (
                <div className="flex items-center gap-1.5">
                  <svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="hsl(var(--field))" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
                  <span className="text-muted-foreground">{othersLabel} median</span>
                </div>
              )}
            </div>
          )}
          {lineResult?.type === 'chaos' && (() => {
            const groups = new Set(Object.values(lineResult.userGroup));
            return (
              <div className="flex items-center gap-4 mb-3 text-xs flex-wrap">
                {groups.has('self') && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-username" /><span className="text-muted-foreground">You ({myUsername})</span></div>}
                {pod && groups.has('pod') && (
                  <div className="flex items-center gap-1.5" style={podColorVars(pod.color)}>
                    <div className="w-3 h-0.5 rounded bg-pod" /><span className="text-pod-text font-semibold truncate max-w-[10rem]">{pod.name}</span>
                    <span className="text-muted-foreground">(each player)</span>
                  </div>
                )}
                {groups.has('other') && <div className="flex items-center gap-1.5"><div className="w-3 h-0.5 rounded bg-field" /><span className="text-muted-foreground">{othersLabel} (each player)</span></div>}
              </div>
            );
          })()}
          {scatterResult && (() => {
            const trend = scatterView === 'trend';
            // Matches the chart: your line is solid, the others dashed.
            const mark = (color: string, solid = false) => trend ? (
              <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth={solid ? 2 : 1.5} strokeDasharray={solid ? undefined : '4 3'} /><circle cx="9" cy="4" r="3" fill={color} /></svg>
            ) : (
              <svg width="8" height="8"><circle cx="4" cy="4" r="4" fill={color} /></svg>
            );
            const noun = trend ? `${ROLLING_WINDOW}-play avg` : 'plays';
            return (
              <div className="flex items-center gap-4 mb-3 text-xs flex-wrap">
                {scatterResult.myDots.length > 0 && (
                  <div className="flex items-center gap-1.5">{mark('hsl(var(--username))', true)}<span className="text-muted-foreground">Your {noun}</span></div>
                )}
                {pod && podTokens && scatterResult.podDots.length > 0 && (
                  <div className="flex items-center gap-1.5" style={podColorVars(pod.color)}>
                    {mark(podTokens.graphic)}
                    <span className="text-pod-text font-semibold truncate max-w-[10rem]">{pod.name}</span>
                    <span className="text-muted-foreground">{noun}</span>
                  </div>
                )}
                {scatterResult.fieldDots.length > 0 && (
                  <div className="flex items-center gap-1.5">{mark('hsl(var(--field))')}<span className="text-muted-foreground">{othersLabel} {noun}</span></div>
                )}
              </div>
            );
          })()}

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
            ) : scatterResult && scatterAxes ? (
              <ScatterChart margin={{ top: 10, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="x" type="number" scale="time" domain={scatterAxes.x} allowDataOverflow
                  ticks={scatterAxes.xTicks} interval="preserveStartEnd"
                  tick={AXIS_STYLE} tickLine={false} axisLine={false}
                  tickFormatter={v => format(new Date(v), scatterAxes.xFormat)} />
                <YAxis dataKey="y" type="number" domain={[0, scatterAxes.yMax]} ticks={scatterAxes.yTicks}
                  tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={formatScore} width={48} />
                <Tooltip content={<ScatterTooltip podName={podName} podText={podTokens?.text} othersLabel={othersLabel} />} cursor={false} />
                {scatterView === 'scores' ? (
                  <>
                    {/* Drawn back to front, you on top. Full opacity for everyone: nobody is dimmed. */}
                    {scatterResult.fieldDots.length > 0 && (
                      <Scatter data={scatterResult.fieldDots} name="field" fill={FIELD_COLOR} isAnimationActive={false} />
                    )}
                    {podTokens && scatterResult.podDots.length > 0 && (
                      <Scatter data={scatterResult.podDots} name="pod" fill={podTokens.graphic} isAnimationActive={false} />
                    )}
                    {scatterResult.myDots.length > 0 && (
                      <Scatter data={scatterResult.myDots} name="me" fill="hsl(var(--username))" isAnimationActive={false} />
                    )}
                  </>
                ) : (
                  ([
                    ['field', scatterResult.fieldTrend, FIELD_COLOR],
                    ['pod', podTokens ? scatterResult.podTrend : [], podTokens?.graphic ?? FIELD_COLOR],
                    ['me', scatterResult.myTrend, 'hsl(var(--username))'],
                  ] as [string, TrendPoint[], string][]).filter(([, pts]) => pts.length > 0).map(([owner, pts, color]) => (
                    <Scatter key={owner} data={pts} name={owner} fill={color}
                      line={{ stroke: color, strokeWidth: owner === 'me' ? 2 : 1.5, strokeDasharray: owner === 'me' ? undefined : '5 3' }}
                      isAnimationActive={false}
                      // Dots only where the average turns (and at its ends); other points draw nothing,
                      // so they also can't be hovered: the tooltips live on the turning points.
                      shape={(props: any) => props.payload?.turn
                        ? <circle cx={props.cx} cy={props.cy} r={owner === 'me' ? 4 : 3.5} fill={color} />
                        : <g />} />
                  ))
                )}
              </ScatterChart>
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
