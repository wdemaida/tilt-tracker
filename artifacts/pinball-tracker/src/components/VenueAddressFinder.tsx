import { useState } from 'react';
import { Search, ExternalLink, AlertTriangle } from 'lucide-react';
import { HolderNote, MergeIntoButton } from './VenueLinkageSteps';
import type { LinkageView, LinkageActions, ManualAddress, PlaceChoice, LinkedVenueRef } from './VenueLinkageSteps';

// Step 1 for a venue with no address at all — typically typed in by name during upload with location
// services off. "Find in HERE" can't help (it geocodes the address the venue doesn't have), so this
// finds the place instead: by name in Pinball Map (whose listings carry full addresses and are the
// likeliest home for a pinball venue) and in HERE, optionally near a city; or by an address typed in
// by hand. Choosing one writes the address and coordinates, after which steps 2 and 3 work as usual.
//
// Every choice is confirmed before it's written: the flow only applies while the venue has no
// address, so a wrong pick can't be undone from here — only an admin's Edit Venue dialog can.

const EMPTY_MANUAL: ManualAddress = { street: '', city: '', state: '', postalCode: '', country: '' };

const inputCls =
  'text-sm rounded-lg bg-background border border-white/20 px-3 py-2 text-white placeholder:text-muted-foreground';
const smallBtn =
  'text-xs font-bold uppercase tracking-wider rounded border border-white/20 px-2 py-1 hover:bg-white/10 disabled:opacity-40 flex-shrink-0';

interface Pending { label: string; address: string; choice: PlaceChoice }

