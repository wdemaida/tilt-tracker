import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { format } from 'date-fns';
import { useApi } from '../lib/useApi';

interface VenueMachinesData {
  venue: { id: number; name: string };
  ownMachines: Array<{ id: number; name: string; manufacturer?: string; year?: number; bestScore: number; playCount: number }>;
  pmMachines: Array<{ xrefId: number; id: number; name: string; manufacturer?: string; year?: number }>;
  formerMachines: Array<{ id: number; name: string; manufacturer?: string; year?: number; firstSeenAt: string; removedAt: string }>;
  ttMachineNames: string[];
}

interface VenueMachinesModalProps {
  venueId: number | null;
  onClose: () => void;
}

// Shared by VenuesPage (list) and VenuePage (detail) — both let you click a machine-count
// stat to see the full breakdown (played, also-on-Pinball-Map, formerly-here) for one venue.
export default function VenueMachinesModal({ venueId, onClose }: VenueMachinesModalProps) {
  const authApi = useApi();

  const { data: machinesData, isLoading: machinesLoading } = useQuery<VenueMachinesData>({
    queryKey: ['venue-machines', venueId],
    queryFn: () => authApi.venues.machines(venueId!),
    enabled: venueId != null,
  });

  if (venueId == null) return null;

  const ownNames = new Set((machinesData?.ownMachines ?? []).map(m => m.name.toLowerCase()));
  const pmMachinesExcludingOwn = (machinesData?.pmMachines ?? []).filter(m => !ownNames.has(m.name.toLowerCase()));
  const ttNamesLower = new Set((machinesData?.ttMachineNames ?? []).map(n => n.toLowerCase()));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Machines at</p>
            <h2 className="text-lg font-black uppercase tracking-wider text-venue leading-tight">
              {machinesData?.venue.name ?? '...'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto max-h-[60vh] p-6 flex flex-col gap-6">
          {machinesLoading ? (
            <p className="text-muted-foreground text-sm">Loading...</p>
          ) : (
            <>
              {/* Your scores */}
              {machinesData && machinesData.ownMachines.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                    Your scores here
                  </p>
                  <div className="flex flex-col gap-2">
                    {machinesData.ownMachines.map(m => (
                      <div
                        key={m.id}
                        className="flex flex-col gap-2 rounded-lg border border-white/10 bg-background px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-sm font-bold text-machine leading-snug min-w-0">{m.name}</span>
                          <span className="text-sm font-bold text-primary whitespace-nowrap flex-shrink-0">
                            {Number(m.bestScore).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs text-muted-foreground">
                            {[m.manufacturer, m.year].filter(Boolean).join(' · ') || ' '}
                          </span>
                          <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">
                            {m.playCount} {m.playCount === 1 ? 'play' : 'plays'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Pinball Map machines */}
              {pmMachinesExcludingOwn.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                      Also on Pinball Map
                    </p>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">
                      {pmMachinesExcludingOwn.length} machines
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {pmMachinesExcludingOwn.map(m => (
                      <div
                        key={m.xrefId}
                        className="flex flex-col gap-2 rounded-lg border border-machine/20 bg-machine/5 px-4 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <span className="text-sm font-bold text-machine leading-snug min-w-0">{m.name}</span>
                          {ttNamesLower.has(m.name.toLowerCase()) && (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <span title="In TiltTrack" className="text-xs px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-medium">TT</span>
                            </div>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {[m.manufacturer, m.year].filter(Boolean).join(' · ') || ' '}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Formerly here — inferred from Pinball Map's removal history */}
              {machinesData && machinesData.formerMachines.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
                    Formerly here
                  </p>
                  <div className="flex flex-col gap-2">
                    {machinesData.formerMachines.map(m => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between rounded-lg border border-white/10 bg-background/50 px-4 py-3 opacity-70"
                      >
                        <span className="text-sm font-bold text-muted-foreground">{m.name}</span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          left {format(new Date(m.removedAt), 'MMM yyyy')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {machinesData && machinesData.ownMachines.length === 0 && pmMachinesExcludingOwn.length === 0 && machinesData.formerMachines.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No machine data available</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
