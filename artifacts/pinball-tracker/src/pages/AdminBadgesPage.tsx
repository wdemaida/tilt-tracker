import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, Trash2, Eye, Rocket, Archive, Loader2, UserPlus, X, ChevronDown, ChevronUp, Search, History, GripVertical, Layers, AlertTriangle } from 'lucide-react';
import {
  useAdminApi, type AdminBadge, type AdminBadgeSeries, type BadgeOrderItem, type BadgeInput, type BadgeKind, type BadgeRule, type BadgePreview,
  type BadgeBackfillResult, type UserRef, type NewTierDraft,
} from '../lib/adminApi';
import { useApi } from '../lib/useApi';
import { toLocalInput, localInputToIso } from '../lib/datetime';
import { AdminShell, Card, Pill, SectionTitle, ErrorNote, ConfirmDialog, When, Who, Segmented } from '../components/admin/AdminParts';
import BadgeImage, { BADGE_ICONS, badgeIcon } from '../components/BadgeImage';
import UsernameLink from '../components/UsernameLink';
import MachineCombobox, { type MachineOption } from '../components/MachineCombobox';
import { toast } from '../lib/toast';
import { BADGES_KEY } from '../lib/badges';

// /admin/badges — create and edit badges (metric / rule / manual), upload artwork, preview who
// qualifies, go live (with retroactive backfill when that's on), retire, and grant/revoke by hand.
// Everything goes through ConfirmDialog and invalidates every ['admin', …] query afterwards — plus
// the notifications, badge catalog and shelves, since going live / granting can award the admin
// themself. The editor opens inline under the badge it edits (new badges: at the top), scrolls into
// view and focuses Name; saving an edit collapses it with a toast. The server is the authority on
// validation (routes/adminBadges.ts) — its per-field errors show inline and keep the editor open.
//
// Unsaved edits never reach an action silently: Go live saves first ("Save & go live") and then
// activates the saved badge; Preview and Backfill now are disabled until the edits are saved. (Going
// live with Retroactive ticked but unsaved used to activate forward-only — prod "First Ball".)
// Saving a LIVE badge with Retroactive newly on backfills server-side, so that save asks first.
//
// Series (feature/badge-series): a badge's Series is None / an existing series / "New series…". A
// series has ONE color — a tier shows the series color control (it recolors every tier) instead of
// its own. Creating a metric badge whose metric already has a series preselects it. The list is in
// the shared order (series as a unit, singles between them): drag a row by its handle, or use the
// move up/down buttons (keyboard and phones). Every move PUTs the full order.
//
// Inside a series there's one ordering key (the tier's sort_order): a tier with a threshold is placed
// by its N (server-side, on create / N change) and has no handle; a rule/manual tier has its own
// handle + ▲/▼ and goes anywhere in the ladder (PUT /badge-series/:id/order — the server refuses an
// order that puts a higher N first, which the UI can't produce since only N-less tiers move).
// "Add tier" on a series opens the editor prefilled from GET /badge-series/:id/new-tier (kind,
// metric, next N, icon, series color, description from the series' {N} template). While a tier's
// description still equals the template's text (`descLinked`), editing N rewrites it; once the
// admin edits the description by hand it stays theirs.
//
// One metric per series (the server refuses otherwise: 400 series_metric_mismatch, shown inline on
// Metric): with a series whose tiers already have a metric picked, Metric is locked to it ("All tiers
// in Venues count Different venues"), and picking a series (or switching Kind to Metric in one) sets
// it. With no series yet, the Series select offers only the series compatible with the chosen metric
// (plus None / New series). Data from before the rule is never rewritten here: a series whose metric
// tiers disagree gets an amber warning in the list (the server's `metricConflict`), the odd tier a
// line of its own, and its editor says how to fix it (change the metric, or move it out).

const STATUS_TONE = { draft: 'muted', live: 'ok', retired: 'warn' } as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const input = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full';
const btn = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-colors';

