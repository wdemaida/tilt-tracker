import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X, ArrowRight, Check, AlertTriangle, Minus } from 'lucide-react';
import { useApi } from '../lib/useApi';

type Confidence = 'exact' | 'normalized' | 'fuzzy' | 'unmatched';

interface Proposal {
  machineId: number;
  machineName: string;
  scoreCount: number;
  confidence: Confidence;
  pmName: string | null;
  pmManufacturer: string | null;
  pmYear: number | null;
  alreadyCorrect: boolean;
}

interface PreviewData {
  proposals: Proposal[];
  scope: 'all' | 'mine';
  pmMachineCount: number;
  pmLocationUrl: string;
}

interface Props {
  venueId: number;
  onClose: () => void;
  onApplied: () => void;
}

// Shows what a re-sync would do before it does it. A machine row is global — merging "The
// Transformers" into "Transformers: More Than Meets the Eye (Pro)" rewrites that machine's identity
// everywhere, not just at this venue — so every rename is opt-in and nothing is written until Apply.
export default function ScoreResyncModal({ venueId, onClose, onApplied }: Props) {
  const api = useApi();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<any | null>(null);

  const { data, isLoading, error } = useQuery<PreviewData>({
    queryKey: ['venue-resync-preview', venueId],
    queryFn: () => api.venues.repair.resyncPreview(venueId),
    retry: false,
  });

  // Pre-tick the confident renames; leave anything fuzzy for a deliberate click.
  useEffect(() => {
    if (!data) return;
    setSelected(new Set(
      data.proposals.filter(p => p.confidence === 'normalized' && p.pmName).map(p => p.machineId),
    ));
  }, [data]);

  const apply = useMutation({
    mutationFn: () => {
      const merges = (data?.proposals ?? [])
        .filter(p => selected.has(p.machineId) && p.pmName)
        .map(p => ({ fromMachineId: p.machineId, pmName: p.pmName, pmManufacturer: p.pmManufacturer, pmYear: p.pmYear }));
      return api.venues.repair.resyncApply(venueId, merges);
    },
    onSuccess: (res: any) => { setResult(res); onApplied(); },
  });

  const mergeable = (data?.proposals ?? []).filter(p => !p.alreadyCorrect && p.pmName);
  const selectedCount = mergeable.filter(p => selected.has(p.machineId)).length;

  function toggle(machineId: number) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId); else next.add(machineId);
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Re-sync scores</p>
            <h2 className="text-lg font-black uppercase tracking-wider text-venue leading-tight">
              {data ? `${data.proposals.reduce((n, p) => n + p.scoreCount, 0)} scores · ${data.proposals.length} machines` : '...'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[60vh] p-6 flex flex-col gap-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading Pinball Map roster...</p>}

          {error && (
            <p className="flex items-start gap-2 text-sm rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {(error as Error).message}
            </p>
          )}

          {result ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-primary font-bold">
                {result.scoresMoved} score{result.scoresMoved === 1 ? '' : 's'} moved ·{' '}
                {result.machinesEnriched} machine{result.machinesEnriched === 1 ? '' : 's'} enriched
              </p>
              {result.applied.map((a: any) => (
                <p key={a.fromMachineId} className="text-xs text-muted-foreground">
                  <span className="text-white">{a.fromName}</span> → <span className="text-machine">{a.toName}</span>
                  {' '}({a.scoresMoved} score{a.scoresMoved === 1 ? '' : 's'}
                  {a.sourceDeleted ? ', duplicate removed' : ''})
                </p>
              ))}
              {result.applied.length === 0 && (
                <p className="text-xs text-muted-foreground">No renames were applied — metadata was refreshed only.</p>
              )}
            </div>
          ) : data && (
            <>
              <p className="text-xs text-muted-foreground">
                {data.scope === 'mine'
                  ? 'Showing only your scores at this venue.'
                  : 'Showing all scores at this venue.'}{' '}
                Pinball Map lists {data.pmMachineCount} machines here.
              </p>

              <ul className="flex flex-col gap-2">
                {data.proposals.map(p => {
                  const actionable = !p.alreadyCorrect && !!p.pmName;
                  const isOn = selected.has(p.machineId);
                  return (
                    <li
                      key={p.machineId}
                      className={`rounded-lg border px-3 py-2.5 transition-colors ${
                        actionable && isOn ? 'border-primary/50 bg-primary/5' : 'border-white/10 bg-background'
                      }`}
                    >
                      <label className={`flex items-start gap-3 ${actionable ? 'cursor-pointer' : ''}`}>
                        <span className="mt-0.5 flex-shrink-0">
                          {p.alreadyCorrect ? (
                            <Check className="w-4 h-4 text-primary" />
                          ) : p.pmName ? (
                            <input
                              type="checkbox"
                              checked={isOn}
                              onChange={() => toggle(p.machineId)}
                              className="w-4 h-4 accent-current text-primary"
                            />
                          ) : (
                            <Minus className="w-4 h-4 text-muted-foreground" />
                          )}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                            <span className={p.alreadyCorrect ? 'text-machine font-bold' : 'text-white font-bold'}>
                              {p.machineName}
                            </span>
                            {p.pmName && !p.alreadyCorrect && (
                              <>
                                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                                <span className="text-machine font-bold">{p.pmName}</span>
                              </>
                            )}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{p.scoreCount} score{p.scoreCount === 1 ? '' : 's'}</span>
                            <ConfidenceBadge confidence={p.confidence} alreadyCorrect={p.alreadyCorrect} />
                            {[p.pmManufacturer, p.pmYear].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              {data.proposals.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No scores at this venue yet.</p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
          >
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={() => apply.mutate()}
              disabled={!data || apply.isPending}
              className="text-sm font-bold uppercase tracking-wider rounded-lg bg-primary text-black px-4 py-2 hover:bg-primary/80 disabled:opacity-40 transition-colors"
            >
              {apply.isPending
                ? 'Applying...'
                : selectedCount > 0
                  ? `Apply ${selectedCount} rename${selectedCount === 1 ? '' : 's'}`
                  : 'Refresh metadata only'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence, alreadyCorrect }: { confidence: Confidence; alreadyCorrect: boolean }) {
  if (alreadyCorrect) return <Badge tone="ok">Matches Pinball Map</Badge>;
  if (confidence === 'normalized') return <Badge tone="ok">Same title</Badge>;
  if (confidence === 'fuzzy') return <Badge tone="warn">Likely — check this</Badge>;
  return <Badge tone="muted">Not on Pinball Map</Badge>;
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) {
  const cls = tone === 'ok'
    ? 'border-primary/40 text-primary'
    : tone === 'warn'
      ? 'border-amber-500/40 text-amber-400'
      : 'border-white/20 text-muted-foreground';
  return (
    <span className={`text-[0.65rem] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border ${cls}`}>
      {children}
    </span>
  );
}
