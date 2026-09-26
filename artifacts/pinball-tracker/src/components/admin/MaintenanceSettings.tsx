import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RotateCcw, Trash2, Search } from 'lucide-react';
import {
  useAdminApi, type RetentionSettings, type RetentionTier, type RetentionView, type PhotoOrphanRunResult,
} from '../../lib/adminApi';
import { ConfirmDialog, ErrorNote, When, Pill } from './AdminParts';

// Admin > Config: "Data retention" (activity-log tiers, stored server-side in app_settings) and
// "Photo storage cleanup" (the R2 orphan sweep). Both jobs run from the daily challenge sweep; see
// api-server CLAUDE.md, "Activity-log retention" / "Photo orphan sweep".

const TIERS: Array<{ tier: RetentionTier; field: keyof RetentionSettings; label: string; description: string }> = [
  { tier: 'high_volume', field: 'highVolumeDays', label: 'High-volume', description: 'Sign-ins, every notification sent, daily job heartbeats' },
  { tier: 'standard', field: 'standardDays', label: 'Standard', description: 'Scores, photos, friends, pods, challenges, venue repairs, Pinball Map — and any new event type' },
  { tier: 'admin', field: 'adminDays', label: 'Admin & moderation', description: 'Every admin action, plus sign-ups and deleted Clerk accounts' },
];

const n = (v: number) => v.toLocaleString();
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const selectCls = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-primary';

// Each tier is stored as one number: -1 = keep forever, 0 = don't record, 1–36500 = days (server:
// RETENTION_LIMITS). The UI edits it as a mode + a day count, so nobody has to remember the codes.
type Mode = 'days' | 'forever' | 'off';
interface TierDraft { mode: Mode; days: string }
type Draft = Record<keyof RetentionSettings, TierDraft>;
type Limits = RetentionView['limits'][keyof RetentionSettings];

function toDraft(view: RetentionView, s: RetentionSettings): Draft {
  const one = (field: keyof RetentionSettings): TierDraft => {
    const v = s[field];
    const lim = view.limits[field];
    const fallbackDays = view.defaults[field] >= lim.min ? view.defaults[field] : 365;
    if (v === lim.forever) return { mode: 'forever', days: String(fallbackDays) };
    if (v === lim.off) return { mode: 'off', days: String(fallbackDays) };
    return { mode: 'days', days: String(v) };
  };
  return { highVolumeDays: one('highVolumeDays'), standardDays: one('standardDays'), adminDays: one('adminDays') };
}

function draftValue(d: TierDraft, lim: Limits): number {
  return d.mode === 'forever' ? lim.forever : d.mode === 'off' ? lim.off : Number(d.days);
}

function fieldError(d: TierDraft, lim: Limits): string | null {
  if (d.mode !== 'days') return null;
  if (d.days.trim() === '') return 'Required';
  const v = Number(d.days);
  if (!Number.isInteger(v)) return 'Whole days only';
  if (v < lim.min || v > lim.max) return `${n(lim.min)}–${n(lim.max)} days`;
  return null;
}

/** "Kept forever" / "Not recorded" / "1 year" / "90 days". */
function retentionLabel(v: number, lim: Limits) {
  if (v === lim.forever) return 'Kept forever';
  if (v === lim.off) return 'Not recorded';
  if (v % 365 === 0) return `${v / 365} year${v === 365 ? '' : 's'}`;
  return `${n(v)} day${v === 1 ? '' : 's'}`;
}