export default function VenueAddressFinder({
  status, actions, onMergeInto,
}: {
  status: LinkageView;
  actions: LinkageActions;
  /** When given, a candidate another public TiltTrack venue holds offers "Merge into …". */
  onMergeInto?: (venue: LinkedVenueRef) => void;
}) {
  const [q, setQ] = useState(status.name);
  const [near, setNear] = useState('');
  const [manual, setManual] = useState<ManualAddress>(EMPTY_MANUAL);
  const [pending, setPending] = useState<Pending | null>(null);

  const results = actions.placeResults;
  const busy = actions.resolvePlace.isPending;

  function search() {
    if (q.trim().length < 2) return;
    setPending(null);
    actions.searchPlace.mutate({ q: q.trim(), near: near.trim() });
  }

  function setField(k: keyof ManualAddress, v: string) {
    setManual(m => ({ ...m, [k]: v }));
    actions.setManualPreview(null); // any edit invalidates the preview
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        This venue has no address — it was probably added by name with location services off. Find
        it below; picking a Pinball Map listing fills in the address and sets up step 2 as well.
      </p>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') search(); }}
          placeholder="Venue name"
          aria-label="Venue name"
          className={`${inputCls} flex-1 min-w-0`}
        />
        <input
          value={near}
          onChange={e => setNear(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') search(); }}
          placeholder="City or address (optional)"
          aria-label="City or address (optional)"
          className={`${inputCls} flex-1 min-w-0`}
        />
        <button
          onClick={search}
          disabled={q.trim().length < 2 || actions.searchPlace.isPending}
          className="flex items-center justify-center gap-1 text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
        >
          <Search className="w-3.5 h-3.5" />
          {actions.searchPlace.isPending ? 'Searching...' : 'Search'}
        </button>
      </div>

      {results && (
        <div className="flex flex-col gap-3">
          {results.nearResolved && (
            <p className="text-xs text-muted-foreground">HERE searched near {results.nearResolved}.</p>
          )}

          <CandidateGroup title="Pinball Map" note={results.pmError}>
            {results.pm.map(c => (
              <CandidateRow
                key={`pm-${c.pinballMapId}`}
                name={c.name}
                address={c.address}
                extra={c.machineCount != null ? `${c.machineCount} machines` : null}
                href={c.url}
                linkedVenue={c.linkedVenue}
                linkedElsewhere={c.linkedElsewhere}
                linkedNote="already linked to"
                disabled={busy}
                // Pinball Map ids aren't unique, so Use stays available alongside Merge.
                onMerge={onMergeInto && c.linkedVenue ? () => onMergeInto(c.linkedVenue!) : undefined}
                onUse={() => setPending({ label: `${c.name} (Pinball Map #${c.pinballMapId})`, address: c.address, choice: { source: 'pm', pinballMapId: c.pinballMapId } })}
              />
            ))}
          </CandidateGroup>

          <CandidateGroup title="HERE" note={results.hereNote}>
            {results.here.map(c => (
              <CandidateRow
                key={`here-${c.hereId}`}
                name={c.name}
                address={c.address}
                extra={null}
                href={null}
                linkedVenue={c.linkedVenue}
                linkedElsewhere={c.linkedElsewhere}
                linkedNote="already used by"
                // hereId is unique across venues — the server would refuse this one with a 409, so a
                // taken place offers Merge (when its holder can be named) instead of Use.
                disabled={busy || c.linkedElsewhere}
                hideUseWhenMergeable
                onMerge={onMergeInto && c.linkedVenue ? () => onMergeInto(c.linkedVenue!) : undefined}
                onUse={() => setPending({ label: `${c.name} (HERE)`, address: c.address, choice: { source: 'here', hereId: c.hereId } })}
              />
            ))}
          </CandidateGroup>
        </div>
      )}

      {pending && (
        <ConfirmBox
          text={<>Set this venue’s address to <strong className="text-white">{pending.address}</strong>, from {pending.label}?</>}
          busy={busy}
          onConfirm={() => actions.resolvePlace.mutate(pending.choice, { onSuccess: () => setPending(null) })}
          onCancel={() => setPending(null)}
        />
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer hover:text-white transition-colors">Enter address manually</summary>
        <div className="mt-2 flex flex-col gap-2">
          <input value={manual.street} onChange={e => setField('street', e.target.value)} placeholder="Street address" aria-label="Street address" className={inputCls} />
          <div className="grid grid-cols-2 gap-2">
            <input value={manual.city} onChange={e => setField('city', e.target.value)} placeholder="City" aria-label="City" className={inputCls} />
            <input value={manual.state} onChange={e => setField('state', e.target.value)} placeholder="State / region" aria-label="State or region" className={inputCls} />
            <input value={manual.postalCode} onChange={e => setField('postalCode', e.target.value)} placeholder="Postal code" aria-label="Postal code" className={inputCls} />
            <input value={manual.country} onChange={e => setField('country', e.target.value)} placeholder="Country" aria-label="Country" className={inputCls} />
          </div>
          <div>
            <button
              onClick={() => actions.previewManual.mutate(manual)}
              disabled={!manual.street.trim() || !manual.city.trim() || actions.previewManual.isPending}
              title={!manual.street.trim() || !manual.city.trim() ? 'A street and a city are both needed' : undefined}
              className="text-sm font-bold uppercase tracking-wider rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10 disabled:opacity-40 transition-colors"
            >
              {actions.previewManual.isPending ? 'Checking...' : 'Check address'}
            </button>
          </div>

          {actions.manualPreview && (
            <ConfirmBox
              text={
                <>
                  HERE placed this at <strong className="text-white">{actions.manualPreview.label}</strong>.
                  {!actions.manualPreview.precise && (
                    <span className="flex items-start gap-1 mt-1 text-amber-400">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      That’s only an approximate match{actions.manualPreview.resultType ? ` (${actions.manualPreview.resultType})` : ''}, not
                      the building — check the street and number.
                    </span>
                  )}
                </>
              }
              busy={busy}
              // The server refuses an imprecise match unless told the user saw the warning above.
              confirmLabel={actions.manualPreview.precise ? 'Save this address' : 'Save approximate position'}
              onConfirm={() => actions.resolvePlace.mutate({
                source: 'manual', confirm: true, acceptImprecise: !actions.manualPreview!.precise, ...manual,
              })}
              onCancel={() => actions.setManualPreview(null)}
            />
          )}
        </div>
      </details>
    </div>
  );
}

function CandidateGroup({ title, note, children }: { title: string; note: string | null; children: React.ReactNode[] }) {
  return (
    <div>
      <p className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground mb-1">{title}</p>
      {children.length > 0 ? (
        <ul className="flex flex-col gap-2">{children}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">{note ?? 'No matches.'}</p>
      )}
      {children.length > 0 && note && <p className="text-xs text-muted-foreground mt-1">{note}</p>}
    </div>
  );
}

function CandidateRow({
  name, address, extra, href, linkedVenue, linkedElsewhere, linkedNote, disabled, onUse, onMerge, hideUseWhenMergeable,
}: {
  name: string;
  address: string;
  extra: string | null;
  href: string | null;
  linkedVenue: LinkedVenueRef | null;
  /** True for any holder, including a private venue the server won't name. */
  linkedElsewhere: boolean;
  linkedNote: string;
  disabled: boolean;
  onUse: () => void;
  /** Merge this venue into the candidate's holder (`linkedVenue`). */
  onMerge?: () => void;
  /** Show only Merge, not a disabled Use, when a merge is on offer. */
  hideUseWhenMergeable?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-background px-3 py-2">
      <span className="min-w-0">
        <span className="block text-sm font-bold text-venue">{name}</span>
        <span className="block text-xs text-muted-foreground">
          {address}
          {extra ? ` · ${extra}` : ''}
        </span>
        {href && (
          // Pinball Map's licence requires linking data shown for a location to that location's page.
          <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-venue hover:underline">
            View on Pinball Map <ExternalLink className="w-3 h-3" />
          </a>
        )}
        <HolderNote linkedVenue={linkedVenue} linkedElsewhere={linkedElsewhere} note={linkedNote} />
      </span>
      <span className="flex flex-col sm:flex-row gap-1.5 flex-shrink-0">
        {onMerge && linkedVenue && <MergeIntoButton venue={linkedVenue} onClick={onMerge} />}
        {!(onMerge && hideUseWhenMergeable) && (
          <button onClick={onUse} disabled={disabled} className={smallBtn}>Use</button>
        )}
      </span>
    </li>
  );
}

function ConfirmBox({
  text, confirmLabel = 'Confirm', busy, onConfirm, onCancel,
}: {
  text: React.ReactNode;
  confirmLabel?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs text-muted-foreground flex flex-col gap-2">
      <div>{text}</div>
      <div className="flex gap-2">
        <button onClick={onConfirm} disabled={busy} className={`${smallBtn} border-primary/50 text-primary`}>
          {busy ? 'Saving...' : confirmLabel}
        </button>
        <button onClick={onCancel} disabled={busy} className={smallBtn}>Cancel</button>
      </div>
    </div>
  );
}
