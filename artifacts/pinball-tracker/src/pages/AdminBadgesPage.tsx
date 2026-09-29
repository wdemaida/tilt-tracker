import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload, Trash2, Eye, Rocket, Archive, Loader2, UserPlus, X } from 'lucide-react';
import { useAdminApi, type AdminBadge, type BadgeInput, type BadgeKind, type BadgeRule, type BadgePreview, type UserRef } from '../lib/adminApi';
import { useApi } from '../lib/useApi';
import { toLocalInput, localInputToIso } from '../lib/datetime';
import { AdminShell, Card, Pill, SectionTitle, ErrorNote, ConfirmDialog, When, Who, Segmented } from '../components/admin/AdminParts';
import BadgeImage, { BADGE_ICONS } from '../components/BadgeImage';
import UsernameLink from '../components/UsernameLink';

// /admin/badges — create and edit badges (metric / rule / manual), upload artwork, preview who
// qualifies, go live (with retroactive backfill when that's on), retire, and grant/revoke by hand.
// Everything goes through ConfirmDialog and invalidates every ['admin', …] query afterwards. The
// server is the authority on validation (routes/adminBadges.ts) — its per-field errors show inline.

const STATUS_TONE = { draft: 'muted', live: 'ok', retired: 'warn' } as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const input = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full';
const btn = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider disabled:opacity-50 transition-colors';

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
      {hint && !error && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </label>
  );
}

interface Draft {
  key: string; name: string; description: string; icon: string; color: string; kind: BadgeKind;
  metric: string; threshold: string; rule: BadgeRule; retroactive: boolean;
  availableFrom: string; availableTo: string; sortOrder: string;
}

const EMPTY: Draft = {
  key: '', name: '', description: '', icon: 'award', color: '#f59e0b', kind: 'metric', metric: 'scores_posted', threshold: '10',
  rule: {}, retroactive: false, availableFrom: '', availableTo: '', sortOrder: '0',
};

function draftOf(b: AdminBadge): Draft {
  return {
    key: b.key, name: b.name, description: b.description, icon: b.icon, color: b.color, kind: b.kind,
    metric: b.metric ?? 'scores_posted', threshold: b.threshold != null ? String(b.threshold) : '',
    rule: b.rule ?? {}, retroactive: b.retroactive,
    availableFrom: b.availableFrom ? toLocalInput(b.availableFrom) : '', availableTo: b.availableTo ? toLocalInput(b.availableTo) : '',
    sortOrder: String(b.sortOrder),
  };
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
    sortOrder: Number(d.sortOrder) || 0,
  };
  if (!locked) { body.key = d.key; body.kind = d.kind; }
  if (d.kind === 'metric') {
    if (!locked) body.metric = d.metric;
    body.threshold = d.threshold === '' ? null : Math.round(Number(d.threshold));
  }
  if (d.kind === 'rule') body.rule = cleanRule(d.rule);
  return body;
}

const num = (v: string) => (v === '' ? undefined : Math.round(Number(v)));

