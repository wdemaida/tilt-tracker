import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';

// A machine typeahead: type, pick from the dropdown attached under the input (Up/Down/Enter/Escape,
// or the mouse), and the pick shows as a chip with a remove ×. ARIA 1.2 combobox pattern — the input
// keeps focus, the active option is announced through aria-activedescendant. Filters a list the
// caller already has (TiltTrack machines), so it makes no requests of its own.

export interface MachineOption { id: number; name: string; manufacturer?: string | null; year?: number | string | null }

const MAX_RESULTS = 50;

function rank(all: MachineOption[], q: string): MachineOption[] {
  const needle = q.trim().toLowerCase();
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  if (!needle) return sorted.slice(0, MAX_RESULTS);
  const starts: MachineOption[] = [];
  const words: MachineOption[] = [];
  const inside: MachineOption[] = [];
  for (const m of sorted) {
    const n = m.name.toLowerCase();
    if (n.startsWith(needle)) starts.push(m);
    else if (n.split(/[^a-z0-9]+/).some(w => w.startsWith(needle))) words.push(m);
    else if (n.includes(needle)) inside.push(m);
  }
  return [...starts, ...words, ...inside].slice(0, MAX_RESULTS);
}

export default function MachineCombobox({ machines, loading = false, value, onChange, placeholder = 'Search machines…', label = 'Machine' }: {
  machines: MachineOption[];
  loading?: boolean;
  value: number | null | undefined;
  onChange: (m: MachineOption | null) => void;
  placeholder?: string;
  /** Accessible name for the input. */
  label?: string;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = value != null ? machines.find(m => m.id === value) ?? null : null;
  const results = useMemo(() => rank(machines, q), [machines, q]);

  useEffect(() => { setActive(0); }, [q]);
  // Keep the highlighted option visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function pick(m: MachineOption) {
    onChange(m);
    setQ('');
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && results[active]) { e.preventDefault(); pick(results[active]); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); }
    }
  }

  if (selected || (value != null && loading)) {
    return (
      <div className="flex items-center gap-2 min-h-[38px]">
        <span className="inline-flex items-center gap-1.5 max-w-full rounded-full border border-machine/40 bg-machine/10 pl-3 pr-1.5 py-1 text-sm font-semibold text-machine">
          <span className="truncate">{selected?.name ?? 'Loading…'}</span>
          <button
            type="button"
            onClick={() => { onChange(null); requestAnimationFrame(() => inputRef.current?.focus()); }}
            aria-label={`Remove ${selected?.name ?? 'machine'}`}
            className="rounded-full p-0.5 text-machine/80 hover:text-white hover:bg-white/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>
    );
  }

  const showList = open && !loading;
  return (
    <div className="relative">
      <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
      <input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${results[active].id}` : undefined}
        autoComplete="off"
        className="border border-white/20 rounded-lg pl-9 pr-9 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full"
        placeholder={loading ? 'Loading machines…' : placeholder}
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {loading && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin absolute right-3 top-1/2 -translate-y-1/2" aria-hidden />}
      {showList && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 top-full mt-1 z-30 max-h-64 overflow-y-auto rounded-lg border border-white/15 bg-card shadow-2xl py-1"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground" role="presentation">
              {q.trim() ? `No machine on TiltTrack matches “${q.trim()}”.` : 'No machines yet.'}
            </li>
          ) : results.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${m.id}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: keep focus in the input so blur doesn't close the list first.
              onMouseDown={e => { e.preventDefault(); pick(m); }}
              onMouseEnter={() => setActive(i)}
              className={`px-3 py-2 cursor-pointer text-sm ${i === active ? 'bg-machine/15 text-white' : 'text-white/80'}`}
            >
              <span className="block truncate font-semibold text-machine">{m.name}</span>
              {(m.manufacturer || m.year) && (
                <span className="block text-[11px] text-muted-foreground">{[m.manufacturer, m.year].filter(Boolean).join(' · ')}</span>
              )}
            </li>
          ))}
          {results.length === MAX_RESULTS && (
            <li className="px-3 py-1.5 text-[11px] text-muted-foreground" role="presentation">Showing the first {MAX_RESULTS} — keep typing to narrow it.</li>
          )}
        </ul>
      )}
    </div>
  );
}
