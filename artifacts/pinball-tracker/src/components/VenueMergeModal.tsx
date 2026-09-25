import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, ArrowRight, AlertTriangle, Merge } from 'lucide-react';
import { useApi } from '../lib/useApi';
import type { VenueMergePreview, VenueMergeResult } from '../lib/api';

interface Props {
  /** The duplicate — the venue that goes away. */
  sourceVenueId: number;
  /** The venue that stays and receives everything. */
  target: { id: number; name: string };
  onClose: () => void;
  /** Called after a successful merge; the caller navigates to the target venue. */
  onMerged: (result: VenueMergeResult) => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Preview-then-confirm for folding a duplicate venue into the one TiltTrack already had. Same shape
// as ScoreResyncModal: nothing is written until the button is pressed, and the server re-checks
// every rule (and the score count shown here) when it is.
export default function VenueMergeModal({ sourceVenueId, target, onClose, onMerged }: Props) {
  const api = useApi();
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery<VenueMergePreview>({
    queryKey: ['venue-merge-preview', sourceVenueId, target.id],
    queryFn: () => api.venues.repair.mergePreview(sourceVenueId, target.id),
    retry: false,
  });

  const merge = useMutation({
    mutationFn: () => api.venues.repair.merge(sourceVenueId, target.id, data!.scoreCount),
    onSuccess: (res) => {
      // The source venue no longer exists: drop its per-venue queries (keyed [name, id], id as a
      // number or string) rather than refetching them into 404s, and refresh everything else.
      const isSourceQuery = (key: readonly unknown[]) => key.length > 1 && String(key[1]) === String(sourceVenueId);
      queryClient.removeQueries({ predicate: q => isSourceQuery(q.queryKey) });
      const refreshed = new Set(['venues', 'scores', 'venue-scores', 'venue-machines', 'venue-repair', 'score-repair']);
      queryClient.invalidateQueries({
        predicate: q => refreshed.has(String(q.queryKey[0])) && !isSourceQuery(q.queryKey),
      });
      onMerged(res);
    },
    onError: (e: any) => {
      // The scores changed under the preview — show the fresh numbers rather than a dead end.
      if (e?.code === 'merge_stale') refetch();
    },
  });

  const mergeError = merge.error as (Error & { code?: string }) | null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && !merge.isPending) onClose(); }}
    >
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Merge duplicate venue</p>
            <h2 className="text-lg font-black uppercase tracking-wider text-venue leading-tight truncate">
              Into “{data?.target.name ?? target.name}”
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={merge.isPending}
            aria-label="Close"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[60vh] p-6 flex flex-col gap-4">
          {isLoading && <p className="text-sm text-muted-foreground">Checking what would move...</p>}

          {error && <Warning text={(error as Error).message} />}

          {data && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-bold text-white">{data.source.name}</span>
                <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="font-bold text-venue">{data.target.name}</span>
              </div>
              {data.target.address && <p className="-mt-3 text-xs text-muted-foreground">{data.target.address}</p>}

              <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                <li>
                  <span className="text-primary font-bold">{plural(data.scoreCount, 'score')}</span> move to “{data.target.name}”
                  {data.scoreCount > 0 && data.myScoreCount === data.scoreCount && ' — all yours'}
                  {data.otherPlayerCount > 0 && ` — ${plural(data.otherScoreCount, 'score')} by ${plural(data.otherPlayerCount, 'other player')}`}
                </li>
                {data.players && data.players.length > 0 && (
                  <li className="text-xs">
                    Players affected: {data.players.map(p => `${p.username} (${p.scoreCount})`).join(', ')}
                  </li>
                )}
                {data.historyRows > 0 && (
                  <li className="text-xs">
                    {plural(data.historyRows, 'machine history entry')} carried over
                    {data.historyOverlap > 0 && ` (${data.historyOverlap} combined with ones already there)`}
                  </li>
                )}
                {data.inventoryRows > 0 && (
                  <li className="text-xs">
                    {plural(data.inventoryRows, 'listed machine')} carried over
                    {data.inventoryOverlap > 0 && ` (${data.inventoryOverlap} already listed there)`}
                  </li>
                )}
                {data.adopts.length > 0 && (
                  <li className="text-xs">“{data.target.name}” also takes this venue’s {data.adopts.join(', ')}, which it didn’t have.</li>
                )}
                <li className="text-xs">
                  “{data.source.name}” is then deleted. This can’t be undone from the app.
                </li>
              </ul>

              {!data.canMerge && data.blockerMessage && <Warning text={data.blockerMessage} />}
            </>
          )}

          {mergeError && <Warning text={mergeError.message} />}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            disabled={merge.isPending}
            className="text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => merge.mutate()}
            disabled={!data?.canMerge || merge.isPending}
            className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider rounded-lg bg-primary text-black px-4 py-2 hover:bg-primary/80 disabled:opacity-40 transition-colors"
          >
            <Merge className="w-4 h-4" />
            {merge.isPending ? 'Merging...' : data ? `Merge ${plural(data.scoreCount, 'score')}` : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 text-sm rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      {text}
    </p>
  );
}