/** The form builder for the rule vocabulary. */
function RuleBuilder({ rule, onChange, error }: { rule: BadgeRule; onChange: (r: BadgeRule) => void; error?: string }) {
  const api = useApi();
  const machines = useQuery({ queryKey: ['machines', 'admin-badge-picker'], queryFn: () => api.machines.list() });
  const venues = useQuery({ queryKey: ['venues', 'admin-badge-picker'], queryFn: () => api.venues.list() });
  const [machineQ, setMachineQ] = useState('');
  const set = (patch: Partial<BadgeRule>) => onChange({ ...rule, ...patch });
  const machineOptions = useMemo(() => {
    const all = (machines.data ?? []) as Array<{ id: number; name: string }>;
    const q = machineQ.trim().toLowerCase();
    return all.filter(m => !q || m.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50);
  }, [machines.data, machineQ]);
  const selectedMachine = (machines.data as Array<{ id: number; name: string }> | undefined)?.find(m => m.id === rule.machine?.machineId);

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
        <Field label="Machine" hint={selectedMachine ? `Selected: ${selectedMachine.name}` : 'Any machine'}>
          <input className={input} placeholder="Search machines…" value={machineQ} onChange={e => setMachineQ(e.target.value)} />
          <select className={input} value={rule.machine?.machineId ?? ''}
            onChange={e => set({ machine: e.target.value ? { machineId: Number(e.target.value), matchMode: rule.machine?.matchMode ?? 'group' } : undefined })}>
            <option value="">Any machine</option>
            {selectedMachine && !machineOptions.some(m => m.id === selectedMachine.id) && <option value={selectedMachine.id}>{selectedMachine.name}</option>}
            {machineOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
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
          onConfirm={async () => { await admin.deleteBadgeImage(badge.id); onDone(); }} onClose={() => setConfirmRemove(false)} />
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
          onConfirm={async () => { await admin.grantBadge(badge.id, picked.map(p => p.id), note.trim()); setPicked([]); setNote(''); onDone(); }}
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

function BadgeEditor({ badge, onSaved, onClose }: { badge: AdminBadge | null; onSaved: (b: AdminBadge) => void; onClose: () => void }) {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const metrics = useQuery({ queryKey: ['admin', 'badge-metrics'], queryFn: admin.badgeMetrics });
  const detail = useQuery({ queryKey: ['admin', 'badge', badge?.id], queryFn: () => admin.badge(badge!.id), enabled: !!badge });
  const live = detail.data?.badge ?? badge;
  const [d, setD] = useState<Draft>(badge ? draftOf(badge) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<BadgePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'activate' | 'retire' | { revoke: UserRef }>(null);
  useEffect(() => { setD(badge ? draftOf(badge) : EMPTY); setErrors({}); setError(null); setPreview(null); }, [badge?.id]);

  const locked = (live?.earnedCount ?? 0) > 0;
  const set = (patch: Partial<Draft>) => setD(x => ({ ...x, ...patch }));
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });

  async function save() {
    setSaving(true); setErrors({}); setError(null);
    try {
      const body = bodyOf(d, locked);
      const r = badge ? await admin.updateBadge(badge.id, body) : await admin.createBadge(body);
      await refresh();
      onSaved(r.badge);
    } catch (e: any) {
      setErrors(e?.body?.errors ?? {});
      setError(e);
    } finally { setSaving(false); }
  }
  async function runPreview() {
    if (!badge) return;
    setPreviewing(true); setError(null);
    try { setPreview(await admin.previewBadge(badge.id)); } catch (e) { setError(e); } finally { setPreviewing(false); }
  }

  const Icon = BADGE_ICONS[d.icon] ? d.icon : 'award';
  const faceForPreview = { id: live?.id ?? 0, name: d.name || 'New badge', icon: Icon, color: d.color, imageVersion: live?.imageVersion ?? null };

  return (
    <Card className="p-4 sm:p-5 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <BadgeImage badge={faceForPreview} size={48} />
          <div className="min-w-0">
            <h2 className="text-base font-black uppercase tracking-widest text-white [overflow-wrap:anywhere]">{badge ? d.name || badge.name : 'New badge'}</h2>
            {live && <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-2"><Pill tone={STATUS_TONE[live.status]}>{live.status}</Pill>{live.earnedCount.toLocaleString()} earned{live.activatedAt && <> · live since <When at={live.activatedAt} /></>}</p>}
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-white" aria-label="Close editor"><X className="w-5 h-5" /></button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name" error={errors.name}><input className={input} maxLength={60} value={d.name} onChange={e => set({ name: e.target.value })} /></Field>
        <Field label="Key (permanent slug)" error={errors.key} hint={locked ? 'Frozen — players have this badge' : 'e.g. holiday-champion-2026'}>
          <input className={input} disabled={locked} value={d.key} onChange={e => set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
        </Field>
        <Field label="Description" error={errors.description}>
          <textarea className={input} rows={2} maxLength={300} value={d.description} onChange={e => set({ description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-[1fr_auto_5rem] gap-3 items-start">
          <Field label="Icon (when no image)" error={errors.icon}>
            <select className={input} value={d.icon} onChange={e => set({ icon: e.target.value })}>
              {!BADGE_ICONS[d.icon] && <option value={d.icon}>{d.icon} (unknown)</option>}
              {Object.keys(BADGE_ICONS).sort().map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <Field label="Color" error={errors.color}>
            <input type="color" className="h-[38px] w-12 rounded border border-white/20 bg-transparent" value={d.color} onChange={e => set({ color: e.target.value })} />
          </Field>
          <Field label="Order" error={errors.sortOrder}><input type="number" className={input} value={d.sortOrder} onChange={e => set({ sortOrder: e.target.value })} /></Field>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Kind</span>
          {locked ? <Pill>{d.kind}</Pill> : (
            <Segmented<BadgeKind> value={d.kind} onChange={k => set({ kind: k })} options={[
              { value: 'metric', label: 'Metric' }, { value: 'rule', label: 'Rule' }, { value: 'manual', label: 'Manual' },
            ]} />
          )}
        </div>
        {d.kind === 'metric' && (
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-3">
            <Field label="Metric" error={errors.metric} hint={metrics.data?.find(m => m.key === d.metric)?.description}>
              <select className={input} disabled={locked} value={d.metric} onChange={e => set({ metric: e.target.value })}>
                {(metrics.data ?? []).map(m => <option key={m.key} value={m.key}>{m.label}{m.available ? '' : ' — phase 3, not yet'}</option>)}
              </select>
            </Field>
            <Field label="At least (N)" error={errors.threshold}>
              <input type="number" min={1} className={input} value={d.threshold} onChange={e => set({ threshold: e.target.value })} />
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
            Retroactive (award from history at go-live)
          </label>
        )}
      </div>

      {live?.activationBlocker && <p className="text-xs text-amber-300">Can’t go live yet: {live.activationBlocker}</p>}
      <ErrorNote error={error} />

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={saving} className={`${btn} bg-primary text-white hover:bg-primary/90`}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{badge ? 'Save changes' : 'Create draft'}
        </button>
        {badge && live && (
          <>
            {live.kind !== 'manual' && (
              <button type="button" onClick={runPreview} disabled={previewing} className={`${btn} border border-white/15 text-white/80 hover:text-white`}>
                {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Preview
              </button>
            )}
            {live.status !== 'live' && (
              <button type="button" onClick={() => setConfirm('activate')} disabled={!!live.activationBlocker} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}>
                <Rocket className="w-3.5 h-3.5" /> Go live
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
      {badge && <p className="text-[11px] text-muted-foreground -mt-3">Save your edits before previewing or going live — both use the saved badge.</p>}
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
        <ConfirmDialog title="Go live" danger={false} confirmLabel="Go live"
          body={<>
            <p>“{live.name}” becomes earnable and shows in the public catalog.</p>
            {live.kind !== 'manual' && (live.retroactive
              ? <p><b>Retroactive is on:</b> everyone who already qualifies gets it now, each with a notification{preview ? ` (${preview.newCount.toLocaleString()} from the last preview)` : ' — run Preview first to see who'}.</p>
              : <p>Retroactive is off: only activity from now on counts.</p>)}
          </>}
          onConfirm={async () => { await admin.activateBadge(live.id); await refresh(); setPreview(null); }}
          onClose={() => setConfirm(null)} />
      )}
      {confirm === 'retire' && live && (
        <ConfirmDialog title="Retire badge" confirmLabel="Retire"
          body={<p>“{live.name}” stops being awarded and leaves the catalog. The {live.earnedCount.toLocaleString()} players who have it keep it.</p>}
          onConfirm={async () => { await admin.retireBadge(live.id); await refresh(); }}
          onClose={() => setConfirm(null)} />
      )}
      {confirm && typeof confirm === 'object' && live && (
        <ConfirmDialog title="Revoke badge" confirmLabel="Revoke" reason="Reason (kept in the activity log)"
          body={<p>Take “{live.name}” away from @{confirm.revoke.username}? Nothing is revoked automatically — this is the only way.</p>}
          onConfirm={async reason => { await admin.revokeBadge(live.id, confirm.revoke.id, reason); await refresh(); }}
          onClose={() => setConfirm(null)} />
      )}
    </Card>
  );
}

export default function AdminBadgesPage() {
  const admin = useAdminApi();
  const q = useQuery({ queryKey: ['admin', 'badges'], queryFn: admin.badges });
  const [editing, setEditing] = useState<AdminBadge | 'new' | null>(null);
  const [status, setStatus] = useState<'all' | 'draft' | 'live' | 'retired'>('all');
  const items = (q.data?.items ?? []).filter(b => status === 'all' || b.status === status);
  // Keep the open editor pointed at the refreshed row after saves.
  const current = editing && editing !== 'new' ? q.data?.items.find(b => b.id === editing.id) ?? editing : null;

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
      {editing && (
        <div className="mb-6">
          <BadgeEditor key={editing === 'new' ? 'new' : editing.id} badge={editing === 'new' ? null : current}
            onSaved={b => setEditing(b)} onClose={() => setEditing(null)} />
        </div>
      )}
      <ErrorNote error={q.error} />
      {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">No badges.</p> : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-white/5">
            {items.map(b => (
              <li key={b.id}>
                <button type="button" onClick={() => setEditing(b)} className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-white/[0.03] ${current?.id === b.id ? 'bg-white/[0.05]' : ''}`}>
                  <BadgeImage badge={b} size={40} locked={b.status !== 'live'} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-bold text-white [overflow-wrap:anywhere]">{b.name}</span>
                      <Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill>
                      <span className="text-[11px] text-muted-foreground">{b.kind}</span>
                      {!b.metricAvailable && <Pill tone="warn">phase 3</Pill>}
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">{b.requirement}</span>
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">{b.earnedCount.toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </AdminShell>
  );
}
