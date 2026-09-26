import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Trash2, Search } from 'lucide-react';
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

function fieldError(view: RetentionView, field: keyof RetentionSettings, raw: string): string | null {
  const lim = view.limits[field];
  if (raw.trim() === '') return 'Required';
  const v = Number(raw);
  if (!Number.isInteger(v)) return 'Whole days only';
  if (lim.allowZero && v === 0) return null;
  if (v < lim.min || v > lim.max) return `${lim.allowZero ? '0 or ' : ''}${n(lim.min)}–${n(lim.max)}`;
  return null;
}

function daysLabel(days: number | null) {
  if (days == null) return 'kept forever';
  if (days % 365 === 0) return `${days / 365} year${days === 365 ? '' : 's'}`;
  return `${n(days)} days`;
}

export function RetentionSettingsCard() {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const { data: view, error, isLoading } = useQuery({ queryKey: ['admin', 'retention'], queryFn: admin.retention });
  const [draft, setDraft] = useState<Record<keyof RetentionSettings, string> | null>(null);

  useEffect(() => {
    if (view && !draft) {
      setDraft({ highVolumeDays: String(view.settings.highVolumeDays), standardDays: String(view.settings.standardDays), adminDays: String(view.settings.adminDays) });
    }
  }, [view, draft]);

  const save = useMutation({
    mutationFn: (s: RetentionSettings) => admin.saveRetention(s),
    onSuccess: saved => {
      qc.setQueryData(['admin', 'retention'], saved);
      setDraft({ highVolumeDays: String(saved.settings.highVolumeDays), standardDays: String(saved.settings.standardDays), adminDays: String(saved.settings.adminDays) });
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

  const errors = Object.fromEntries(TIERS.map(t => [t.field, fieldError(view, t.field, draft[t.field])])) as Record<keyof RetentionSettings, string | null>;
  const valid = Object.values(errors).every(e => !e);
  const dirty = TIERS.some(t => Number(draft[t.field]) !== view.settings[t.field] || draft[t.field].trim() === '');
  const atDefaults = TIERS.every(t => Number(draft[t.field]) === view.defaults[t.field]);
  const totalEligible = view.tiers.reduce((s, t) => s + t.eligible, 0);

  return (
    <div className="rounded-xl border border-white/10 bg-card p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className="text-base font-black uppercase tracking-wider text-white">Data retention</h3>
        {!atDefaults && (
          <button
            type="button"
            onClick={() => setDraft({ highVolumeDays: String(view.defaults.highVolumeDays), standardDays: String(view.defaults.standardDays), adminDays: String(view.defaults.adminDays) })}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors flex-shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            Defaults
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        How long the admin activity log keeps each kind of event. Older events are deleted by the daily cleanup
        (with the challenge sweep), a batch at a time.
      </p>

      <ul className="divide-y divide-white/10">
        {TIERS.map(t => {
          const st = view.tiers.find(x => x.tier === t.tier);
          const err = errors[t.field];
          const types = view.typesByTier[t.tier] ?? [];
          return (
            <li key={t.tier} className="py-4 flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-white">{t.label}</p>
                <p className="text-xs text-muted-foreground">{t.description}</p>
                <p className="text-xs text-white/70 mt-1.5">
                  {st ? <>{n(st.rows)} event{st.rows === 1 ? '' : 's'}{st.oldest ? <> · oldest <When at={st.oldest} /></> : ''}</> : '—'}
                  {st && st.eligible > 0 && <> · <span className="text-amber-400">next run deletes ~{n(st.eligible)}</span></>}
                </p>
                <details className="mt-1">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-white select-none">
                    {types.length} event type{types.length === 1 ? '' : 's'}{t.tier === 'standard' ? ' + anything unlisted' : t.tier === 'admin' ? ` + any ${view.adminPrefix}*` : ''}
                  </summary>
                  <p className="text-[11px] font-mono text-white/60 mt-1 break-words">{types.join(', ')}</p>
                </details>
              </div>
              <div className="sm:w-40 flex-shrink-0">
                <label className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={view.limits[t.field].allowZero ? 0 : view.limits[t.field].min}
                    max={view.limits[t.field].max}
                    step={1}
                    value={draft[t.field]}
                    onChange={e => setDraft({ ...draft, [t.field]: e.target.value })}
                    aria-label={`${t.label} retention in days`}
                    aria-invalid={!!err}
                    className={`w-24 border rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary tabular-nums ${err ? 'border-red-500/60' : 'border-white/20'}`}
                  />
                  <span className="text-xs text-muted-foreground">days</span>
                </label>
                <p className={`text-[11px] mt-1 ${err ? 'text-red-400' : 'text-muted-foreground'}`}>
                  {err ?? (view.limits[t.field].allowZero
                    ? (Number(draft[t.field]) === 0 ? '0 = keep forever' : `${daysLabel(Number(draft[t.field]))} · 0 = keep forever`)
                    : daysLabel(Number(draft[t.field])))}
                </p>
              </div>
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
          onClick={() => save.mutate({ highVolumeDays: Number(draft.highVolumeDays), standardDays: Number(draft.standardDays), adminDays: Number(draft.adminDays) })}
          className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 disabled:opacity-40 text-white rounded-lg px-5 py-2.5 text-sm font-bold uppercase tracking-wider"
        >
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}Save
        </button>
      </div>
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