function Field({ label, error, hint, children, group = false }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  // `group`: a composite control (picker, combobox). A <label> would forward every click inside it
  // to its first button, so those get a div and name themselves.
  const Wrap = group ? 'div' : 'label';
  return (
    <Wrap className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
      {hint && !error && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </Wrap>
  );
}

const ICON_NAMES = Object.keys(BADGE_ICONS).sort();
const GRID_COLS = 6;

/** The icon field: a button showing the current icon, opening a searchable grid of every allowed icon in the badge's color. */
function IconPicker({ value, color, onChange }: { value: string; color: string; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const names = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s+/g, '-');
    return needle ? ICON_NAMES.filter(n => n.includes(needle)) : ICON_NAMES;
  }, [q]);
  const known = !!BADGE_ICONS[value];
  const Current = badgeIcon(value);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function close(refocus = true) {
    setOpen(false);
    setQ('');
    if (refocus) triggerRef.current?.focus();
  }
  function choose(name: string) {
    onChange(name);
    close();
  }
  function focusCell(i: number) {
    const cells = gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-icon]');
    if (!cells?.length) return;
    cells[Math.max(0, Math.min(i, cells.length - 1))].focus();
  }
  function onGridKey(e: React.KeyboardEvent, i: number) {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLS, ArrowUp: -GRID_COLS };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      if (e.key === 'ArrowUp' && i < GRID_COLS) { searchRef.current?.focus(); return; }
      focusCell(i + move);
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popId}
        aria-label={`Icon: ${value}${known ? '' : ' (unknown)'}. Change icon`}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="flex items-center gap-2 w-full border border-white/20 rounded-lg pl-2 pr-2.5 py-1.5 text-sm text-white bg-white/5 hover:border-white/35 focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border flex-shrink-0" style={{ color, backgroundColor: `${color}26`, borderColor: `${color}80` }}>
          <Current className="w-4 h-4" strokeWidth={2.25} aria-hidden />
        </span>
        <span className="flex-1 min-w-0 truncate text-left">{value}{known ? '' : ' (unknown)'}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
      </button>
      {open && (
        <div id={popId} role="dialog" aria-label="Choose an icon"
          className="absolute left-0 top-full mt-1 z-30 w-[18.5rem] max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 bg-card shadow-2xl p-2.5 flex flex-col gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            <input
              ref={searchRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); focusCell(0); }
                if (e.key === 'Enter' && names.length) { e.preventDefault(); choose(names[0]); }
              }}
              placeholder="Search icons…"
              aria-label="Search icons"
              className="border border-white/20 rounded-lg pl-8 pr-2 py-1.5 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full"
            />
          </div>
          {names.length === 0 ? (
            <p className="text-xs text-muted-foreground px-1 py-2">No icon matches “{q.trim()}”.</p>
          ) : (
            <div ref={gridRef} role="listbox" aria-label="Icons" className="grid grid-cols-6 gap-1 max-h-60 overflow-y-auto">
              {names.map((name, i) => {
                const Icon = BADGE_ICONS[name];
                const on = name === value;
                return (
                  <button
                    key={name}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-icon={name}
                    title={name}
                    aria-label={name}
                    onClick={() => choose(name)}
                    onKeyDown={e => onGridKey(e, i)}
                    className={`flex items-center justify-center h-10 rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${on ? 'border-white/60 bg-white/10' : 'border-transparent hover:bg-white/5 hover:border-white/15'}`}
                    style={{ color }}
                  >
                    <Icon className="w-5 h-5" strokeWidth={2.25} aria-hidden />
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground px-1">Shown only when the badge has no uploaded image.</p>
        </div>
      )}
    </div>
  );
}

interface Draft {
  key: string; name: string; description: string; icon: string; color: string; kind: BadgeKind;
  metric: string; threshold: string; rule: BadgeRule; retroactive: boolean;
  availableFrom: string; availableTo: string;
  /** '' = no series (a single), 'new' = create one, else the series id. */
  seriesId: string;
  /** The chosen series' name and color (a new one's, or edits to an existing one's — every tier). */
  seriesName: string; seriesColor: string;
}

const EMPTY: Draft = {
  key: '', name: '', description: '', icon: 'award', color: '#f59e0b', kind: 'metric', metric: 'scores_posted', threshold: '10',
  rule: {}, retroactive: false, availableFrom: '', availableTo: '', seriesId: '', seriesName: '', seriesColor: '#f59e0b',
};

/** Same rules as the server's badgeSeries.ts: {N} → the threshold with thousands separators. */
const N_TOKEN = '{N}';
const renderTemplate = (template: string, n: number) => template.split(N_TOKEN).join(n.toLocaleString('en-US'));
/** A tier placed by its N (a metric badge with a threshold); rule/manual tiers are placed by hand. */
const hasThreshold = (b: Pick<AdminBadge, 'kind' | 'threshold'>) => b.kind === 'metric' && b.threshold != null;
/** The threshold a draft's N field holds, or null while it isn't a positive whole number. */
function draftN(d: Pick<Draft, 'threshold'>): number | null {
  const n = Number(d.threshold);
  return d.threshold.trim() !== '' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The draft built from "Add tier": the server's prefill over the defaults, in the series. */
function draftOfPrefill(p: NewTierDraft, series: AdminBadgeSeries[]): Draft {
  const s = series.find(x => x.id === p.seriesId);
  return {
    ...EMPTY,
    key: p.key, description: p.description, icon: p.icon ?? EMPTY.icon, color: p.color,
    kind: p.kind ?? EMPTY.kind, metric: p.metric ?? EMPTY.metric,
    threshold: p.threshold != null ? String(p.threshold) : p.kind ? '' : EMPTY.threshold,
    rule: p.rule ?? {},
    seriesId: String(p.seriesId), seriesName: s?.name ?? '', seriesColor: s?.color ?? p.color,
  };
}

function draftOf(b: AdminBadge, series: AdminBadgeSeries[]): Draft {
  const s = b.seriesId != null ? series.find(x => x.id === b.seriesId) : undefined;
  return {
    key: b.key, name: b.name, description: b.description, icon: b.icon, color: b.ownColor ?? b.color, kind: b.kind,
    metric: b.metric ?? 'scores_posted', threshold: b.threshold != null ? String(b.threshold) : '',
    rule: b.rule ?? {}, retroactive: b.retroactive,
    availableFrom: b.availableFrom ? toLocalInput(b.availableFrom) : '', availableTo: b.availableTo ? toLocalInput(b.availableTo) : '',
    seriesId: s ? String(s.id) : '', seriesName: s?.name ?? '', seriesColor: s?.color ?? (b.ownColor ?? b.color),
  };
}

/** The series a metric's badges are in, when there's exactly one (a new tier on it joins that ladder). */
function seriesOfMetric(items: AdminBadge[], metric: string, series: AdminBadgeSeries[]): AdminBadgeSeries | null {
  const ids = new Set(items.filter(b => b.kind === 'metric' && b.metric === metric && b.seriesId != null).map(b => b.seriesId!));
  return ids.size === 1 ? series.find(s => ids.has(s.id)) ?? null : null;
}

/**
 * What a series' tiers with a threshold count, ignoring `excludeId` (the badge being edited) — the
 * mirror of the server's badgeSeries.seriesMetric: the metric most of them use, a tie → the highest
 * tier's. null = no metric tier (any metric may be first).
 */
function seriesMetricOf(items: AdminBadge[], seriesId: number, excludeId?: number): string | null {
  const withN = items.filter(b => b.seriesId === seriesId && b.id !== excludeId && hasThreshold(b) && b.metric)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  if (!withN.length) return null;
  const count = new Map<string, number>();
  for (const b of withN) count.set(b.metric!, (count.get(b.metric!) ?? 0) + 1);
  const most = Math.max(...count.values());
  return [...withN].reverse().find(b => count.get(b.metric!) === most)!.metric!;
}

/** The PATCH for an existing series' name/color that this draft would send, or null. */
function seriesPatchOf(d: Draft, series: AdminBadgeSeries[]): { id: number; body: { name?: string; color?: string } } | null {
  if (d.seriesId === '' || d.seriesId === 'new') return null;
  const s = series.find(x => String(x.id) === d.seriesId);
  if (!s) return null;
  const body: { name?: string; color?: string } = {};
  if (d.seriesName.trim() && d.seriesName.trim() !== s.name) body.name = d.seriesName.trim();
  if (d.seriesColor.toLowerCase() !== s.color) body.color = d.seriesColor.toLowerCase();
  return Object.keys(body).length ? { id: s.id, body } : null;
}

/** Drop empty rule fields so the server sees only real conditions. */
function cleanRule(r: BadgeRule): BadgeRule {
  const out: BadgeRule = {};
  if (r.localDate?.from && r.localDate?.to) out.localDate = r.localDate;
  if (r.daysOfWeek?.length) out.daysOfWeek = r.daysOfWeek;
  if (r.localTime?.from && r.localTime?.to) out.localTime = r.localTime;
  if (r.postedWithinHours) out.postedWithinHours = r.postedWithinHours;
  if (r.machine?.machineId) out.machine = { machineId: r.machine.machineId, matchMode: r.machine.matchMode ?? 'group' };
  if (r.venueId) out.venueId = r.venueId;
  if (r.city?.trim()) out.city = r.city.trim();
  if (r.state?.trim()) out.state = r.state.trim();
  if (r.minScore) out.minScore = r.minScore;
  if (r.scoreType) out.scoreType = r.scoreType;
  if (r.requiresPhoto) out.requiresPhoto = true;
  if (r.count && r.count > 1) out.count = r.count;
  if (r.distinct && r.distinct !== 'none') out.distinct = r.distinct;
  return out;
}

function bodyOf(d: Draft, locked: boolean): BadgeInput {
  const body: BadgeInput = {
    name: d.name, description: d.description, icon: d.icon, color: d.color, retroactive: d.retroactive,
    availableFrom: d.availableFrom ? localInputToIso(d.availableFrom) : null,
    availableTo: d.availableTo ? localInputToIso(d.availableTo) : null,
  };
  // No sortOrder: singles are placed by the list's drag / move buttons, tiers by their N (server-side)
  // or the in-series drag. The server auto-places a badge wherever it lands.
  if (d.seriesId === 'new') body.newSeries = { name: d.seriesName.trim(), color: d.seriesColor.toLowerCase() };
  else body.seriesId = d.seriesId === '' ? null : Number(d.seriesId);
  if (!locked) { body.key = d.key; body.kind = d.kind; }
  if (d.kind === 'metric') {
    if (!locked) body.metric = d.metric;
    body.threshold = d.threshold === '' ? null : Math.round(Number(d.threshold));
  }
  if (d.kind === 'rule') body.rule = cleanRule(d.rule);
  return body;
}

const num = (v: string) => (v === '' ? undefined : Math.round(Number(v)));

const players = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'player' : 'players'}`;

/** The toast after a save that backfilled (PATCH turned retroactive on for a live badge). */
function backfillToast(name: string, b: BadgeBackfillResult) {
  if ('failed' in b) return toast({ tone: 'error', title: `Saved “${name}” — backfill failed`, body: `${b.error}. Use Backfill now to retry.` });
  if (b.skippedWindow) return toast({ tone: 'info', title: `Saved “${name}”`, body: 'The availability window is shut, so nobody was backfilled.' });
  return toast({ title: `Saved — ${players(b.awarded)} awarded`, body: `“${name}” went to everyone who already qualified.` });
}

/** The form builder for the rule vocabulary. */
function RuleBuilder({ rule, onChange, error }: { rule: BadgeRule; onChange: (r: BadgeRule) => void; error?: string }) {
  const api = useApi();
  const machines = useQuery({ queryKey: ['machines', 'admin-badge-picker'], queryFn: () => api.machines.list() });
  const venues = useQuery({ queryKey: ['venues', 'admin-badge-picker'], queryFn: () => api.venues.list() });
  const set = (patch: Partial<BadgeRule>) => onChange({ ...rule, ...patch });
  const machineList = (machines.data ?? []) as MachineOption[];

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/10 p-4">
      <p className="text-xs text-muted-foreground">Every condition you fill in must hold. Dates and times are the <b>venue’s local</b> clock (no venue zone → Eastern). A date rule also requires the score to be posted within the grace window — no backdating.</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Played on or after (local date)">
          <input type="date" className={input} value={rule.localDate?.from ?? ''}
            onChange={e => set({ localDate: { from: e.target.value, to: rule.localDate?.to || e.target.value } })} />
        </Field>
        <Field label="…and on or before">
          <input type="date" className={input} value={rule.localDate?.to ?? ''}
            onChange={e => set({ localDate: { from: rule.localDate?.from || e.target.value, to: e.target.value } })} />
        </Field>
        <Field label="Posted within (hours)" hint={rule.localDate ? 'Default 48 with a date' : 'Optional'}>
          <input type="number" min={1} max={720} className={input} value={rule.postedWithinHours ?? ''}
            onChange={e => set({ postedWithinHours: num(e.target.value) })} />
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Days of week (local)</span>
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d, i) => {
            const on = rule.daysOfWeek?.includes(i) ?? false;
            return (
              <button key={d} type="button" onClick={() => set({ daysOfWeek: on ? rule.daysOfWeek!.filter(x => x !== i) : [...(rule.daysOfWeek ?? []), i].sort() })}
                className={`px-2.5 py-1 rounded text-xs font-bold ${on ? 'bg-primary text-white' : 'bg-white/5 text-muted-foreground hover:text-white'}`}>{d}</button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Local time from"><input type="time" className={input} value={rule.localTime?.from ?? ''} onChange={e => set({ localTime: { from: e.target.value, to: rule.localTime?.to ?? '' } })} /></Field>
        <Field label="Local time to" hint="Before “from” = wraps midnight"><input type="time" className={input} value={rule.localTime?.to ?? ''} onChange={e => set({ localTime: { from: rule.localTime?.from ?? '', to: e.target.value } })} /></Field>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field group label="Machine" hint={rule.machine ? 'Remove it (×) for any machine' : 'Leave empty for any machine'}>
          <MachineCombobox
            machines={machineList}
            loading={machines.isLoading}
            value={rule.machine?.machineId ?? null}
            onChange={m => set({ machine: m ? { machineId: m.id, matchMode: rule.machine?.matchMode ?? 'group' } : undefined })}
            placeholder="Any machine — search to pick one…"
          />
        </Field>
        <Field label="Machine match" hint="Any model = Pro / Premium / LE of the same game (OPDB group)">
          <select className={input} disabled={!rule.machine} value={rule.machine?.matchMode ?? 'group'}
            onChange={e => rule.machine && set({ machine: { ...rule.machine, matchMode: e.target.value as 'group' | 'exact' } })}>
            <option value="group">Any model of this game</option>
            <option value="exact">This exact machine</option>
          </select>
        </Field>
        <Field label="Venue">
          <select className={input} value={rule.venueId ?? ''} onChange={e => set({ venueId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Any venue</option>
            {((venues.data ?? []) as Array<{ id: number; name: string }>).slice().sort((a, b) => a.name.localeCompare(b.name)).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City"><input className={input} value={rule.city ?? ''} onChange={e => set({ city: e.target.value })} /></Field>
          <Field label="State"><input className={input} value={rule.state ?? ''} onChange={e => set({ state: e.target.value })} /></Field>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Min score"><input type="number" min={1} className={input} value={rule.minScore ?? ''} onChange={e => set({ minScore: num(e.target.value) })} /></Field>
        <Field label="Score type">
          <select className={input} value={rule.scoreType ?? ''} onChange={e => set({ scoreType: (e.target.value || undefined) as BadgeRule['scoreType'] })}>
            <option value="">Any</option><option value="casual">Casual</option><option value="tournament">Tournament</option>
          </select>
        </Field>
        <Field label="How many scores"><input type="number" min={1} max={1000} className={input} value={rule.count ?? 1} onChange={e => set({ count: num(e.target.value) })} /></Field>
        <Field label="Counted">
          <select className={input} value={rule.distinct ?? 'none'} onChange={e => set({ distinct: e.target.value as BadgeRule['distinct'] })}>
            <option value="none">Any scores</option><option value="machine">Different machines</option><option value="venue">Different venues</option>
          </select>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-white/80">
        <input type="checkbox" checked={!!rule.requiresPhoto} onChange={e => set({ requiresPhoto: e.target.checked })} /> Needs a photo
      </label>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** Artwork: upload with a live 48 / 96 px preview; remove to fall back to the icon. */
function ImagePanel({ badge, onDone }: { badge: AdminBadge; onDone: () => void }) {
  const admin = useAdminApi();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!file) { setUrl(null); return; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const tooBig = !!file && file.size > 1024 * 1024;
  async function upload() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      await admin.uploadBadgeImage(badge.id, file);
      setFile(null);
      toast({ title: 'Image uploaded', body: `“${badge.name}” now uses it everywhere.` });
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-6">
        <div className="flex flex-col items-center gap-1">
          {url ? <img src={url} alt="" width={48} height={48} className="rounded-full object-contain" style={{ width: 48, height: 48 }} /> : <BadgeImage badge={badge} size={48} />}
          <span className="text-[10px] text-muted-foreground">48 px</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          {url ? <img src={url} alt="" width={96} height={96} className="rounded-full object-contain" style={{ width: 96, height: 96 }} /> : <BadgeImage badge={badge} size={96} />}
          <span className="text-[10px] text-muted-foreground">96 px</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          {url ? <img src={url} alt="" width={48} height={48} className="rounded-full object-contain grayscale opacity-40" style={{ width: 48, height: 48 }} /> : <BadgeImage badge={badge} size={48} locked />}
          <span className="text-[10px] text-muted-foreground">locked</span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">Square PNG/WebP/JPEG, ≤ 1 MB (aim for ≤ 50 KB). Keep the art inside the centre ~85% circle and bold enough to read at 48 px. The server re-encodes to 256×256 WebP. No image = the icon above.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept="image/png,image/webp,image/jpeg" onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-xs text-muted-foreground max-w-full" />
        <button type="button" onClick={upload} disabled={!file || busy || tooBig} className={`${btn} bg-primary text-white hover:bg-primary/90`}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Upload
        </button>
        {badge.imageVersion != null && (
          <button type="button" onClick={() => setConfirmRemove(true)} className={`${btn} border border-white/15 text-muted-foreground hover:text-white`}>
            <Trash2 className="w-3.5 h-3.5" /> Remove image
          </button>
        )}
      </div>
      {tooBig && <p className="text-xs text-red-400">That file is over 1 MB.</p>}
      <ErrorNote error={error} />
      {confirmRemove && (
        <ConfirmDialog title="Remove image" confirmLabel="Remove" body={<p>“{badge.name}” goes back to its icon everywhere.</p>}
          onConfirm={async () => { await admin.deleteBadgeImage(badge.id); toast({ title: 'Image removed', body: `“${badge.name}” is back to its icon.` }); onDone(); }} onClose={() => setConfirmRemove(false)} />
      )}
    </div>
  );
}

function GrantPanel({ badge, onDone }: { badge: AdminBadge; onDone: () => void }) {
  const admin = useAdminApi();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<UserRef[]>([]);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const search = useQuery({ queryKey: ['admin', 'badge-grant-search', q], queryFn: () => admin.users(q), enabled: q.trim().length >= 1 });
  const results = (search.data?.items ?? []).filter(u => !picked.some(p => p.id === u.id)).slice(0, 8);
  if (badge.status !== 'live') return <p className="text-xs text-muted-foreground">Take the badge live to grant it by hand.</p>;
  return (
    <div className="flex flex-col gap-2">
      <input className={input} placeholder="Find a player by name or @username…" value={q} onChange={e => setQ(e.target.value)} />
      {results.length > 0 && (
        <ul className="rounded-lg border border-white/10 divide-y divide-white/5">
          {results.map(u => (
            <li key={u.id}>
              <button type="button" onClick={() => { setPicked(p => [...p, u]); setQ(''); }} className="w-full text-left px-3 py-2 text-sm hover:bg-white/5">
                <span className="text-white font-semibold">{u.displayName}</span> <span className="text-username">@{u.username}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map(u => (
            <span key={u.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/20 text-primary text-xs font-bold">
              @{u.username}
              <button type="button" onClick={() => setPicked(p => p.filter(x => x.id !== u.id))} aria-label={`Remove ${u.username}`}><X className="w-3 h-3" /></button>
            </span>
          ))}
        </div>
      )}
      <input className={input} placeholder="Public note (shown on their profile, optional)" maxLength={200} value={note} onChange={e => setNote(e.target.value)} />
      <div>
        <button type="button" disabled={!picked.length} onClick={() => setConfirm(true)} className={`${btn} bg-primary text-white hover:bg-primary/90`}>
          <UserPlus className="w-3.5 h-3.5" /> Grant to {picked.length || '…'}
        </button>
      </div>
      {confirm && (
        <ConfirmDialog title="Grant badge" danger={false} confirmLabel="Grant"
          body={<p>Give “{badge.name}” to {picked.map(p => `@${p.username}`).join(', ')}? Each gets a notification.</p>}
          onConfirm={async () => {
            const r = await admin.grantBadge(badge.id, picked.map(p => p.id), note.trim());
            toast({ title: `Granted “${badge.name}”`, body: `${r.granted} ${r.granted === 1 ? 'player' : 'players'}${r.alreadyHad ? ` · ${r.alreadyHad} already had it` : ''}` });
            setPicked([]); setNote(''); onDone();
          }}
          onClose={() => setConfirm(false)} />
      )}
    </div>
  );
}

function PreviewList({ p }: { p: BadgePreview }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-white/80">
        <b className="text-white">{p.total.toLocaleString()}</b> {p.total === 1 ? 'player qualifies' : 'players qualify'} from history
        {p.newCount !== p.total && <> ({p.newCount.toLocaleString()} don’t have it yet)</>}.
        {!p.retroactive && p.kind !== 'manual' && <span className="text-amber-300"> Retroactive is off — they won’t get it at go-live; only new activity counts.</span>}
        {p.outsideWindow && <span className="text-amber-300"> The availability window isn’t open right now.</span>}
      </p>
      {p.qualifying.length > 0 && (
        <ul className="max-h-60 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
          {p.qualifying.map(q => (
            <li key={q.user.id} className="px-3 py-1.5 flex items-center justify-between gap-2">
              <UsernameLink username={q.user.username} />
              <span className="text-xs text-muted-foreground tabular-nums">
                {q.value != null && Math.round(q.value).toLocaleString()}{q.alreadyHas && ' · has it'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The {N} template that drives a draft's description: its series' template, for a metric tier. */
function templateFor(d: Pick<Draft, 'seriesId' | 'kind'>, series: AdminBadgeSeries[]): string | null {
  if (d.kind !== 'metric' || d.seriesId === '' || d.seriesId === 'new') return null;
  const t = series.find(s => String(s.id) === d.seriesId)?.descriptionTemplate;
  return t && t.includes(N_TOKEN) ? t : null;
}
/** Whether a draft's description is still the template's text for its N (or empty) — then N edits rewrite it. */
function descFollowsTemplate(d: Draft, series: AdminBadgeSeries[]): boolean {
  const t = templateFor(d, series);
  const n = draftN(d);
  return !!t && (d.description.trim() === '' || (n != null && d.description === renderTemplate(t, n)));
}

function BadgeEditor({ badge, prefill, series, allBadges, onSaved, onClose }: {
  badge: AdminBadge | null; series: AdminBadgeSeries[]; allBadges: AdminBadge[];
  /** "Add tier": a new badge prefilled from its series. */
  prefill?: NewTierDraft;
  onSaved: (b: AdminBadge, created: boolean) => void; onClose: () => void;
}) {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const metrics = useQuery({ queryKey: ['admin', 'badge-metrics'], queryFn: admin.badgeMetrics });
  const detail = useQuery({ queryKey: ['admin', 'badge', badge?.id], queryFn: () => admin.badge(badge!.id), enabled: !!badge });
  const live = detail.data?.badge ?? badge;
  const initial = (): Draft => {
    if (badge) return draftOf(badge, series);
    if (prefill) return draftOfPrefill(prefill, series);
    // A new metric badge on a metric that already has a series joins it by default.
    const s = seriesOfMetric(allBadges, EMPTY.metric, series);
    return s ? { ...EMPTY, seriesId: String(s.id), seriesName: s.name, seriesColor: s.color } : EMPTY;
  };
  const [d, setD] = useState<Draft>(initial);
  // Once the admin picks a series themself (or came from "Add tier"), changing the metric stops re-picking it.
  const [seriesTouched, setSeriesTouched] = useState(!!prefill);
  // The description follows the series template while it still reads as the template's text.
  const [descLinked, setDescLinked] = useState(() => descFollowsTemplate(initial(), series));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<BadgePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'activate' | 'retire' | 'backfill' | 'save-backfill' | { revoke: UserRef }>(null);
  useEffect(() => {
    const init = initial();
    setD(init); setSeriesTouched(!!prefill); setDescLinked(descFollowsTemplate(init, series)); setErrors({}); setError(null); setPreview(null);
  }, [badge?.id]);

  const locked = (live?.earnedCount ?? 0) > 0;
  const set = (patch: Partial<Draft>) => setD(x => ({ ...x, ...patch }));
  // Unsaved edits = what Save would send differs from what the saved badge would send (the series'
  // name/color included — they're saved with the badge).
  const seriesPatch = seriesPatchOf(d, series);
  const dirty = !!badge && !!live && (!!seriesPatch || JSON.stringify(bodyOf(d, locked)) !== JSON.stringify(bodyOf(draftOf(live, series), locked)));
  const pickedSeries = d.seriesId !== '' && d.seriesId !== 'new' ? series.find(s => String(s.id) === d.seriesId) ?? null : null;
  const inSeries = d.seriesId !== '';
  // One metric per series: what the chosen series' other metric tiers count (null = any).
  const metricLabel = (key: string) => metrics.data?.find(m => m.key === key)?.label ?? key;
  const seriesMetric = d.kind === 'metric' && pickedSeries ? seriesMetricOf(allBadges, pickedSeries.id, badge?.id) : null;
  // A tier that already disagrees (saved before the rule) isn't silently switched — it's explained.
  const metricMismatch = seriesMetric != null && d.metric !== seriesMetric;
  // Locked only when the series was chosen (an existing badge's, the admin's pick, or "Add tier") —
  // a new badge's auto-picked series follows its metric instead (pickMetric), so Metric stays free.
  const metricBySeries = seriesMetric != null && !metricMismatch && (!!badge || seriesTouched);
  /** Series this badge could join with its metric (always the chosen one, so the select keeps its value). */
  const seriesChoices = series.filter(s => {
    if (String(s.id) === d.seriesId || d.kind !== 'metric') return true;
    // In a series that sets the metric, any series may be picked — it sets the metric in turn —
    // unless the metric is frozen (players have the badge).
    if (metricBySeries && !locked) return true;
    const m = seriesMetricOf(allBadges, s.id, badge?.id);
    return m == null || m === d.metric;
  });
  const hiddenSeries = series.length - seriesChoices.length;
  /** Picking a series (or Kind → Metric inside one) sets the metric to the series' metric. */
  function withSeriesMetric(next: Draft): Partial<Draft> {
    if (locked || next.kind !== 'metric' || next.seriesId === '' || next.seriesId === 'new') return {};
    const m = seriesMetricOf(allBadges, Number(next.seriesId), badge?.id);
    return m ? { metric: m } : {};
  }
  const drawColor = inSeries ? d.seriesColor : d.color;
  // A change to N / series / kind rewrites a description that still follows the series template
  // (or is empty); a hand-written one is left alone.
  const template = templateFor(d, series);
  const linked = descLinked || d.description.trim() === '';
  function setFollowing(patch: Partial<Draft>) {
    const next = { ...d, ...patch };
    const t = templateFor(next, series), n = draftN(next);
    if (linked && t && n != null) next.description = renderTemplate(t, n);
    setD(next);
  }
  function setDescription(description: string) {
    set({ description });
    setDescLinked(descFollowsTemplate({ ...d, description }, series));
  }
  function applyTemplate() {
    const n = draftN(d);
    if (!template || n == null) return;
    set({ description: renderTemplate(template, n) });
    setDescLinked(true);
  }
  function pickSeries(v: string) {
    setSeriesTouched(true);
    const s = series.find(x => String(x.id) === v);
    const patch: Partial<Draft> = v === 'new'
      ? { seriesId: 'new', seriesName: '', seriesColor: d.color }
      : { seriesId: v, seriesName: s?.name ?? '', seriesColor: s?.color ?? d.color };
    setFollowing({ ...patch, ...withSeriesMetric({ ...d, ...patch }) });
  }
  function pickMetric(metric: string) {
    const patch: Partial<Draft> = { metric };
    if (!badge && !seriesTouched) {
      const found = seriesOfMetric(allBadges, metric, series);
      // Only a series that counts this metric (one whose tiers already disagree may go by another).
      const s = found && seriesMetricOf(allBadges, found.id) === metric ? found : null;
      Object.assign(patch, s ? { seriesId: String(s.id), seriesName: s.name, seriesColor: s.color } : { seriesId: '', seriesName: '' });
    }
    setFollowing(patch);
  }
  const isLive = live?.status === 'live';
  // Saving this turns retroactive on for a live badge → the server backfills on save.
  const saveBackfills = !!badge && !!live && isLive && live.kind !== 'manual' && d.kind !== 'manual' && !live.retroactive && d.retroactive;
  // Going live / granting can award the admin themself: the bell and the badge views move too.
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['admin'] }),
    qc.invalidateQueries({ queryKey: ['notifications'] }),
    qc.invalidateQueries({ queryKey: BADGES_KEY }),
    qc.invalidateQueries({ queryKey: ['user-badges'] }),
  ]);

  // Opening an editor (inline, possibly far down the list) brings it into view and focuses Name,
  // so it never waits silently off-screen.
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    nameRef.current?.focus({ preventScroll: true });
  }, [badge?.id]);

  /** PATCH / POST the draft. Throws (after putting field errors inline); refreshes on success. */
  async function persist(): Promise<{ badge: AdminBadge; backfill?: BadgeBackfillResult | null }> {
    setSaving(true); setErrors({}); setError(null);
    try {
      const body = bodyOf(d, locked);
      // The series' own name/color first (it recolors every tier), then the badge.
      if (seriesPatch) await admin.updateBadgeSeries(seriesPatch.id, seriesPatch.body);
      const r = badge ? await admin.updateBadge(badge.id, body) : await admin.createBadge(body);
      await refresh();
      return r;
    } catch (e: any) {
      setErrors(e?.body?.errors ?? {});
      setError(e);
      throw e;
    } finally { setSaving(false); }
  }
  async function saveAndClose() {
    const r = await persist();
    if (r.backfill) backfillToast(r.badge.name, r.backfill);
    else toast(badge
      ? { title: 'Saved', body: `“${r.badge.name}”` }
      : { title: 'Draft created', body: `“${r.badge.name}” — preview it, add art, then take it live.` });
    onSaved(r.badge, !badge);
  }
  function save() {
    // Turning retroactive on for a live badge awards people on save — confirm first.
    if (saveBackfills) setConfirm('save-backfill');
    else saveAndClose().catch(() => { /* shown inline */ });
  }
  async function runPreview() {
    if (!badge) return;
    setPreviewing(true); setError(null);
    try { setPreview(await admin.previewBadge(badge.id)); } catch (e) { setError(e); } finally { setPreviewing(false); }
  }

  const Icon = BADGE_ICONS[d.icon] ? d.icon : 'award';
  const faceForPreview = { id: live?.id ?? 0, name: d.name || 'New badge', icon: Icon, color: drawColor, imageVersion: live?.imageVersion ?? null };

  return (
    <div ref={rootRef} className="scroll-mt-24">
    <Card className="p-4 sm:p-5 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <BadgeImage badge={faceForPreview} size={48} />
          <div className="min-w-0">
            <h2 className="text-base font-black uppercase tracking-widest text-white [overflow-wrap:anywhere]">{badge ? d.name || badge.name : prefill ? `New tier · ${d.seriesName}` : 'New badge'}</h2>
            {live && <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-2"><Pill tone={STATUS_TONE[live.status]}>{live.status}</Pill>{live.earnedCount.toLocaleString()} earned{live.activatedAt && <> · live since <When at={live.activatedAt} /></>}</p>}
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-white" aria-label="Close editor"><X className="w-5 h-5" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" error={errors.name}><input ref={nameRef} className={input} maxLength={60} value={d.name} onChange={e => set({ name: e.target.value })} /></Field>
        <Field label="Key (permanent slug)" error={errors.key} hint={locked ? 'Frozen — players have this badge' : 'e.g. holiday-champion-2026'}>
          <input className={input} disabled={locked} value={d.key} onChange={e => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
        </Field>
        <Field label="Description" error={errors.description}
          hint={template ? (linked
            ? <>Follows the series wording “{template}” — changing N updates it; edit it to write your own.</>
            : <>Your own wording.{draftN(d) != null && <> <button type="button" onClick={applyTemplate} className="underline hover:text-white">Use the series wording</button></>}</>)
            : undefined}>
          <textarea className={input} rows={2} maxLength={300} value={d.description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <div className={`grid gap-3 items-start ${inSeries ? 'grid-cols-1' : 'grid-cols-[1fr_auto]'}`}>
          <Field group label="Icon (when no image)" error={errors.icon}>
            <IconPicker value={d.icon} color={drawColor} onChange={icon => set({ icon })} />
          </Field>
          {!inSeries && (
            <Field label="Color" error={errors.color}>
              <input type="color" className="h-[38px] w-12 rounded border border-white/20 bg-transparent" value={d.color} onChange={e => set({ color: e.target.value })} />
            </Field>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-start rounded-xl border border-white/10 p-3">
        <Field label="Series" error={errors.seriesId} hint={inSeries
          ? (d.kind === 'metric' ? 'Placed in the ladder by its N' : 'Joins the end of the ladder — drag it in the list to move it')
          : `A single badge — placed in the list by drag or the move buttons${hiddenSeries > 0 ? ` · ${hiddenSeries} ${hiddenSeries === 1 ? 'series counts' : 'series count'} another metric` : ''}`}>
          <select className={input} value={d.seriesId} onChange={e => pickSeries(e.target.value)}>
            <option value="">None — a single badge</option>
            {seriesChoices.map(s => <option key={s.id} value={s.id}>{s.name} ({s.badgeCount} {s.badgeCount === 1 ? 'tier' : 'tiers'})</option>)}
            <option value="new">New series…</option>
          </select>
        </Field>
        {inSeries && (
          <>
            <Field label={d.seriesId === 'new' ? 'New series name' : 'Series name'} error={errors.seriesName}>
              <input className={input} maxLength={60} value={d.seriesName} placeholder="e.g. Scores" onChange={e => set({ seriesName: e.target.value })} />
            </Field>
            <Field label="Series color" error={errors.seriesColor}
              hint={pickedSeries ? `All ${pickedSeries.badgeCount} ${pickedSeries.badgeCount === 1 ? 'tier' : 'tiers'}` : 'Every tier'}>
              <input type="color" className="h-[38px] w-12 rounded border border-white/20 bg-transparent" value={d.seriesColor} onChange={e => set({ seriesColor: e.target.value })} />
            </Field>
          </>
        )}
        {pickedSeries && seriesPatch?.body.color && (
          <p className="sm:col-span-3 text-[11px] text-amber-300">Saving recolors every tier of “{pickedSeries.name}”.</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Kind</span>
          {locked ? <Pill>{d.kind}</Pill> : (
            <Segmented<BadgeKind> value={d.kind} onChange={k => setFollowing({ kind: k, ...withSeriesMetric({ ...d, kind: k }) })} options={[
              { value: 'metric', label: 'Metric' }, { value: 'rule', label: 'Rule' }, { value: 'manual', label: 'Manual' },
            ]} />
          )}
        </div>
        {d.kind === 'metric' && (
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-3">
            <Field label="Metric" error={errors.metric} hint={metricMismatch && pickedSeries
              ? <span className="text-amber-300">All tiers in {pickedSeries.name} count {metricLabel(seriesMetric!)} — this one counts {metricLabel(d.metric)}. {locked
                ? 'Its metric is frozen (players have it), so move it out of the series.'
                : <>Change it to {metricLabel(seriesMetric!)}, or move it out of the series.</>}</span>
              : metricBySeries && pickedSeries
                ? <>All tiers in {pickedSeries.name} count {metricLabel(seriesMetric!)}.</>
                : metrics.data?.find(m => m.key === d.metric)?.description}>
              <select className={input} disabled={locked || metricBySeries} value={d.metric} onChange={e => pickMetric(e.target.value)}>
                {(metrics.data ?? []).map(m => <option key={m.key} value={m.key}>{m.label}{m.available ? '' : ' — not built yet'}</option>)}
              </select>
            </Field>
            <Field label="At least (N)" error={errors.threshold}
              hint={prefill && !badge && prefill.threshold != null && prefill.basedOn.length > 0
                ? `Suggested: the next step after ${prefill.basedOn.map(n => n.toLocaleString('en-US')).join(' → ')}`
                : undefined}>
              <input type="number" min={1} className={input} value={d.threshold} onChange={e => setFollowing({ threshold: e.target.value })} />
            </Field>
          </div>
        )}
        {d.kind === 'rule' && <RuleBuilder rule={d.rule} onChange={rule => set({ rule })} error={errors.rule} />}
        {d.kind === 'manual' && <p className="text-xs text-muted-foreground">No rule — grant it by hand once it’s live.</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
        <Field label="Earnable from (optional)" error={errors.availableFrom}><input type="datetime-local" className={input} value={d.availableFrom} onChange={e => set({ availableFrom: e.target.value })} /></Field>
        <Field label="Earnable until (optional)" error={errors.availableTo}><input type="datetime-local" className={input} value={d.availableTo} onChange={e => set({ availableTo: e.target.value })} /></Field>
        {d.kind !== 'manual' && (
          <label className="flex items-center gap-2 text-sm text-white/80 pb-2">
            <input type="checkbox" checked={d.retroactive} onChange={e => set({ retroactive: e.target.checked })} />
            {isLive ? 'Retroactive (award from history)' : 'Retroactive (award from history at go-live)'}
          </label>
        )}
      </div>
      {saveBackfills && <p className="text-xs text-amber-300 -mt-3">This badge is live: saving awards it now to everyone who already qualifies, each with a notification.</p>}
      {isLive && live?.retroactive && !d.retroactive && d.kind !== 'manual' && (
        <p className="text-xs text-muted-foreground -mt-3">Turning Retroactive off takes the badge from nobody. From now on only new activity counts{d.kind === 'rule' ? ' (scores posted after it went live)' : ''}.</p>
      )}

      {live?.activationBlocker && <p className="text-xs text-amber-300">Can’t go live yet: {live.activationBlocker}</p>}
      <ErrorNote error={error} />

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={saving} className={`${btn} bg-primary text-white hover:bg-primary/90`}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{badge ? 'Save changes' : 'Create draft'}
        </button>
        {badge && live && (
          <>
            {live.kind !== 'manual' && (
              <button type="button" onClick={runPreview} disabled={previewing || dirty} title={dirty ? 'Save changes first' : undefined} className={`${btn} border border-white/15 text-white/80 hover:text-white`}>
                {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Preview
              </button>
            )}
            {live.status !== 'live' && (
              <button type="button" onClick={() => setConfirm('activate')} disabled={!!live.activationBlocker || saving} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}>
                <Rocket className="w-3.5 h-3.5" /> {dirty ? 'Save & go live' : 'Go live'}
              </button>
            )}
            {isLive && live.retroactive && live.kind !== 'manual' && (
              <button type="button" onClick={() => setConfirm('backfill')} disabled={dirty} title={dirty ? 'Save changes first' : undefined} className={`${btn} border border-emerald-500/40 text-emerald-300 hover:text-emerald-200`}>
                <History className="w-3.5 h-3.5" /> Backfill now
              </button>
            )}
            {live.status === 'live' && (
              <button type="button" onClick={() => setConfirm('retire')} className={`${btn} border border-amber-500/40 text-amber-300 hover:text-amber-200`}>
                <Archive className="w-3.5 h-3.5" /> Retire
              </button>
            )}
          </>
        )}
      </div>
      {dirty && (
        <p className="text-[11px] text-amber-300 -mt-3">
          Unsaved changes — Preview{isLive && live?.retroactive ? ' and Backfill now use' : ' uses'} the saved badge, so save first.
          {!isLive && ' Save & go live saves them, then takes the saved badge live.'}
        </p>
      )}
      {preview && <PreviewList p={preview} />}

      {badge && live && (
        <>
          <div>
            <SectionTitle>Image</SectionTitle>
            <ImagePanel badge={live} onDone={refresh} />
          </div>
          <div>
            <SectionTitle>Grant by hand</SectionTitle>
            <GrantPanel badge={live} onDone={refresh} />
          </div>
          <div>
            <SectionTitle>Holders · {live.earnedCount.toLocaleString()}</SectionTitle>
            {detail.data?.holders.length ? (
              <ul className="rounded-lg border border-white/10 divide-y divide-white/5 max-h-80 overflow-y-auto">
                {detail.data.holders.map(h => (
                  <li key={h.user.id} className="px-3 py-2 flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      <UsernameLink username={h.user.username} />
                      <span className="text-xs text-muted-foreground"> · <When at={h.earnedAt} />{h.grantedBy && <> · granted by <Who user={h.grantedBy} /></>}{h.note && <> · “{h.note}”</>}</span>
                    </span>
                    <button type="button" onClick={() => setConfirm({ revoke: h.user })} className="text-[11px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 flex-shrink-0">Revoke</button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-muted-foreground">Nobody yet.</p>}
          </div>
        </>
      )}

      {confirm === 'activate' && live && (
        // With unsaved edits this saves first and activates the SAVED badge; the dialog describes
        // the draft, since that's what gets saved.
        <ConfirmDialog title={dirty ? 'Save & go live' : 'Go live'} danger={false} confirmLabel={dirty ? 'Save & go live' : 'Go live'}
          body={<>
            {dirty && <p><b>Your unsaved changes are saved first</b>, then the saved badge goes live.</p>}
            <p>“{dirty ? d.name || live.name : live.name}” becomes earnable and shows in the public catalog.</p>
            {(dirty ? d.kind : live.kind) !== 'manual' && ((dirty ? d.retroactive : live.retroactive)
              ? <p><b>Retroactive is on:</b> everyone who already qualifies gets it now, each with a notification{dirty ? '' : preview ? ` (${preview.newCount.toLocaleString()} from the last preview)` : ' — run Preview first to see who'}.</p>
              : <p>Retroactive is off: only activity from now on counts.</p>)}
          </>}
          onConfirm={async () => {
            const saved = dirty ? (await persist()).badge : live;
            const r = await admin.activateBadge(saved.id);
            await refresh();
            setPreview(null);
            toast(r.skippedWindow
              ? { tone: 'info', title: `“${saved.name}” is live`, body: 'The availability window is shut, so nobody was backfilled.' }
              : { title: `“${saved.name}” is live`, body: saved.kind === 'manual' ? 'Grant it by hand below.' : saved.retroactive ? `Awarded to ${players(r.awarded)} from history.` : 'Only activity from now on counts.' });
          }}
          onClose={() => setConfirm(null)} />
      )}
      {confirm === 'save-backfill' && live && (
        <ConfirmDialog title="Save & backfill" danger={false} confirmLabel="Save & backfill"
          body={<>
            <p>“{d.name || live.name}” is live and you’ve turned <b>Retroactive</b> on.</p>
            <p>Saving awards it now to everyone who already qualifies from history and doesn’t have it yet, each with a notification.</p>
          </>}
          onConfirm={() => saveAndClose()}
          onClose={() => setConfirm(null)} />
      )}
      {confirm === 'backfill' && live && (
        <ConfirmDialog title="Backfill now" danger={false} confirmLabel="Backfill"
          body={<>
            <p>Award “{live.name}” to everyone who qualifies from history and doesn’t have it yet, each with a notification.</p>
            <p>Players who already have it are skipped — nobody is awarded or notified twice.{preview ? ` The last preview found ${preview.newCount.toLocaleString()} without it.` : ''}</p>
          </>}
          onConfirm={async () => {
            const r = await admin.backfillBadge(live.id);
            await refresh();
            setPreview(null);
            toast(r.skippedWindow
              ? { tone: 'info', title: 'Nothing backfilled', body: `The availability window for “${live.name}” is shut.` }
              : { title: `Backfilled “${live.name}”`, body: r.awarded ? `${players(r.awarded)} awarded.` : 'Everyone who qualifies already has it.' });
          }}
          onClose={() => setConfirm(null)} />
      )}
      {confirm === 'retire' && live && (
        <ConfirmDialog title="Retire badge" confirmLabel="Retire"
          body={<p>“{live.name}” stops being awarded and leaves the catalog. The {live.earnedCount.toLocaleString()} players who have it keep it.</p>}
          onConfirm={async () => { await admin.retireBadge(live.id); await refresh(); toast({ title: `“${live.name}” retired`, body: 'Holders keep it; nobody new can earn it.' }); }}
          onClose={() => setConfirm(null)} />
      )}
      {confirm && typeof confirm === 'object' && live && (
        <ConfirmDialog title="Revoke badge" confirmLabel="Revoke" reason="Reason (kept in the activity log)"
          body={<p>Take “{live.name}” away from @{confirm.revoke.username}? Nothing is revoked automatically — this is the only way.</p>}
          onConfirm={async reason => { await admin.revokeBadge(live.id, confirm.revoke.id, reason); await refresh(); toast({ title: 'Badge revoked', body: `@${confirm.revoke.username} no longer has “${live.name}”.` }); }}
          onClose={() => setConfirm(null)} />
      )}
    </Card>
    </div>
  );
}

type Group =
  | { type: 'badge'; key: string; badge: AdminBadge }
  | { type: 'series'; key: string; series: AdminBadgeSeries; tiers: AdminBadge[] };

const keyOf = (it: BadgeOrderItem) => `${it.type}:${it.id}`;

/** An inline editor for a series header: rename, recolor (every tier), delete when empty. */
function SeriesEditor({ series, onClose }: { series: AdminBadgeSeries; onClose: () => void }) {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const [name, setName] = useState(series.name);
  const [color, setColor] = useState(series.color);
  const [template, setTemplate] = useState(series.descriptionTemplate ?? '');
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['admin'] }), qc.invalidateQueries({ queryKey: BADGES_KEY }), qc.invalidateQueries({ queryKey: ['user-badges'] }),
  ]);
  const tpl = template.trim();
  const changed = name.trim() !== series.name || color.toLowerCase() !== series.color || (tpl || null) !== series.descriptionTemplate;
  const tplMissingN = tpl !== '' && !tpl.includes(N_TOKEN);
  async function save() {
    setBusy(true); setError(null); setErrors({});
    try {
      await admin.updateBadgeSeries(series.id, { name: name.trim(), color: color.toLowerCase(), descriptionTemplate: tpl || null });
      await refresh();
      toast({ title: 'Series saved', body: `“${name.trim()}”${color.toLowerCase() !== series.color ? ' — every tier recolored' : ''}` });
      setErrors({});
      onClose();
    } catch (e: any) { setErrors(e?.body?.errors ?? {}); setError(e); } finally { setBusy(false); }
  }
  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>Series</SectionTitle>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-white" aria-label="Close series editor"><X className="w-5 h-5" /></button>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
        <Field label="Name" error={errors.name}><input className={input} maxLength={60} value={name} onChange={e => setName(e.target.value)} /></Field>
        <Field label="Color" hint="Every tier" error={errors.color}><input type="color" className="h-[38px] w-12 rounded border border-white/20 bg-transparent" value={color} onChange={e => setColor(e.target.value)} /></Field>
      </div>
      <Field label="Tier description" error={errors.descriptionTemplate ?? (tplMissingN ? `Put ${N_TOKEN} where the tier’s number goes` : undefined)}
        hint={tpl
          ? <>Add tier writes e.g. “{renderTemplate(tpl, 1000)}”; a tier whose description still matches follows its N. Existing descriptions aren’t changed.</>
          : <>Optional. Use {N_TOKEN} for the tier’s number, e.g. “Posted {N_TOKEN} scores.” Without it, Add tier copies the top tier’s description.</>}>
        <input className={input} maxLength={300} value={template} placeholder={`e.g. Posted ${N_TOKEN} scores.`} onChange={e => setTemplate(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={busy || !changed || !name.trim() || tplMissingN} className={`${btn} bg-primary text-white hover:bg-primary/90`}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Save series
        </button>
        <button type="button" onClick={() => setConfirmDelete(true)} disabled={series.badgeCount > 0}
          title={series.badgeCount > 0 ? 'Move its badges out first' : undefined}
          className={`${btn} border border-white/15 text-muted-foreground hover:text-white`}>
          <Trash2 className="w-3.5 h-3.5" /> Delete series
        </button>
      </div>
      {series.badgeCount > 0 && <p className="text-[11px] text-muted-foreground -mt-1">A series can be deleted once it has no badges — set each tier’s Series to None (or another series) first.</p>}
      {confirmDelete && (
        <ConfirmDialog title="Delete series" confirmLabel="Delete" body={<p>Delete the empty series “{series.name}”?</p>}
          onConfirm={async () => { await admin.deleteBadgeSeries(series.id); await refresh(); toast({ title: 'Series deleted', body: `“${series.name}”` }); onClose(); }}
          onClose={() => setConfirmDelete(false)} />
      )}
    </Card>
  );
}

function BadgeListRow({ b, current, indent = false, onClick }: { b: AdminBadge; current: boolean; indent?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-expanded={current} onClick={onClick}
      className={`w-full text-left py-3 flex items-center gap-3 hover:bg-white/[0.03] ${indent ? 'pl-1 pr-2' : 'px-2'} ${current ? 'bg-white/[0.05]' : ''}`}>
      <BadgeImage badge={b} size={indent ? 32 : 40} locked={b.status !== 'live'} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold text-white [overflow-wrap:anywhere]">{b.name}</span>
          <Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill>
          <span className="text-[11px] text-muted-foreground">{b.kind}</span>
          {!b.metricAvailable && <Pill tone="warn">metric not built</Pill>}
        </span>
        <span className="block text-xs text-muted-foreground truncate">{b.requirement}</span>
      </span>
      <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">{b.earnedCount.toLocaleString()}</span>
    </button>
  );
}

/** What the editor is open on: a saved badge, a blank new one, or a new tier from "Add tier". */
type Editing = AdminBadge | 'new' | { prefill: NewTierDraft; n: number };
const prefillOf = (e: Editing | null) => (e && e !== 'new' && 'prefill' in e ? e : null);

const arrowBtn = 'p-0.5 rounded text-muted-foreground hover:text-white disabled:opacity-25 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export default function AdminBadgesPage() {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'badges'], queryFn: admin.badges });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editingSeries, setEditingSeries] = useState<number | null>(null);
  const [status, setStatus] = useState<'all' | 'draft' | 'live' | 'retired'>('all');
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  // Dragging a rule/manual tier inside its series (separate from the top-level drag).
  const [tierDrag, setTierDrag] = useState<{ seriesId: number; id: number } | null>(null);
  const [tierArmed, setTierArmed] = useState<number | null>(null);
  const [tierOver, setTierOver] = useState<{ seriesId: number; idx: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingTier, setAddingTier] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const all = q.data?.items ?? [];
  const series = q.data?.series ?? [];
  const order = q.data?.order ?? [];
  const byId = new Map(all.map(b => [b.id, b]));
  const seriesById = new Map(series.map(s => [s.id, s]));
  const matches = (b: AdminBadge) => status === 'all' || b.status === status;
  // The top-level rows in the shared order; a series row carries its tiers (already in tier order).
  const groups: Group[] = order.flatMap((it): Group[] => {
    if (it.type === 'badge') { const b = byId.get(it.id); return b ? [{ type: 'badge', key: keyOf(it), badge: b }] : []; }
    const s = seriesById.get(it.id);
    return s ? [{ type: 'series', key: keyOf(it), series: s, tiers: all.filter(b => b.seriesId === s.id) }] : [];
  });
  const visible = groups.filter(g => g.type === 'badge' ? matches(g.badge) : status === 'all' || g.tiers.some(matches));
  const canReorder = status === 'all' && !saving;
  const prefill = prefillOf(editing);
  // Keep the open editor pointed at the refreshed row after saves.
  const saved = editing && editing !== 'new' && !prefill ? editing as AdminBadge : null;
  const current = saved ? all.find(b => b.id === saved.id) ?? saved : null;
  const inlineId = current && all.some(b => b.id === current.id && matches(b)) ? current.id : null;
  // A new tier's editor opens under its series (when that series is on screen).
  const prefillInline = prefill != null && visible.some(g => g.type === 'series' && g.series.id === prefill.prefill.seriesId);
  const editor = editing && (
    <BadgeEditor key={editing === 'new' ? 'new' : prefill ? `tier-${prefill.prefill.seriesId}-${prefill.n}` : current!.id}
      badge={editing === 'new' || prefill ? null : current} prefill={prefill?.prefill} series={series} allBadges={all}
      onSaved={(b, created) => setEditing(created ? b : null)} onClose={() => setEditing(null)} />
  );

  const refreshOrder = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'badges'] }), qc.invalidateQueries({ queryKey: BADGES_KEY }), qc.invalidateQueries({ queryKey: ['user-badges'] })]);
  const label = (g: Group) => (g.type === 'badge' ? g.badge.name : `the ${g.series.name} series`);
  /** Move the top-level row at `from` to `to` and save the whole order (optimistically). */
  async function move(from: number, to: number) {
    if (!q.data || from === to || to < 0 || to >= groups.length) return;
    const next = groups.map(g => (g.type === 'badge' ? { type: 'badge' as const, id: g.badge.id } : { type: 'series' as const, id: g.series.id }));
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    const prev = q.data;
    qc.setQueryData(['admin', 'badges'], { ...prev, order: next });
    setAnnounce(`Moved ${label(groups[from])} to position ${to + 1} of ${groups.length}`);
    setSaving(true);
    try {
      await admin.reorderBadges(next);
      await refreshOrder();
    } catch (e: any) {
      qc.setQueryData(['admin', 'badges'], prev);
      await qc.invalidateQueries({ queryKey: ['admin', 'badges'] });
      toast({ tone: 'error', title: 'Couldn’t save the order', body: e?.message ?? 'Try again.' });
    } finally { setSaving(false); }
  }
  function drop(to: number) {
    const from = groups.findIndex(g => g.key === dragKey);
    setDragKey(null); setOverIdx(null); setArmedKey(null);
    if (from >= 0) void move(from, to > from ? to - 1 : to);
  }

  /**
   * Move a tier inside its series (only rule/manual tiers have controls, so tiers with a threshold
   * keep their N order) and save the series' whole tier order (optimistically).
   */
  async function moveTier(s: AdminBadgeSeries, tiers: AdminBadge[], from: number, to: number) {
    if (!q.data || from === to || to < 0 || to >= tiers.length) return;
    const ids = tiers.map(t => t.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    const prev = q.data;
    const reordered = ids.map(x => byId.get(x)!);
    let k = 0;
    qc.setQueryData(['admin', 'badges'], { ...prev, items: prev.items.map(b => (b.seriesId === s.id ? reordered[k++] : b)) });
    setAnnounce(`Moved ${tiers[from].name} to tier ${to + 1} of ${tiers.length} in ${s.name}`);
    setSaving(true);
    try {
      await admin.reorderSeriesTiers(s.id, ids);
      await refreshOrder();
    } catch (e: any) {
      qc.setQueryData(['admin', 'badges'], prev);
      await qc.invalidateQueries({ queryKey: ['admin', 'badges'] });
      toast({ tone: 'error', title: 'Couldn’t save the tier order', body: e?.message ?? 'Try again.' });
    } finally { setSaving(false); }
  }
  function dropTier(s: AdminBadgeSeries, tiers: AdminBadge[], to: number) {
    const from = tierDrag?.seriesId === s.id ? tiers.findIndex(t => t.id === tierDrag.id) : -1;
    setTierDrag(null); setTierOver(null); setTierArmed(null);
    if (from >= 0) void moveTier(s, tiers, from, to > from ? to - 1 : to);
  }

  async function addTier(s: AdminBadgeSeries) {
    setAddingTier(s.id);
    try {
      const { draft } = await admin.newTierDraft(s.id);
      setEditing({ prefill: draft, n: Date.now() });
    } catch (e: any) {
      toast({ tone: 'error', title: 'Couldn’t start a new tier', body: e?.message ?? 'Try again.' });
    } finally { setAddingTier(null); }
  }

  const moveButtons = (g: Group, i: number) => (
    <span className="flex flex-col flex-shrink-0">
      <button type="button" disabled={!canReorder || i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${label(g)} up`} className={arrowBtn}><ChevronUp className="w-4 h-4" /></button>
      <button type="button" disabled={!canReorder || i === groups.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${label(g)} down`} className={arrowBtn}><ChevronDown className="w-4 h-4" /></button>
    </span>
  );
  const handle = (g: Group) => (
    <span aria-hidden title={canReorder ? 'Drag to reorder' : undefined}
      onPointerDown={() => canReorder && setArmedKey(g.key)} onPointerUp={() => setArmedKey(null)}
      className={`hidden sm:flex items-center self-stretch px-1 flex-shrink-0 ${canReorder ? 'cursor-grab text-muted-foreground hover:text-white' : 'text-white/15'}`}>
      <GripVertical className="w-4 h-4" />
    </span>
  );

  /** A series' tier rows: N-tiers fixed (placed by their threshold), rule/manual tiers draggable + ▲/▼. */
  function tierList(s: AdminBadgeSeries, allTiers: AdminBadge[]) {
    const shown = allTiers.filter(matches);
    if (!shown.length) return <p className="pl-12 pb-2 pt-1 text-xs text-muted-foreground">No badges in this series.</p>;
    return (
      <ol className="border-t border-white/5 divide-y divide-white/5" aria-label={`${s.name} tiers`} style={{ borderLeft: `3px solid ${s.color}55` }}>
        {shown.map(b => {
          const ti = allTiers.indexOf(b);
          const fixed = hasThreshold(b);
          const odd = s.metricConflict?.offenders.find(o => o.id === b.id);
          const dragging = tierDrag?.seriesId === s.id;
          const tierDropProps = {
            draggable: canReorder && !fixed && tierArmed === b.id,
            onDragStart: (e: React.DragEvent) => {
              e.stopPropagation();
              setTierDrag({ seriesId: s.id, id: b.id }); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', `tier:${b.id}`);
            },
            onDragEnd: (e: React.DragEvent) => { e.stopPropagation(); setTierDrag(null); setTierOver(null); setTierArmed(null); },
            onDragOver: (e: React.DragEvent) => {
              if (!dragging) return;
              e.preventDefault(); e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setTierOver({ seriesId: s.id, idx: e.clientY < r.top + r.height / 2 ? ti : ti + 1 });
            },
            onDrop: (e: React.DragEvent) => {
              if (!dragging) return;
              e.preventDefault(); e.stopPropagation();
              if (tierOver?.seriesId === s.id) dropTier(s, allTiers, tierOver.idx);
            },
          };
          const over = dragging && tierOver?.seriesId === s.id;
          const line = over && tierOver!.idx === ti ? 'shadow-[inset_0_2px_0_0_hsl(var(--primary))]'
            : over && tierOver!.idx === ti + 1 && ti === allTiers.length - 1 ? 'shadow-[inset_0_-2px_0_0_hsl(var(--primary))]' : '';
          return (
            <li key={b.id} {...tierDropProps} className={`${line} ${tierDrag?.id === b.id ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-1 pl-4 pr-2">
                {fixed ? (
                  // Same width as the handle + arrows, so every tier's image lines up.
                  <span className="w-5 sm:w-11 flex-shrink-0" title="Placed by its threshold (N)" />
                ) : (
                  <>
                    <span aria-hidden title={canReorder ? 'Drag to place this tier in the ladder' : undefined}
                      onPointerDown={() => canReorder && setTierArmed(b.id)} onPointerUp={() => setTierArmed(null)}
                      className={`hidden sm:flex items-center self-stretch px-1 flex-shrink-0 ${canReorder ? 'cursor-grab text-muted-foreground hover:text-white' : 'text-white/15'}`}>
                      <GripVertical className="w-4 h-4" />
                    </span>
                    <span className="flex flex-col flex-shrink-0">
                      <button type="button" disabled={!canReorder || ti === 0} onClick={() => moveTier(s, allTiers, ti, ti - 1)} aria-label={`Move ${b.name} up in ${s.name}`} className={arrowBtn}><ChevronUp className="w-4 h-4" /></button>
                      <button type="button" disabled={!canReorder || ti === allTiers.length - 1} onClick={() => moveTier(s, allTiers, ti, ti + 1)} aria-label={`Move ${b.name} down in ${s.name}`} className={arrowBtn}><ChevronDown className="w-4 h-4" /></button>
                    </span>
                  </>
                )}
                <div className="flex-1 min-w-0"><BadgeListRow b={b} indent current={current?.id === b.id} onClick={() => setEditing(inlineId === b.id ? null : b)} /></div>
              </div>
              {odd && <p className="pl-16 pr-3 pb-2 -mt-1 text-[11px] text-amber-300">Counts {odd.label} — the rest of {s.name} counts {s.metricConflict!.seriesMetricLabel}. Change its metric or move it out of the series.</p>}
              {inlineId === b.id && <div className="px-2 pb-3 sm:px-3 bg-black/20">{editor}</div>}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <AdminShell>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Segmented value={status} onChange={setStatus} options={[
          { value: 'all', label: 'All' }, { value: 'draft', label: 'Draft' }, { value: 'live', label: 'Live' }, { value: 'retired', label: 'Retired' },
        ]} />
        <button type="button" onClick={() => setEditing('new')} className={`${btn} bg-primary text-white hover:bg-primary/90`}>
          <Plus className="w-3.5 h-3.5" /> New badge
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        This is the order of the profile shelf and the /badges catalog. {status === 'all'
          ? 'Drag a row by its handle or use the arrows; a series moves as a unit.'
          : 'Switch to All to reorder.'}
      </p>
      <p className="sr-only" aria-live="polite">{announce}</p>
      {editing && inlineId == null && !prefillInline && <div className="mb-6">{editor}</div>}
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : visible.length === 0 ? <p className="text-sm text-muted-foreground">No badges.</p> : (
        <Card>
          {/* No overflow-hidden: the inline editor's icon picker and machine dropdown must overhang. */}
          <ul className="divide-y divide-white/5" onDragOver={e => { if (dragKey) e.preventDefault(); }}>
            {visible.map(g => {
              const i = groups.indexOf(g);
              const dropProps = {
                draggable: canReorder && armedKey === g.key,
                onDragStart: (e: React.DragEvent) => { setDragKey(g.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', g.key); },
                onDragEnd: () => { setDragKey(null); setOverIdx(null); setArmedKey(null); },
                onDragOver: (e: React.DragEvent) => {
                  if (!dragKey) return;
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setOverIdx(e.clientY < r.top + r.height / 2 ? i : i + 1);
                },
                onDrop: (e: React.DragEvent) => { if (!dragKey) return; e.preventDefault(); if (overIdx != null) drop(overIdx); },
              };
              const line = dragKey && overIdx === i ? 'shadow-[inset_0_2px_0_0_hsl(var(--primary))]' : dragKey && overIdx === i + 1 && i === groups.length - 1 ? 'shadow-[inset_0_-2px_0_0_hsl(var(--primary))]' : '';
              if (g.type === 'badge') {
                const b = g.badge;
                return (
                  <li key={g.key} {...dropProps} className={`${line} ${dragKey === g.key ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-1 pl-1 pr-2">
                      {handle(g)}
                      {moveButtons(g, i)}
                      <div className="flex-1 min-w-0"><BadgeListRow b={b} current={current?.id === b.id} onClick={() => setEditing(inlineId === b.id ? null : b)} /></div>
                    </div>
                    {inlineId === b.id && <div className="px-2 pb-3 sm:px-3 bg-black/20">{editor}</div>}
                  </li>
                );
              }
              const s = g.series;
              const tplHint = s.descriptionTemplate ? ` · “${s.descriptionTemplate}”` : '';
              return (
                <li key={g.key} {...dropProps} className={`${line} ${dragKey === g.key ? 'opacity-50' : ''}`}>
                  <div className="flex items-center gap-1 pl-1 pr-2">
                    {handle(g)}
                    {moveButtons(g, i)}
                    <button type="button" aria-expanded={editingSeries === s.id} onClick={() => setEditingSeries(editingSeries === s.id ? null : s.id)}
                      className="flex-1 min-w-0 text-left px-2 py-3 flex items-center gap-3 hover:bg-white/[0.03]">
                      <span className="inline-flex items-center justify-center w-10 h-10 rounded-full border-2 flex-shrink-0" style={{ color: s.color, backgroundColor: `${s.color}26`, borderColor: `${s.color}80` }}>
                        <Layers className="w-5 h-5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-black uppercase tracking-widest [overflow-wrap:anywhere]" style={{ color: s.color }}>{s.name}</span>
                        <span className="block text-xs text-muted-foreground truncate">Series · {s.badgeCount} {s.badgeCount === 1 ? 'tier' : 'tiers'}{tplHint} · edit name, color or wording</span>
                      </span>
                    </button>
                  </div>
                  {s.metricConflict && (
                    <p role="note" className="flex items-start gap-1.5 pl-12 pr-3 pb-2 text-[11px] text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden />
                      <span>{s.metricConflict.message}</span>
                    </p>
                  )}
                  {editingSeries === s.id && <div className="px-2 pb-3 sm:px-3 bg-black/20"><SeriesEditor series={s} onClose={() => setEditingSeries(null)} /></div>}
                  {tierList(s, g.tiers)}
                  {prefillInline && prefill!.prefill.seriesId === s.id && <div className="px-2 pb-3 pt-2 sm:px-3 bg-black/20">{editor}</div>}
                  <div className="flex flex-wrap items-center justify-between gap-2 pl-12 pr-3 py-2 border-t border-white/5" style={{ borderLeft: `3px solid ${s.color}55` }}>
                    <p className="text-[11px] text-muted-foreground">Tiers with a threshold sort by N; drag rule/manual tiers anywhere in the ladder.</p>
                    <button type="button" onClick={() => addTier(s)} disabled={addingTier === s.id}
                      className={`${btn} border border-white/15 text-white/80 hover:text-white`}>
                      {addingTier === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add tier
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </AdminShell>
  );
}
