import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { AlertTriangle, Loader2, Search, Wrench, X } from 'lucide-react';
import { useAdminApi, type MergeCandidate, type MergeTarget } from '../lib/adminApi';
import { ConfirmDialog, ErrorNote } from './admin/AdminParts';

// Admin-only "Fix machine" on /machines/:name — fold a mis-named machine row ("Jaws Pro Edition", an
// AI read saved verbatim) into the right one ("JAWS (Pro)"). The server (lib/machineMerge.ts) moves
// every score, venue history / inventory row, challenge pick, challenge and badge rule in one
// transaction, re-counts the challenges and deletes the old row. Targets: the canonicalizer's
// suggestion against the stored Pinball Map catalog, or a search over existing machines + the catalog.
// Pick → dry-run preview (what moves, every table) → ConfirmDialog → navigate to the target's page.

interface Props {
  machine: { id: number; name: string };
}

export default function MachineMergeButton({ machine }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 mt-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white"
      >
        <Wrench className="w-3.5 h-3.5" /> Fix machine
      </button>
      {open && <MachineMergeDialog machine={machine} onClose={() => setOpen(false)} />}
    </>
  );
}

const targetOf = (c: MergeCandidate): MergeTarget => (c.machineId != null ? { targetId: c.machineId } : { targetName: c.name });
const keyOf = (c: MergeCandidate) => (c.machineId != null ? `id:${c.machineId}` : `name:${c.name}`);

