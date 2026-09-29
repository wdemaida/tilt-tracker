import { useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { MachineThumb } from './ChallengeParts';

// Search TiltTrack's machines and pick one — the challenge create form's machine step and the
// "Challenge me on" editor on your profile. Without a query it lists the machines you've played,
// most recent first. Only machines someone has logged a score on exist here.

export interface MachineOption {
  id: number; name: string; imageUrl: string | null;
  manufacturer?: string | null; year?: number | null; bestScore?: number | null; lastPlayed?: string | null;
}

/** Any word of the query appears in the name, punctuation-insensitive. */
export function nameMatches(name: string, q: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const hay = norm(name);
  return norm(q).split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}

export const pickerInputClass = 'w-full rounded-lg border border-white/10 bg-background px-3 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-friend/60';

export default function MachinePicker({ allMachines, myMachines, loading, onPick, exclude, disabled }: {
  allMachines: MachineOption[];
  /** The viewer's own machines (with lastPlayed) — the no-query list. */
  myMachines: MachineOption[];
  loading?: boolean;
  onPick: (m: MachineOption) => void;
  /** Ids not to offer (already picked). */
  exclude?: number[];
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const q = query.trim();
    const skip = new Set(exclude ?? []);
    if (q) return allMachines.filter(m => !skip.has(m.id) && nameMatches(m.name, q)).slice(0, 8);
    // No query: the machines you've played, most recent first.
    return [...myMachines].filter(m => !skip.has(m.id))
      .sort((a, b) => String(b.lastPlayed ?? '').localeCompare(String(a.lastPlayed ?? ''))).slice(0, 6)
      .map(m => allMachines.find(x => x.id === m.id) ?? m);
  }, [query, allMachines, myMachines, exclude]);

  return (
    <>
      <div className="relative">
        <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search machines on TiltTrack…"
          aria-label="Search machines"
          disabled={disabled}
          className={`${pickerInputClass} pl-9`}
        />
      </div>
      <div className="mt-2 flex flex-col gap-1.5">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Loading machines…</p>
        ) : results.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {query.trim() ? `No machine on TiltTrack matches “${query.trim()}”. Someone has to log a score on it first.` : 'Search for a machine.'}
          </p>
        ) : (
          <>
            {!query.trim() && <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Machines you’ve played</p>}
            {results.map(m => (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => { onPick(m); setQuery(''); }}
                className="flex items-center gap-3 rounded-lg border border-white/10 px-2.5 py-2 text-left hover:border-machine/50 transition-colors disabled:opacity-50"
              >
                <MachineThumb name={m.name} imageUrl={m.imageUrl} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-machine truncate">{m.name}</span>
                  {(m.manufacturer || m.year) && <span className="block text-[11px] text-muted-foreground">{[m.manufacturer, m.year].filter(Boolean).join(' · ')}</span>}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </>
  );
}
