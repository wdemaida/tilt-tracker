import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MapPin, Link2, Check, AlertTriangle, Minus, ExternalLink, Search, ChevronDown } from 'lucide-react';
import { useApi } from '../lib/useApi';
import VenueAddressFinder from './VenueAddressFinder';

// The HERE and Pinball Map linking steps, shared by the venue page's repair panel and the
// edit-score modal. Both surfaces need identical behaviour for steps 1 and 2 and differ only in
// what step 3 does — bulk re-sync of every score at the venue, versus fixing one score's machine —
// so step 3 stays with the caller and this owns everything before it.

/** The linkage state both callers can produce, from /venues/:id/repair or /scores/:id/repair. */
export interface LinkageView {
  venueId: number;
  name: string;
  address: string | null;
  hereId: string | null;
  pinballMapId: number | null;
  pmLocationUrl: string | null;
  pmConfigured: boolean;
  /** Whether this user may repair the venue (admin, owner, or the venue's creator). */
  canRepair: boolean;
  /**
   * The venue has no address and isn't a residence, so step 1 becomes a place search (see
   * VenueAddressFinder) instead of "Find in HERE", which needs an address to start from.
   */
  needsAddress?: boolean;
  /**
   * A restricted-tier (private) venue: the server refuses HERE / Pinball Map linkage for it, since
   * either id would publish its location. Steps 1 and 2 show why instead of offering buttons.
   */
  linkageBlocked?: boolean;
}

export interface LinkedVenueRef { id: number; name: string }

/**
 * Another TiltTrack venue already holds this id. `linkedVenue` names it only when it's public;
 * a private one (a residence) is reported by `linkedElsewhere` alone.
 */
export interface HolderInfo { linkedVenue: LinkedVenueRef | null; linkedElsewhere: boolean }

export interface PlaceSearchResult {
  query: string;
  near: string | null;
  nearResolved: string | null;
  pm: Array<{
    pinballMapId: number; name: string; address: string; latitude: number; longitude: number;
    machineCount: number | null; url: string;
  } & HolderInfo>;
  here: Array<{
    hereId: string; name: string; address: string; latitude: number; longitude: number;
  } & HolderInfo>;
  pmError: string | null;
  hereNote: string | null;
}

export interface ManualAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface ManualPreview {
  query: string;
  label: string;
  latitude: number;
  longitude: number;
  resultType: string | null;
  precise: boolean;
}

export type PlaceChoice =
  | { source: 'pm'; pinballMapId: number }
  | { source: 'here'; hereId: string }
  | ({ source: 'manual'; confirm: true; acceptImprecise?: boolean } & ManualAddress);