function MachineMergeDialog({ machine, onClose }: Props & { onClose: () => void }) {
  const admin = useAdminApi();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const titleId = useId();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [picked, setPicked] = useState<MergeCandidate | null>(null);
  const [confirmDifferent, setConfirmDifferent] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !confirming) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirming]);

  const candidates = useQuery({
    queryKey: ['admin', 'merge-candidates', machine.id, debounced],
    queryFn: () => admin.mergeCandidates(machine.id, debounced),
    placeholderData: prev => prev,
  });
  const preview = useQuery({
    queryKey: ['admin', 'merge-preview', machine.id, picked ? keyOf(picked) : null],
    queryFn: () => admin.previewMachineMerge(machine.id, targetOf(picked!)),
    enabled: picked != null,
    retry: false,
  });
  const p = preview.data?.preview;

  useEffect(() => { setConfirmDifferent(false); }, [picked]);

  const suggestion = candidates.data?.suggestion ?? null;
  const results = (candidates.data?.results ?? []).filter(r => !suggestion || keyOf(r) !== keyOf(suggestion));
  const canMerge = !!p && !p.blocker && (p.titlesMatch || confirmDifferent);

  async function merge() {
    if (!picked || !p) return;
    const r = await admin.mergeMachine(machine.id, {
      ...targetOf(picked), expectedScoreCount: p.scoreCount, confirmDifferentTitle: !p.titlesMatch && confirmDifferent,
    });
    await queryClient.invalidateQueries({ queryKey: ['machine'] });
    await queryClient.invalidateQueries({ queryKey: ['machines'] });
    navigate(`/machines/${encodeURIComponent(r.target.name)}`);
    onClose(); // the page component stays mounted across the navigation, so close explicitly
  }

  const players = p?.players ?? [];
  const playerText = players.slice(0, 5).map(x => `@${x.username}`).join(', ') + (players.length > 5 ? ` +${players.length - 5} more` : '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && !confirming) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl border border-white/10 bg-card shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 sm:px-6 py-4 border-b border-white/10">
          <h2 id={titleId} className="min-w-0 flex-1">
            <span className="block text-xs text-muted-foreground uppercase tracking-wider font-bold">Fix machine (admin)</span>
            <span className="block text-lg font-black uppercase tracking-wider text-machine leading-tight break-words">{machine.name}</span>
          </h2>
          <button onClick={onClose} aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 sm:px-6 py-4 flex flex-col gap-4 text-sm">
          <p className="text-muted-foreground">
            Merge this machine into the right one: every score and reference moves there, and this row is retired.
          </p>

          {candidates.data && !candidates.data.catalogAvailable && (
            <p className="text-amber-300 text-xs">The Pinball Map catalog isn’t stored yet — only existing machines can be picked.</p>
          )}

          {suggestion && (
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Suggested</p>
              <CandidateRow c={suggestion} selected={picked != null && keyOf(picked) === keyOf(suggestion)} onPick={setPicked} />
            </div>
          )}

          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5 block" htmlFor={`${titleId}-q`}>
              Or search machines and the catalog
            </label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input id={`${titleId}-q`} value={query} onChange={e => setQuery(e.target.value)} placeholder="e.g. jaws"
                className="w-full border border-white/20 rounded-lg pl-9 pr-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary" />
            </div>
            {candidates.isFetching && <p className="text-xs text-muted-foreground mt-2">Searching…</p>}
            {debounced && !candidates.isFetching && results.length === 0 && (
              <p className="text-xs text-muted-foreground mt-2">No other machine or catalog title matches.</p>
            )}
            <div className="flex flex-col gap-1.5 mt-2">
              {results.map(c => (
                <CandidateRow key={keyOf(c)} c={c} selected={picked != null && keyOf(picked) === keyOf(c)} onPick={setPicked} />
              ))}
            </div>
          </div>
          <ErrorNote error={candidates.error} />

          {picked && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-2">
              {preview.isLoading && <p className="text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Checking…</p>}
              <ErrorNote error={preview.error} />
              {p && (
                <>
                  <p className="text-white">
                    Move <strong>{p.scoreCount} score{p.scoreCount === 1 ? '' : 's'}</strong>
                    {players.length > 0 && <> (by {playerText})</>} from “{p.source.name}” to “{p.target.name}”
                    {p.target.id == null && ' (a new row from the Pinball Map catalog)'} and retire “{p.source.name}”.
                  </p>
                  <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
                    <li>Venue history: {p.history.rows} row{p.history.rows === 1 ? '' : 's'}{p.history.merged ? ` (${p.history.merged} merged with the target’s)` : ''}</li>
                    <li>Home inventories: {p.inventory.rows}{p.inventory.merged ? ` (${p.inventory.merged} merged)` : ''}</li>
                    <li>“Challenge me on” picks: {p.picks.rows}{p.picks.dropped ? ` (${p.picks.dropped} already pick the target — dropped)` : ''}</li>
                    <li>Challenges on this machine: {p.challenges.length}{p.challenges.length ? ` (#${p.challenges.map(c => c.id).join(', #')} — re-pointed and re-counted)` : ''}</li>
                    <li>Scores counting toward a challenge: {p.lockedScores}</li>
                    <li>Badge rules: {p.badges.length}{p.badges.length ? ` (${p.badges.map(b => b.name).join(', ')} — re-pointed)` : ''}</li>
                  </ul>
                  {p.blocker && (
                    <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                      {p.blocker.message}
                      {p.blocker.challengeIds?.length ? ` (challenge #${p.blocker.challengeIds.join(', #')})` : ''}
                      {p.blocker.refs ? ` (${Object.entries(p.blocker.refs).map(([k, n]) => `${k}: ${n}`).join(', ')})` : ''}
                    </p>
                  )}
                  {!p.blocker && !p.titlesMatch && (
                    <label className="flex items-start gap-2 text-amber-300 text-sm">
                      <input type="checkbox" checked={confirmDifferent} onChange={e => setConfirmDifferent(e.target.checked)} className="mt-1" />
                      <span><AlertTriangle className="w-4 h-4 inline -mt-0.5 mr-1" />
                        These don’t look like the same title. Merge anyway — every score here becomes a “{p.target.name}” score.</span>
                    </label>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-3 px-5 sm:px-6 py-4 border-t border-white/10">
          <button type="button" onClick={onClose}
            className="flex-1 border border-white/20 text-muted-foreground hover:text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider">
            Cancel
          </button>
          <button type="button" disabled={!canMerge} onClick={() => setConfirming(true)}
            className="flex-1 rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider text-white bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600">
            Merge…
          </button>
        </div>
      </div>

      {confirming && p && (
        <ConfirmDialog
          title="Merge machines"
          confirmLabel="Merge"
          body={<>
            <p>Move {p.scoreCount} score{p.scoreCount === 1 ? '' : 's'} from “{p.source.name}” to “{p.target.name}” and delete “{p.source.name}”.</p>
            <p className="text-muted-foreground">This can’t be undone from the app.</p>
          </>}
          onConfirm={merge}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

function CandidateRow({ c, selected, onPick }: { c: MergeCandidate; selected: boolean; onPick: (c: MergeCandidate) => void }) {
  return (
    <button type="button" onClick={() => onPick(c)}
      className={`w-full text-left flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
        selected ? 'border-primary bg-primary/10' : 'border-white/10 hover:border-white/30 hover:bg-white/5'}`}>
      {c.imageUrl
        ? <img src={c.imageUrl} alt="" className="w-9 h-9 rounded-md object-cover border border-white/10 flex-shrink-0" />
        : <span className="w-9 h-9 rounded-md bg-white/5 border border-white/10 flex-shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block text-white font-semibold break-words">{c.name}</span>
        <span className="block text-xs text-muted-foreground">
          {[c.manufacturer, c.year].filter(Boolean).join(' · ') || '—'}
          {' · '}
          {c.machineId != null ? `${c.scoreCount} score${c.scoreCount === 1 ? '' : 's'}` : 'not in TiltTrack yet'}
          {c.inCatalog ? ' · catalog' : ''}
        </span>
      </span>
    </button>
  );
}
