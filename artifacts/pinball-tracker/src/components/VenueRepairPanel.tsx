import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wrench, MapPin, Link2, RefreshCw, Check, AlertTriangle, ExternalLink, ChevronDown, Search } from 'lucide-react';
import { useApi } from '../lib/useApi';
import ScoreResyncModal from './ScoreResyncModal';

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
}

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

// The recovery path for a venue the upload flow couldn't identify: resolve it in HERE, link it to
// Pinball Map, then re-sync the scores already logged against it. Only rendered when the caller is
// actually allowed to act — the /repair endpoint 403s otherwise and this collapses to nothing.
export default function VenueRepairPanel({ venueId }: { venueId: number }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [hereCandidates, setHereCandidates] = useState<HereCandidate[] | null>(null);
  const [pmCandidates, setPmCandidates] = useState<PmCandidate[] | null>(null);
  const [pmQuery, setPmQuery] = useState('');
  const [manualPmId, setManualPmId] = useState('');
  const [showResync, setShowResync] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const { data: status, isError } = useQuery<RepairStatus>({
    queryKey: ['venue-repair', venueId],
    queryFn: () => api.venues.repair.status(venueId),
    retry: false,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['venue-repair', venueId] });
    queryClient.invalidateQueries({ queryKey: ['venue-scores'] });
    queryClient.invalidateQueries({ queryKey: ['venue-machines', venueId] });
    queryClient.invalidateQueries({ queryKey: ['venues'] });
  }

  const resolveHere = useMutation({
    mutationFn: () => api.venues.repair.resolveHere(venueId),
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
      api.venues.repair.attachHere(venueId, { hereId: c.hereId!, latitude: c.latitude, longitude: c.longitude }),
    onSuccess: () => {
      setHereCandidates(null);
      setNotice({ kind: 'ok', text: 'HERE place linked.' });
      invalidate();
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Could not link that place' }),
  });

  const findPm = useMutation({
    mutationFn: (q: string) => api.venues.repair.pmCandidates(venueId, q || undefined),
    onSuccess: (res: any) => {
      setPmCandidates(res.candidates ?? []);
      if (!res.candidates?.length) {
        setNotice({ kind: 'err', text: `Pinball Map had no match for "${res.searchedFor}". Try the ID box below.` });
      } else {
        setNotice(null);
      }
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Pinball Map search failed' }),
  });

  const linkPm = useMutation({
    mutationFn: (pmId: number) => api.venues.repair.pmLink(venueId, pmId),
    onSuccess: (res: any) => {
      setPmCandidates(null);
      setManualPmId('');
      setNotice({ kind: 'ok', text: `Linked to "${res.pmLocation.name}" — ${res.machineCount} machines found.` });
      invalidate();
    },
    onError: (e: any) => setNotice({ kind: 'err', text: e.message ?? 'Could not link that location' }),
  });

  // 403 from the status endpoint means this user can't repair this venue — render nothing at all.
  if (isError || !status) return null;

  const hereDone = !!status.hereId;
  const pmDone = !!status.pinballMapId;
  const resyncScope = status.isAdmin ? status.scoreCount : status.myScoreCount;

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
          <StatusChip label="HERE" done={hereDone} />
          <StatusChip label="Pinball Map" done={pmDone} />
          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="border-t border-white/10 p-4 flex flex-col gap-5">
          {notice && (
            <p className={`text-sm rounded-lg px-3 py-2 ${notice.kind === 'ok' ? 'bg-primary/10 text-primary' : 'bg-amber-500/10 text-amber-400'}`}>
              {notice.text}
            </p>
          )}

          {!status.pmConfigured && (
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
          )}

          {/* Step 1 — HERE */}
          <section>
            <SectionHeading
              icon={<MapPin className="w-4 h-4" />}
              title="1 · Resolve in HERE"
              done={hereDone}
              detail={hereDone ? 'Linked' : status.address ? 'Not linked' : 'Add an address first'}
            />
            <p className="text-xs text-muted-foreground mb-3">
              {status.address ?? 'This venue has no address yet — edit it and add one, then run this.'}
            </p>
            <button
              onClick={() => resolveHere.mutate()}
              disabled={!status.address || resolveHere.isPending}
              className="text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
            >
              {resolveHere.isPending ? 'Searching HERE...' : hereDone ? 'Re-run HERE lookup' : 'Find in HERE'}
            </button>

            {hereCandidates && hereCandidates.length > 0 && (
              <ul className="mt-3 flex flex-col gap-2">
                {hereCandidates.map(c => (
                  <li key={c.hereId ?? c.name} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-background px-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-venue truncate">{c.name}</span>
                      <span className="block text-xs text-muted-foreground truncate">{c.address} · {c.distance}m</span>
                    </span>
                    <button
                      onClick={() => attachHere.mutate(c)}
                      disabled={!c.hereId || attachHere.isPending}
                      className="text-xs font-bold uppercase tracking-wider rounded border border-white/20 px-2 py-1 hover:bg-white/10 disabled:opacity-40 flex-shrink-0"
                    >
                      Use
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Step 2 — Pinball Map */}
          <section>
            <SectionHeading
              icon={<Link2 className="w-4 h-4" />}
              title="2 · Link Pinball Map"
              done={pmDone}
              detail={pmDone ? `#${status.pinballMapId} · ${status.pmMachineCount ?? '?'} machines` : 'Not linked'}
            />

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

            <div className="flex flex-wrap gap-2 mb-3">
              <input
                value={pmQuery}
                onChange={e => setPmQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') findPm.mutate(pmQuery); }}
                placeholder={status.name}
                className="flex-1 min-w-[10rem] text-sm rounded-lg bg-background border border-white/20 px-3 py-2 text-white placeholder:text-muted-foreground"
              />
              <button
                onClick={() => findPm.mutate(pmQuery)}
                disabled={!status.pmConfigured || findPm.isPending}
                className="flex items-center gap-1 text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
              >
                <Search className="w-3.5 h-3.5" />
                {findPm.isPending ? 'Searching...' : 'Search'}
              </button>
            </div>

            {pmCandidates && pmCandidates.length > 0 && (
              <ul className="flex flex-col gap-2 mb-3">
                {pmCandidates.map(c => (
                  <li key={c.pinballMapId} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-background px-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-venue truncate">{c.name}</span>
                      <span className="block text-xs text-muted-foreground truncate">
                        #{c.pinballMapId}
                        {c.address ? ` · ${c.address}` : ''}
                        {c.machineCount != null ? ` · ${c.machineCount} machines` : ''}
                      </span>
                    </span>
                    <button
                      onClick={() => linkPm.mutate(c.pinballMapId)}
                      disabled={linkPm.isPending}
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
                  number is the ID. (On a region page the venue's "Link to this location" share icon gives the same URL.)
                </p>
                <div className="flex gap-2">
                  <input
                    value={manualPmId}
                    onChange={e => setManualPmId(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="1234"
                    inputMode="numeric"
                    className="w-28 text-sm rounded-lg bg-background border border-white/20 px-3 py-2 text-white placeholder:text-muted-foreground"
                  />
                  <button
                    onClick={() => linkPm.mutate(Number(manualPmId))}
                    disabled={!manualPmId || !status.pmConfigured || linkPm.isPending}
                    className="text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
                  >
                    {linkPm.isPending ? 'Linking...' : 'Link'}
                  </button>
                </div>
              </div>
            </details>
          </section>

          {/* Step 3 — re-sync scores */}
          <section>
            <SectionHeading
              icon={<RefreshCw className="w-4 h-4" />}
              title="3 · Re-sync scores"
              done={false}
              detail={`${resyncScope} score${resyncScope === 1 ? '' : 's'} ${status.isAdmin ? 'at this venue' : 'of yours here'}`}
            />
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
          </section>
        </div>
      )}

      {showResync && (
        <ScoreResyncModal
          venueId={venueId}
          onClose={() => setShowResync(false)}
          onApplied={() => { invalidate(); setNotice({ kind: 'ok', text: 'Scores re-synced.' }); }}
        />
      )}
    </div>
  );
}

function StatusChip({ label, done }: { label: string; done: boolean }) {
  return (
    <span
      className={`hidden sm:inline-flex items-center gap-1 text-[0.65rem] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 border ${
        done ? 'border-primary/40 text-primary' : 'border-amber-500/40 text-amber-400'
      }`}
    >
      {done ? <Check className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
      {label}
    </span>
  );
}

function SectionHeading({ icon, title, done, detail }: { icon: React.ReactNode; title: string; done: boolean; detail: string }) {
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
