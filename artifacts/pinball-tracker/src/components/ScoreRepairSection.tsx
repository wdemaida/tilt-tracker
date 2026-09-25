import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { MapPin, ChevronDown, AlertTriangle, ArrowRight, ExternalLink } from 'lucide-react';
import { useApi } from '../lib/useApi';
import VenueLinkageSteps, {
  useVenueLinkageActions, StatusChip, CollapsibleSection, NoticeBanner, PmNotConfiguredWarning,
  type LinkageView,
} from './VenueLinkageSteps';
import { PinballIcon } from './PinballIcon';

interface Suggestion {
  pmName: string;
  pmManufacturer: string | null;
  pmYear: number | null;
  confidence: 'exact' | 'normalized' | 'fuzzy' | 'unmatched';
}

interface ScoreRepairStatus {
  scoreId: number;
  machineId: number;
  machineName: string;
  canRepairScore: boolean;
  pmConfigured: boolean;
  venue: {
    id: number;
    name: string;
    address: string | null;
    hereId: string | null;
    pinballMapId: number | null;
    pmLocationUrl: string | null;
    needsAddress?: boolean;
  } | null;
  venueNameSnapshot: string | null;
  canRepairVenue: boolean;
  suggestions: Suggestion[] | null;
  rosterCount: number;
  pmError: string | null;
}

interface Props {
  scoreId: number;
  /** Called after this score's machine changes, so the modal can resync its own form state. */
  onMachineRepaired: (machineName: string) => void;
}

