import { AlertTriangle, MapPin } from 'lucide-react';

/** One of the venues `POST /api/venues` matched when it answered 409 `duplicate_venue`. */
export interface DuplicateCandidate {
  id: number;
  name: string;
  address: string | null;
  /** Null when the new venue couldn't be geocoded — matched on name alone. */
  distance: number | null;
  /** Someone's private venue matched by exact name — name only, no address or distance. */
  isPrivate?: true;
}

/** The candidates on a thrown API error, when it's the duplicate-venue 409 — else null. */
export function duplicateCandidates(e: any): DuplicateCandidate[] | null {
  return e?.code === 'duplicate_venue' && e.body?.candidates?.length ? e.body.candidates : null;
}

interface Props {
  candidates: DuplicateCandidate[];
  busy?: boolean;
  /** "Use this one instead". */
  onUse: (c: DuplicateCandidate) => void;
  /** Re-send the create with `allowDuplicate: true`. */
  onCreateAnyway: () => void;
  /**
   * Which candidates can be used here (default: all). The challenge-locations card can't add a
   * stranger's private venue (the prefs PUT refuses it), so it shows those as plain text.
   */
  usable?: (c: DuplicateCandidate) => boolean;
}

// The duplicate-venue prompt every create-a-venue surface shows (frontend CLAUDE.md, "Duplicate
// venues"): the existing venues as "use this one instead" buttons, plus a "create it anyway" escape.
// Never a hard block — a chain's other branch is a real venue, not a duplicate. Shared by
// ScoreVenuePicker, AddScorePage's "Add a new venue" form and the challenge-locations card.
export default function DuplicateVenuePrompt({ candidates, busy = false, onUse, onCreateAnyway, usable = () => true }: Props) {
  const onlyPrivate = candidates.length === 1 && candidates[0].isPrivate;
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 flex flex-col gap-2">
      <p className="flex items-start gap-2 text-xs text-amber-400">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        {onlyPrivate ? (
          <span>A private venue named “{candidates[0].name}” exists — {usable(candidates[0]) ? 'log here, or create your own' : 'you can create your own'}.</span>
        ) : (
          <span>
            {candidates.length === 1 ? 'This venue looks like one you already have' : 'These venues look like the one you’re adding'}.
            Use the existing one, unless this really is a different place.
          </span>
        )}
      </p>
      <ul className="flex flex-col gap-1.5">
        {candidates.map(d => {
          const detail = d.isPrivate ? 'Private venue' : `${d.distance != null ? `${d.distance}m away` : 'same name'}${d.address ? ` · ${d.address}` : ''}`;
          const body = (
            <>
              <MapPin className="w-3.5 h-3.5 text-venue flex-shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-bold text-venue truncate">{d.name}</span>
                <span className="block text-[0.65rem] text-muted-foreground truncate">{detail}</span>
              </span>
            </>
          );
          return (
            <li key={d.id}>
              {usable(d) ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onUse(d)}
                  className="w-full flex items-center gap-2 text-left rounded border border-white/10 bg-card px-2.5 py-1.5 hover:bg-white/10 disabled:opacity-40 transition-colors"
                >
                  {body}
                </button>
              ) : (
                <div className="w-full flex items-center gap-2 rounded border border-white/10 bg-card px-2.5 py-1.5 opacity-70">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={busy}
        onClick={onCreateAnyway}
        className="self-start text-xs text-muted-foreground hover:text-white underline disabled:opacity-40 transition-colors"
      >
        {onlyPrivate ? 'Create my own venue' : 'No, this is a different venue — create it anyway'}
      </button>
    </div>
  );
}