interface HereCandidate {
  name: string;
  address: string;
  distance: number;
  hereId: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface PmCandidate {
  pinballMapId: number;
  name: string;
  address: string;
  machineCount: number | null;
  distance: number | null;
  url: string;
}

export type Notice = { kind: 'ok' | 'err'; text: string } | null;

/**
 * Mutations and transient candidate state for the two linking steps. Deliberately does not fetch the
 * status itself — the venue page and the edit-score modal each already load it as part of a larger
 * payload, and refetching it here would double the requests on both.
 */
export function useVenueLinkageActions(venueId: number | null, onChanged?: () => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const [hereCandidates, setHereCandidates] = useState<HereCandidate[] | null>(null);
  const [pmCandidates, setPmCandidates] = useState<PmCandidate[] | null>(null);
  const [pmQuery, setPmQuery] = useState('');
  const [manualPmId, setManualPmId] = useState('');

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['venue-repair', venueId] });
    queryClient.invalidateQueries({ queryKey: ['score-repair'] });
    queryClient.invalidateQueries({ queryKey: ['venue-scores'] });
    queryClient.invalidateQueries({ queryKey: ['venue-machines', venueId] });
    queryClient.invalidateQueries({ queryKey: ['venues'] });
    queryClient.invalidateQueries({ queryKey: ['scores'] });
    onChanged?.();
  }

  const resolveHere = useMutation({
    mutationFn: () => api.venues.repair.resolveHere(venueId!),
    onSuccess: (res: any) => {
      setHereCandidates(res.candidates ?? []);
      setNotice(res.attached
        ? { kind: 'ok', text: `Matched "${res.attached.name}" in HERE (${res.attached.distance}m away).` }
        : { kind: 'err', text: res.candidates?.length ? 'No single confident match — pick one below.' : 'HERE returned nothing near this address.' });
      invalidate();
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'HERE lookup failed' }),
  });

  const attachHere = useMutation({
    mutationFn: (c: HereCandidate) =>
      api.venues.repair.attachHere(venueId!, { hereId: c.hereId!, latitude: c.latitude, longitude: c.longitude }),
    onSuccess: () => {
      setHereCandidates(null);
      setNotice({ kind: 'ok', text: 'HERE place linked.' });
      invalidate();
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Could not link that place' }),
  });

  const findPm = useMutation({
    mutationFn: (q: string) => api.venues.repair.pmCandidates(venueId!, q || undefined),
    onSuccess: (res: any) => {
      setPmCandidates(res.candidates ?? []);
      setNotice(res.candidates?.length
        ? null
        : { kind: 'err', text: `Pinball Map had no match for "${res.searchedFor}". Try the ID box below.` });
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Pinball Map search failed' }),
  });

  const linkPm = useMutation({
    mutationFn: (pmId: number) => api.venues.repair.pmLink(venueId!, pmId),
    onSuccess: (res: any) => {
      setPmCandidates(null);
      setManualPmId('');
      setPmPreselectedId(null);
      setNotice({ kind: 'ok', text: `Linked to "${res.pmLocation.name}" — ${res.machineCount} machines found.` });
      invalidate();
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Could not link that location' }),
  });

  // --- Address-less venues (step 1 when LinkageView.needsAddress) ---------------------------------
  const [placeResults, setPlaceResults] = useState<PlaceSearchResult | null>(null);
  const [manualPreview, setManualPreview] = useState<ManualPreview | null>(null);
  /** The Pinball Map listing picked as the venue's address, offered first in step 2. */
  const [pmPreselectedId, setPmPreselectedId] = useState<number | null>(null);

  const searchPlace = useMutation({
    mutationFn: ({ q, near }: { q: string; near: string }) => api.venues.repair.placeSearch(venueId!, q, near || undefined),
    onSuccess: (res: PlaceSearchResult) => {
      setPlaceResults(res);
      setNotice(res.pm.length || res.here.length
        ? null
        : { kind: 'err', text: `Nothing found for "${res.query}"${res.near ? ` near ${res.near}` : ''}. Try another spelling, add a city, or enter the address by hand.` });
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Search failed' }),
  });

  const previewManual = useMutation({
    mutationFn: (addr: ManualAddress) => api.venues.repair.resolvePlace(venueId!, { source: 'manual', ...addr }),
    onSuccess: (res: any) => { setManualPreview(res.preview ?? null); setNotice(null); },
    onError: (e: any) => { setManualPreview(null); setNotice({ kind: 'err', text: e.message ?? 'HERE could not find that address' }); },
  });

  const resolvePlace = useMutation({
    mutationFn: (choice: PlaceChoice) => api.venues.repair.resolvePlace(venueId!, choice),
    onSuccess: (res: any) => {
      setPlaceResults(null);
      setManualPreview(null);
      if (res.pmPreselect) {
        // Step 2 opens with the listing already offered; linking stays one explicit click.
        setPmCandidates([res.pmPreselect]);
        setPmPreselectedId(res.pmPreselect.pinballMapId);
      }
      const dupes: LinkedVenueRef[] = res.possibleDuplicates ?? [];
      const parts = [`Address set: ${res.venue?.address ?? 'saved'}.`];
      if (res.attachedHere) parts.push(`Matched "${res.attachedHere.name}" in HERE.`);
      if (res.pmPreselect) parts.push('Now link it to Pinball Map below.');
      if (dupes.length) {
        parts.push(`Heads up: TiltTrack already has ${dupes.map(d => `"${d.name}" (#${d.id})`).join(', ')} at this spot — this may be a duplicate venue.`);
      } else if (res.privateDuplicate) {
        parts.push('Heads up: another TiltTrack venue already matches this place — this may be a duplicate.');
      }
      const warn = dupes.length > 0 || !!res.privateDuplicate;
      setNotice({ kind: warn ? 'err' : 'ok', text: parts.join(' ') });
      invalidate();
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Could not set the address' }),
  });

  return {
    notice, setNotice,
    hereCandidates, pmCandidates,
    pmQuery, setPmQuery, manualPmId, setManualPmId,
    resolveHere, attachHere, findPm, linkPm, invalidate,
    placeResults, manualPreview, setManualPreview, pmPreselectedId,
    searchPlace, previewManual, resolvePlace,
  };
}

export type LinkageActions = ReturnType<typeof useVenueLinkageActions>;

/**
 * `tone` decides how loud an *unlinked* service looks.
 *
 * Pinball Map is `critical` — without it there's no machine roster, so the feature genuinely can't
 * work. HERE is `info`: it's venue identity and de-duplication, and nothing about machine matching
 * depends on it. 30 venues came from the seed script with no HERE id and work fine, so painting them
 * amber would train the eye to ignore the chip by the time it means something.
 */
const DISABLED_REASON = 'Pinball Map isn’t configured on the server — PINBALL_MAP_API_TOKEN is unset.';

function DisabledReason({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="text-xs text-amber-400/80 mb-3">
      Greyed out because Pinball Map isn’t configured on the server yet — nothing to do with this
      record, and saving won’t change it.
    </p>
  );
}

export function StatusChip({ label, done, tone = 'critical' }: { label: string; done: boolean; tone?: 'critical' | 'info' }) {
  const missingCls = tone === 'critical' ? 'border-amber-500/40 text-amber-400' : 'border-white/20 text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center gap-1 text-[0.65rem] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border ${
        done ? 'border-primary/40 text-primary' : missingCls
      }`}
    >
      {done ? <Check className="w-3 h-3" /> : tone === 'critical' ? <AlertTriangle className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
      {label}
    </span>
  );
}

export function SectionHeading({ icon, title, done, detail }: { icon: React.ReactNode; title: string; done: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-2">
      <span className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white">
        {icon}
        {title}
      </span>
      <span className={`text-xs font-bold ${done ? 'text-primary' : 'text-muted-foreground'}`}>{detail}</span>
    </div>
  );
}

/**
 * A step that folds itself away once it's satisfied. Three stacked steps is a lot of panel for
 * something that is usually already correct — collapsing the settled ones leaves only the step that
 * still wants attention open, while the heading keeps showing its status so nothing is hidden.
 *
 * `done` drives the state rather than just seeding it: linking Pinball Map should close that step
 * then and there, and un-linking should bring it back, without the reader hunting for the chevron.
 */
export function CollapsibleSection({
  icon, title, done, detail, children,
}: {
  icon: React.ReactNode;
  title: string;
  done: boolean;
  detail: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!done);
  const lastDone = useRef(done);
  useEffect(() => {
    if (done !== lastDone.current) {
      lastDone.current = done;
      setOpen(!done);
    }
  }, [done]);

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 mb-2 group"
      >
        <span className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white">
          {icon}
          {title}
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`text-xs font-bold ${done ? 'text-primary' : 'text-muted-foreground'}`}>{detail}</span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-muted-foreground group-hover:text-white transition-all ${open ? 'rotate-180' : ''}`}
          />
        </span>
      </button>
      {open && children}
    </section>
  );
}

export function NoticeBanner({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p className={`text-sm rounded-lg px-3 py-2 ${notice.kind === 'ok' ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-400'}`}>
      {notice.text}
    </p>
  );
}

export function PmNotConfiguredWarning() {
  return (
    <p className="flex items-start gap-2 text-sm rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>
        Pinball Map is not configured on the server — <code>PINBALL_MAP_API_TOKEN</code> is unset.
        Request a key at{' '}
        <a href="https://pinballmap.com/api_token" target="_blank" rel="noreferrer" className="underline">
          pinballmap.com/api_token
        </a>.
      </span>
    </p>
  );
}

export default function VenueLinkageSteps({ status, actions }: { status: LinkageView; actions: LinkageActions }) {
  const hereDone = !!status.hereId;
  const pmDone = !!status.pinballMapId;

  if (status.linkageBlocked) {
    return (
      <p className="flex items-start gap-2 text-xs rounded-lg bg-white/5 text-muted-foreground px-3 py-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          This venue’s address is private, so it isn’t linked to HERE or Pinball Map — either link
          would publish where it is. Machine matching against a Pinball Map roster isn’t available here.
        </span>
      </p>
    );
  }

  return (
    <>
      {/* Step 1 — HERE */}
      <CollapsibleSection
        icon={<MapPin className="w-4 h-4" />}
        title="1 · Resolve in HERE"
        done={hereDone}
        detail={hereDone ? 'Linked' : status.address ? 'Optional — not linked' : status.needsAddress ? 'Needs address' : 'Add an address first'}
      >
        {status.needsAddress ? (
          <VenueAddressFinder status={status} actions={actions} />
        ) : (
        <>
        <p className="text-xs text-muted-foreground mb-3">
          {status.address ?? 'This venue has no address yet — edit it and add one, then run this.'}
          {!hereDone && status.address && (
            <span className="block mt-1 opacity-80">
              Identifies the venue and stops duplicates on future uploads. Machine matching doesn’t need it.
            </span>
          )}
        </p>
        <button
          onClick={() => actions.resolveHere.mutate()}
          disabled={!status.address || actions.resolveHere.isPending}
          className="text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
        >
          {actions.resolveHere.isPending ? 'Searching HERE...' : hereDone ? 'Re-run HERE lookup' : 'Find in HERE'}
        </button>

        {actions.hereCandidates && actions.hereCandidates.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {actions.hereCandidates.map(c => (
              <li key={c.hereId ?? c.name} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-background px-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-venue truncate">{c.name}</span>
                  <span className="block text-xs text-muted-foreground truncate">{c.address} · {c.distance}m</span>
                </span>
                <button
                  onClick={() => actions.attachHere.mutate(c)}
                  disabled={!c.hereId || actions.attachHere.isPending}
                  className="text-xs font-bold uppercase tracking-wider rounded border border-white/20 px-2 py-1 hover:bg-white/10 disabled:opacity-40 flex-shrink-0"
                >
                  Use
                </button>
              </li>
            ))}
          </ul>
        )}
        </>
        )}
      </CollapsibleSection>

      {/* Step 2 — Pinball Map */}
      <CollapsibleSection
        icon={<Link2 className="w-4 h-4" />}
        title="2 · Link Pinball Map"
        done={pmDone}
        detail={pmDone ? `#${status.pinballMapId}` : 'Not linked'}
      >

        {pmDone && status.pmLocationUrl && (
          <a
            href={status.pmLocationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-venue hover:underline mb-3"
          >
            View on Pinball Map <ExternalLink className="w-3 h-3" />
          </a>
        )}

        <p className="text-xs text-muted-foreground mb-2">
          Leave blank to search Pinball Map near this venue’s coordinates, or type a name to search
          theirs directly — useful when their listing is named differently from ours.
        </p>
        <div className="flex flex-wrap gap-2 mb-2">
          <input
            value={actions.pmQuery}
            onChange={e => actions.setPmQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && status.pmConfigured) actions.findPm.mutate(actions.pmQuery); }}
            placeholder={`${status.name} (blank = search nearby)`}
            disabled={!status.pmConfigured}
            className="flex-1 min-w-[10rem] text-sm rounded-lg bg-background border border-white/20 px-3 py-2 text-white placeholder:text-muted-foreground disabled:opacity-50"
          />
          <button
            onClick={() => actions.findPm.mutate(actions.pmQuery)}
            disabled={!status.pmConfigured || actions.findPm.isPending}
            title={!status.pmConfigured ? DISABLED_REASON : undefined}
            className="flex items-center gap-1 text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
            {actions.findPm.isPending ? 'Searching...' : 'Search'}
          </button>
        </div>
        <DisabledReason show={!status.pmConfigured} />

        {actions.pmCandidates && actions.pmCandidates.length > 0 && (
          <ul className="flex flex-col gap-2 mb-3">
            {actions.pmCandidates.map(c => (
              <li
                key={c.pinballMapId}
                className={`flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2 ${
                  c.pinballMapId === actions.pmPreselectedId ? 'border-primary/50' : 'border-white/10'
                }`}
              >
                <span className="min-w-0">
                  {c.pinballMapId === actions.pmPreselectedId && (
                    <span className="block text-[0.65rem] font-bold uppercase tracking-wider text-primary">
                      The listing you picked in step 1
                    </span>
                  )}
                  <span className="block text-sm font-bold text-venue truncate">{c.name}</span>
                  <span className="block text-xs text-muted-foreground truncate">
                    #{c.pinballMapId}
                    {c.address ? ` · ${c.address}` : ''}
                    {c.machineCount != null ? ` · ${c.machineCount} machines` : ''}
                  </span>
                </span>
                <button
                  onClick={() => actions.linkPm.mutate(c.pinballMapId)}
                  disabled={actions.linkPm.isPending}
                  className="text-xs font-bold uppercase tracking-wider rounded border border-white/20 px-2 py-1 hover:bg-white/10 disabled:opacity-40 flex-shrink-0"
                >
                  Link
                </button>
              </li>
            ))}
          </ul>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-white transition-colors">
            Enter a Pinball Map ID manually
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="leading-relaxed">
              On <a href="https://pinballmap.com" target="_blank" rel="noreferrer" className="text-venue underline">pinballmap.com</a>,
              find the venue and click its name in the list. The address bar becomes{' '}
              <code className="text-white">pinballmap.com/map?by_location_id=<strong>1234</strong></code> — that
              number is the ID.
            </p>
            <div className="flex gap-2">
              <input
                value={actions.manualPmId}
                onChange={e => actions.setManualPmId(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="1234"
                inputMode="numeric"
                className="w-28 text-sm rounded-lg bg-background border border-white/20 px-3 py-2 text-white placeholder:text-muted-foreground"
              />
              <button
                onClick={() => actions.linkPm.mutate(Number(actions.manualPmId))}
                disabled={!actions.manualPmId || !status.pmConfigured || actions.linkPm.isPending}
                title={!status.pmConfigured ? DISABLED_REASON : !actions.manualPmId ? 'Enter a Pinball Map location ID first' : undefined}
                className="text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
              >
                {actions.linkPm.isPending ? 'Linking...' : 'Link'}
              </button>
            </div>
            <DisabledReason show={!status.pmConfigured} />
          </div>
        </details>
      </CollapsibleSection>
    </>
  );
}