// Venue + linkage state for one score, inside the edit-score modal. Steps 1 and 2 are the same
// component the venue page uses; step 3 differs — here it repairs just this score's machine, which
// is the unit someone editing a single score actually cares about.
//
// Machine repair stays locked until the venue resolves to a Pinball Map location, because until then
// there is no roster to check the machine name against and any suggestion would be a guess.
export default function ScoreRepairSection({ scoreId, onMachineRepaired }: Props) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const { data: status, isError } = useQuery<ScoreRepairStatus>({
    queryKey: ['score-repair', scoreId],
    queryFn: () => api.scores.repair.status(scoreId),
    retry: false,
  });

  const actions = useVenueLinkageActions(status?.venue?.id ?? null);

  const repairMachine = useMutation({
    mutationFn: (s: Suggestion) =>
      api.scores.repair.machine(scoreId, { pmName: s.pmName, pmManufacturer: s.pmManufacturer, pmYear: s.pmYear }),
    onSuccess: (res: any) => {
      setPicked(null);
      actions.setNotice({
        kind: 'ok',
        text: res.changed
          ? `Machine set to "${res.machineName}"${res.previousRetired ? ' — the duplicate row was removed.' : '.'}`
          : 'That was already the machine on this score.',
      });
      queryClient.invalidateQueries({ queryKey: ['score-repair', scoreId] });
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      onMachineRepaired(res.machineName);
    },
    onError: (e: any) => actions.setNotice({ kind: 'err', text: e.message ?? 'Could not repair this score' }),
  });

  if (isError || !status) return null;

  const hereDone = !!status.venue?.hereId;
  const pmDone = !!status.venue?.pinballMapId;
  // Machine matching reads Pinball Map's roster; HERE is venue identity and plays no part in it.
  // Gating this on HERE too would lock the step on the 30 seed-script venues that match fine.
  const canMatchMachine = pmDone;

  // Defensive only: the edit modal renders ScoreVenuePicker instead of this component when the score
  // has no venue, so this is reached only if the venue vanished between the list load and this fetch.
  if (!status.venue) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
        <p className="flex items-start gap-2 text-xs text-amber-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>
            No venue is attached to this score
            {status.venueNameSnapshot ? ` (it was logged as "${status.venueNameSnapshot}")` : ''}.
            Close and reopen this score to attach one.
          </span>
        </p>
      </div>
    );
  }

  const linkage: LinkageView = {
    venueId: status.venue.id,
    name: status.venue.name,
    address: status.venue.address,
    hereId: status.venue.hereId,
    pinballMapId: status.venue.pinballMapId,
    pmLocationUrl: status.venue.pmLocationUrl,
    pmConfigured: status.pmConfigured,
    canRepair: status.canRepairVenue,
    needsAddress: !!status.venue.needsAddress,
  };

  const suggestions = status.suggestions ?? [];
  const recommended = suggestions.find(s => s.confidence !== 'unmatched') ?? null;
  const machineLooksRight = recommended?.confidence === 'exact';

  return (
    <div className="rounded-lg border border-white/10 bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-white/5 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" />
          <Link
            href={`/venues/${status.venue.id}`}
            onClick={e => e.stopPropagation()}
            className="text-sm font-bold text-venue truncate hover:text-venue/80 transition-colors"
          >
            {status.venue.name}
          </Link>
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          <StatusChip label="HERE" done={hereDone} tone="info" />
          <StatusChip label="PM" done={pmDone} />
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {!open && !pmDone && (
        <p className="px-3 pb-2.5 text-xs text-amber-400">
          Not linked to Pinball Map — this machine can't be verified.
        </p>
      )}

      {open && (
        <div className="border-t border-white/10 p-3 flex flex-col gap-4">
          {/* These actions hit their own endpoints and take effect straight away — they are not part
              of the form's Save. Worth saying, because the obvious assumption is the opposite. */}
          <p className="text-xs text-muted-foreground">
            Changes here apply immediately — you don’t need to hit Save.
          </p>
          <NoticeBanner notice={actions.notice} />
          {!status.pmConfigured && <PmNotConfiguredWarning />}

          {status.canRepairVenue ? (
            <VenueLinkageSteps status={linkage} actions={actions} />
          ) : (
            // The score's author isn't necessarily the venue's creator — you can log a score at a
            // venue someone else added. Show the state, but don't offer controls that would 403.
            <p className="flex items-start gap-2 text-xs rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                You didn't add this venue, so you can't change its linkage. Ask an admin, or whoever
                added it, to repair it from the{' '}
                <Link href={`/venues/${status.venue.id}`} className="underline">venue page</Link>.
              </span>
            </p>
          )}

          {/* Step 3 — fix this one score's machine. Gated on the venue being fully resolved. */}
          <CollapsibleSection
            icon={<PinballIcon className="w-4 h-4" />}
            title="3 · Fix this machine"
            done={machineLooksRight}
            detail={
              !canMatchMachine ? 'Locked'
                : status.pmError ? 'Pinball Map unreachable'
                : machineLooksRight ? 'Matches Pinball Map'
                : `${status.rosterCount} machines here`
            }
          >
            {!canMatchMachine ? (
              <p className="text-xs text-muted-foreground">
                Link Pinball Map first — the machine can only be checked against a venue Pinball Map
                knows about.
              </p>
            ) : status.pmError ? (
              <p className="text-xs text-amber-400">{status.pmError}</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-2">
                  Logged as <span className="text-white font-bold">{status.machineName}</span>
                  {machineLooksRight
                    ? ' — this already matches Pinball Map.'
                    : recommended
                      ? ' — closest match on this venue’s roster:'
                      : ' — no close match on this venue’s roster. Pick the right machine:'}
                </p>

                {recommended && !machineLooksRight && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 mb-2">
                    <span className="flex flex-wrap items-center gap-2 text-sm min-w-0">
                      <span className="text-white font-bold">{status.machineName}</span>
                      <ArrowRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-machine font-bold">{recommended.pmName}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => repairMachine.mutate(recommended)}
                      disabled={repairMachine.isPending}
                      className="text-xs font-bold uppercase tracking-wider rounded border border-primary/50 text-primary px-2 py-1 hover:bg-primary/10 disabled:opacity-40 flex-shrink-0"
                    >
                      {repairMachine.isPending ? 'Fixing...' : 'Use this'}
                    </button>
                  </div>
                )}

                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-white transition-colors">
                    {recommended && !machineLooksRight ? 'Pick a different machine' : 'Choose from the roster'}
                  </summary>
                  <ul className="mt-2 flex flex-col gap-1.5 max-h-52 overflow-y-auto">
                    {suggestions.map(s => (
                      <li key={s.pmName} className="flex items-center justify-between gap-3 rounded border border-white/10 bg-card px-2.5 py-1.5">
                        <span className="min-w-0">
                          <span className={`block text-sm font-bold truncate ${picked === s.pmName ? 'text-primary' : 'text-machine'}`}>
                            {s.pmName}
                          </span>
                          {(s.pmManufacturer || s.pmYear) && (
                            <span className="block text-[0.65rem] text-muted-foreground truncate">
                              {[s.pmManufacturer, s.pmYear].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setPicked(s.pmName); repairMachine.mutate(s); }}
                          disabled={repairMachine.isPending}
                          className="text-[0.65rem] font-bold uppercase tracking-wider rounded border border-white/20 px-2 py-1 hover:bg-white/10 disabled:opacity-40 flex-shrink-0"
                        >
                          Use
                        </button>
                      </li>
                    ))}
                    {suggestions.length === 0 && (
                      <li className="text-xs text-muted-foreground py-1">
                        Pinball Map lists no machines at this location.
                      </li>
                    )}
                  </ul>
                </details>

                {status.venue.pmLocationUrl && (
                  <a
                    href={status.venue.pmLocationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground hover:text-venue transition-colors"
                  >
                    Machine data from Pinball Map — update this listing
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </>
            )}
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
}