export function RetentionSettingsCard() {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const { data: view, error, isLoading } = useQuery({ queryKey: ['admin', 'retention'], queryFn: admin.retention });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState<RetentionSettings | null>(null);

  useEffect(() => {
    if (view && !draft) setDraft(toDraft(view, view.settings));
  }, [view, draft]);

  const save = useMutation({
    mutationFn: (s: RetentionSettings) => admin.saveRetention(s),
    onSuccess: saved => {
      qc.setQueryData(['admin', 'retention'], saved);
      setDraft(toDraft(saved, saved.settings));
      qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  if (isLoading || !view || !draft) {
    return (
      <div className="rounded-xl border border-white/10 bg-card p-4 sm:p-6">
        <h3 className="text-base font-black uppercase tracking-wider text-white">Data retention</h3>
        <ErrorNote error={error} />
        {!error && <p className="text-sm text-muted-foreground mt-2">Loading…</p>}
      </div>
    );
  }

  const lim = (f: keyof RetentionSettings) => view.limits[f];
  const value = (f: keyof RetentionSettings) => draftValue(draft[f], lim(f));
  const setTier = (f: keyof RetentionSettings, patch: Partial<TierDraft>) => setDraft({ ...draft, [f]: { ...draft[f], ...patch } });
  const errors = Object.fromEntries(TIERS.map(t => [t.field, fieldError(draft[t.field], lim(t.field))])) as Record<keyof RetentionSettings, string | null>;
  const valid = Object.values(errors).every(e => !e);
  const dirty = TIERS.some(t => value(t.field) !== view.settings[t.field]);
  const atDefaults = TIERS.every(t => value(t.field) === view.defaults[t.field]);
  const totalEligible = view.tiers.reduce((s, t) => s + t.eligible, 0);
  // Tiers this save would switch off (recording stops, existing rows purged at the next cleanup).
  const turningOff = TIERS.filter(t => value(t.field) === lim(t.field).off && view.settings[t.field] !== lim(t.field).off);
  const rowsIn = (tier: RetentionTier) => view.tiers.find(x => x.tier === tier)?.rows ?? 0;

  const next = (): RetentionSettings => ({ highVolumeDays: value('highVolumeDays'), standardDays: value('standardDays'), adminDays: value('adminDays') });
  const onSave = () => (turningOff.length ? setConfirming(next()) : save.mutate(next()));

  return (
    <div className="rounded-xl border border-white/10 bg-card p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="text-base font-black uppercase tracking-wider text-white">Data retention</h3>
        {!atDefaults && (
          <button
            type="button"
            onClick={() => setDraft(toDraft(view, view.defaults))}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors flex-shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            Defaults
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        How long the admin activity log keeps each kind of event: a number of days, forever, or not at all (Off — those
        events aren’t recorded). Older events are deleted by the daily cleanup (with the challenge sweep), a batch at a time.
      </p>

      <ul className="divide-y divide-white/10">
        {TIERS.map(t => {
          const st = view.tiers.find(x => x.tier === t.tier);
          const err = errors[t.field];
          const types = view.typesByTier[t.tier] ?? [];
          const d = draft[t.field];
          const v = value(t.field);
          const newlyOff = turningOff.some(x => x.field === t.field);
          return (
            <li key={t.tier} className="py-4">
              <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-white">{t.label}</p>
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                  <p className="text-xs text-white/70 mt-1.5">
                    {st ? <>{n(st.rows)} event{st.rows === 1 ? '' : 's'}{st.oldest ? <> · oldest <When at={st.oldest} /></> : ''}</> : '—'}
                    {st?.days === 0 && <> · not recorded</>}
                    {st && st.eligible > 0 && <> · <span className="text-amber-400">next run deletes ~{n(st.eligible)}</span></>}
                  </p>
                  <details className="mt-1">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-white select-none">
                      {types.length} event type{types.length === 1 ? '' : 's'}{t.tier === 'standard' ? ' + anything unlisted' : t.tier === 'admin' ? ` + any ${view.adminPrefix}*` : ''}
                    </summary>
                    <p className="text-[11px] font-mono text-white/60 mt-1 break-words">{types.join(', ')}</p>
                  </details>
                </div>
                <div className="sm:w-52 flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <select
                      value={d.mode}
                      onChange={e => setTier(t.field, { mode: e.target.value as Mode })}
                      aria-label={`${t.label} retention`}
                      className={selectCls}
                    >
                      <option value="days">Keep for</option>
                      <option value="forever">Forever</option>
                      <option value="off">Off</option>
                    </select>
                    {d.mode === 'days' && (
                      <label className="flex items-center gap-2">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={lim(t.field).min}
                          max={lim(t.field).max}
                          step={1}
                          value={d.days}
                          onChange={e => setTier(t.field, { days: e.target.value })}
                          aria-label={`${t.label} retention in days`}
                          aria-invalid={!!err}
                          className={`w-20 border rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary tabular-nums ${err ? 'border-red-500/60' : 'border-white/20'}`}
                        />
                        <span className="text-xs text-muted-foreground">days</span>
                      </label>
                    )}
                  </div>
                  <p className={`text-[11px] mt-1 ${err ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {err ?? retentionLabel(v, lim(t.field))}
                  </p>
                </div>
              </div>
              {newlyOff && (
                <div role="alert" className={`mt-3 flex gap-2 rounded-lg border px-3 py-2 text-xs ${t.tier === 'admin' ? 'border-red-500/50 bg-red-500/10 text-red-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}>
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
                  {t.tier === 'admin'
                    ? <p><strong>This turns off the admin audit trail.</strong> Admin actions, sign-ups and deleted accounts will stop being recorded as soon as you save, and all {n(rowsIn(t.tier))} existing records — including the record of this change — will be permanently deleted at the next daily cleanup.</p>
                    : <p>These events will stop being recorded as soon as you save, and the {n(rowsIn(t.tier))} existing one{rowsIn(t.tier) === 1 ? '' : 's'} will be deleted at the next daily cleanup.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ErrorNote error={save.error} />
      <div className="flex flex-col-reverse sm:flex-row sm:items-center justify-between gap-3 mt-2">
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>
            Last cleanup:{' '}
            {view.lastRun
              ? <><When at={view.lastRun.at} />, deleted {n(view.lastRun.total)}{view.lastRun.capped ? ' (capped — continues next run)' : ''}{view.lastRun.errors ? ` · ${view.lastRun.errors} error(s)` : ''}</>
              : 'none yet — it runs with the daily challenge sweep'}
          </p>
          <p>
            {view.isDefault ? 'Using the defaults' : <>Saved {view.updatedBy ? <>by {view.updatedBy.displayName} </> : ''}<When at={view.updatedAt} /></>}
            {totalEligible > 0 && dirty ? ' · estimates reflect the saved settings' : ''}
          </p>
        </div>
        <button
          type="button"
          disabled={!dirty || !valid || save.isPending}
          onClick={onSave}
          className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 disabled:opacity-40 text-white rounded-lg px-5 py-2.5 text-sm font-bold uppercase tracking-wider"
        >
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}Save
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Stop recording events"
          body={<>
            <p>Turning off: {turningOff.map(t => t.label).join(', ')}.</p>
            <p>Those events stop being recorded immediately, and the {n(turningOff.reduce((s, t) => s + rowsIn(t.tier), 0))} existing ones are permanently deleted at the next daily cleanup.</p>
            {turningOff.some(t => t.tier === 'admin') && <p className="text-red-300">That includes the admin audit trail and the record of this change.</p>}
          </>}
          confirmLabel="Turn off"
          onConfirm={() => save.mutateAsync(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function RunResult({ r }: { r: PhotoOrphanRunResult }) {
  return (
    <div className="mt-3 text-xs rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-white/80 space-y-0.5">
      <p className="font-bold text-white">{r.dryRun ? 'Dry run — nothing deleted' : 'Done'}</p>
      <p>
        {n(r.listed)} object{r.listed === 1 ? '' : 's'} in {r.bucket}, {n(r.referenced)} referenced by scores ·{' '}
        {n(r.orphans)} orphan{r.orphans === 1 ? '' : 's'} older than {r.minAgeHours}h ({mb(r.orphanBytes)})
      </p>
      {!r.dryRun && <p>Deleted {n(r.deleted)}{r.failed ? `, ${n(r.failed)} failed` : ''}{r.skippedReferenced ? `, kept ${n(r.skippedReferenced)} confirmed mid-run` : ''}</p>}
      {r.capped && <p className="text-amber-400">Capped — run again for the rest.</p>}
      {r.sampleScoreIds.length > 0 && <p className="text-muted-foreground break-words">Score ids: {r.sampleScoreIds.slice(0, 12).join(', ')}{r.sampleScoreIds.length > 12 ? '…' : ''}</p>}
    </div>
  );
}

export function PhotoOrphansCard() {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const { data: st, error } = useQuery({ queryKey: ['admin', 'photo-orphans'], queryFn: admin.photoOrphans });
  const [result, setResult] = useState<PhotoOrphanRunResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dry = useMutation({
    mutationFn: () => admin.runPhotoOrphans(true),
    onSuccess: r => { setResult(r); qc.invalidateQueries({ queryKey: ['admin'] }); },
  });

  const usable = !!st?.configured && !st.envMismatch;
  const last = st?.lastRun;

  return (
    <div className="rounded-xl border border-white/10 bg-card p-4 sm:p-6">
      <h3 className="text-base font-black uppercase tracking-wider text-white mb-1">Photo storage cleanup</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Deletes full-size photos in R2 that no score points to (uploads never confirmed, failed deletes) and that are
        over 24 hours old. Runs automatically once a week with the daily sweep, up to 1,000 deletions per run.
      </p>
      <ErrorNote error={error} />
      {st && (
        <div className="text-xs text-white/80 space-y-1">
          {!st.configured && <p><Pill tone="warn">off</Pill> Full-size photos (R2) aren’t configured here — nothing to clean.</p>}
          {st.envMismatch && <p><Pill tone="danger">refused</Pill> {st.envMismatch}.</p>}
          <p>
            Last run:{' '}
            {last
              ? <><When at={last.at} /> · {last.trigger}{last.dryRun ? ' · dry run' : ''} · {n(last.orphans)} orphan{last.orphans === 1 ? '' : 's'} of {n(last.listed)}{last.dryRun ? '' : `, deleted ${n(last.deleted)}`}{last.failed ? `, ${n(last.failed)} failed` : ''}</>
              : 'never'}
          </p>
          <p className="text-muted-foreground">
            Next automatic run: {st.dueNow || !st.nextDueAt ? 'with the next daily sweep' : <When at={st.nextDueAt} />}
          </p>
        </div>
      )}
      <ErrorNote error={dry.error} />
      <div className="flex flex-col sm:flex-row gap-2 mt-4">
        <button
          type="button" disabled={!usable || dry.isPending} onClick={() => dry.mutate()}
          className="inline-flex items-center justify-center gap-2 border border-white/20 text-white hover:border-white/40 disabled:opacity-40 rounded-lg px-4 py-2.5 text-sm font-bold uppercase tracking-wider"
        >
          {dry.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}Run now (dry run)
        </button>
        <button
          type="button" disabled={!usable || dry.isPending} onClick={() => setConfirming(true)}
          className="inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded-lg px-4 py-2.5 text-sm font-bold uppercase tracking-wider"
        >
          <Trash2 className="w-4 h-4" />Run now
        </button>
      </div>
      {result && <RunResult r={result} />}
      {confirming && (
        <ConfirmDialog
          title="Delete orphaned photos"
          body={<>
            <p>Permanently deletes up to 1,000 photo files in R2 that no score references and that are over 24 hours old.</p>
            <p>Each batch is re-checked against the database right before deletion. Try a dry run first to see how many there are.</p>
          </>}
          confirmLabel="Delete orphans"
          onConfirm={async () => {
            const r = await admin.runPhotoOrphans(false);
            setResult(r);
            await qc.invalidateQueries({ queryKey: ['admin'] });
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
