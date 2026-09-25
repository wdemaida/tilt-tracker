import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Wrench, RefreshCw, ChevronDown } from 'lucide-react';
import { useApi } from '../lib/useApi';
import ScoreResyncModal from './ScoreResyncModal';
import VenueMergeModal from './VenueMergeModal';
import VenueLinkageSteps, {
  useVenueLinkageActions, StatusChip, CollapsibleSection, NoticeBanner, PmNotConfiguredWarning, MergeIntoButton,
  type LinkageView, type LinkedVenueRef,
} from './VenueLinkageSteps';

interface RepairStatus {
  venueId: number;
  name: string;
  address: string | null;
  hereId: string | null;
  pinballMapId: number | null;
  pmMachineCount: number | null;
  pmLocationUrl: string | null;
  pmConfigured: boolean;
  isAdmin: boolean;
  scoreCount: number;
  myScoreCount: number;
  isResidence?: boolean;
  needsAddress?: boolean;
  linkageBlocked?: boolean;
}

// The recovery path for a venue the upload flow couldn't identify. Steps 1 and 2 are shared with the
// edit-score modal (see VenueLinkageSteps); step 3 here is the bulk re-sync of every score at this
// venue, which is the unit that makes sense on a venue page. Only rendered when the caller is
// actually allowed to act — /repair 403s otherwise and this collapses to nothing.
export default function VenueRepairPanel({ venueId }: { venueId: number }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [showResync, setShowResync] = useState(false);
  /** The venue this one is being merged into (the merge preview modal is open while set). */
  const [mergeTarget, setMergeTarget] = useState<LinkedVenueRef | null>(null);
  const [, navigate] = useLocation();

  const { data: status, isError } = useQuery<RepairStatus>({
    queryKey: ['venue-repair', venueId],
    queryFn: () => api.venues.repair.status(venueId),
    retry: false,
  });

  const actions = useVenueLinkageActions(venueId);

  // An address-less venue is broken in a way worth surfacing unasked: open the panel once when the
  // status first says so (the Venues page's "Needs address" badge lands here). Only once — closing
  // it again must stick.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (status?.needsAddress && !autoOpened.current) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [status?.needsAddress]);

  // 403 from the status endpoint means this user can't repair this venue — render nothing at all.
  if (isError || !status) return null;

  const hereDone = !!status.hereId;
  const pmDone = !!status.pinballMapId;
  const resyncScope = status.isAdmin ? status.scoreCount : status.myScoreCount;

  const linkage: LinkageView = {
    venueId: status.venueId,
    name: status.name,
    address: status.address,
    hereId: status.hereId,
    pinballMapId: status.pinballMapId,
    pmLocationUrl: status.pmLocationUrl,
    pmConfigured: status.pmConfigured,
    canRepair: true,
    needsAddress: !!status.needsAddress,
    linkageBlocked: !!status.linkageBlocked,
  };

  return (
    <div className="mb-6 rounded-xl border border-white/10 bg-card overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/5 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-muted-foreground">
          <Wrench className="w-4 h-4" />
          Venue linkage
        </span>
        <span className="flex items-center gap-2">
          {status.needsAddress && <StatusChip label="Needs address" done={false} />}
          <span className="hidden sm:flex items-center gap-2">
            <StatusChip label="HERE" done={hereDone} tone="info" />
            <StatusChip label="Pinball Map" done={pmDone} />
          </span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="border-t border-white/10 p-4 flex flex-col gap-5">
          <NoticeBanner notice={actions.notice} />
          {actions.duplicateOffers.length > 0 && (
            <ul className="flex flex-col gap-2">
              {actions.duplicateOffers.map(d => (
                <li key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-background px-3 py-2">
                  <span className="text-xs text-muted-foreground min-w-0">
                    Same place as <span className="font-bold text-venue">“{d.name}”</span>? Merge this venue into it —
                    its scores move there and this one is removed.
                  </span>
                  <MergeIntoButton venue={d} onClick={() => setMergeTarget(d)} />
                </li>
              ))}
            </ul>
          )}
          {!status.pmConfigured && <PmNotConfiguredWarning />}

          <VenueLinkageSteps status={linkage} actions={actions} onMergeInto={setMergeTarget} />

          {/* Step 3 — bulk re-sync, the venue-page-specific action. No "done" state to collapse on —
              a re-sync is always available — but it stays collapsible to match the steps above. */}
          <CollapsibleSection
            icon={<RefreshCw className="w-4 h-4" />}
            title="3 · Re-sync scores"
            done={false}
            detail={`${resyncScope} score${resyncScope === 1 ? '' : 's'} ${status.isAdmin ? 'at this venue' : 'of yours here'}`}
          >
            <p className="text-xs text-muted-foreground mb-3">
              Matches each score's machine against Pinball Map's roster for this location and fills in
              manufacturer and year. You approve every rename before anything changes.
            </p>
            <button
              onClick={() => setShowResync(true)}
              disabled={!pmDone || !status.pmConfigured}
              className="text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
            >
              Preview re-sync
            </button>
            {!pmDone && (
              <p className="text-xs text-muted-foreground mt-2">Link Pinball Map first.</p>
            )}
          </CollapsibleSection>
        </div>
      )}

      {showResync && (
        <ScoreResyncModal
          venueId={venueId}
          onClose={() => setShowResync(false)}
          onApplied={() => { actions.invalidate(); actions.setNotice({ kind: 'ok', text: 'Scores re-synced.' }); }}
        />
      )}

      {mergeTarget && (
        <VenueMergeModal
          sourceVenueId={venueId}
          target={mergeTarget}
          onClose={() => setMergeTarget(null)}
          // This venue no longer exists — carry on at the one it was merged into.
          onMerged={res => { setMergeTarget(null); navigate(`/venues/${res.targetId}`); }}
        />
      )}
    </div>
  );
}
