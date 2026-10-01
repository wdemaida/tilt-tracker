import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { BADGE_ICONS } from '../BadgeImage';

export type PickerIcon = ComponentType<{ className?: string; strokeWidth?: number | string }>;

const BADGE_NAMES = Object.keys(BADGE_ICONS).sort();
const GRID_COLS = 6;

// A hex color gets an alpha suffix (the badge editor's look); anything else (e.g. hsl(var(--primary)))
// is tinted with color-mix.
function tint(color: string, pct: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${Math.round((pct / 100) * 255).toString(16).padStart(2, '0')}`;
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/**
 * An icon field: a button showing the current icon, opening a searchable grid of every allowed icon
 * in `color`. Defaults to the badge icon set (/admin/badges); the welcome editor passes its own set.
 * An empty `value` shows `emptyIcon` labelled `emptyLabel` (e.g. "Default").
 */
export default function IconPicker({
  value, color, onChange, icons = BADGE_ICONS, names = BADGE_NAMES, fallback, emptyLabel = 'None', footnote = 'Shown only when the badge has no uploaded image.',
}: {
  value: string; color: string; onChange: (name: string) => void;
  icons?: Record<string, PickerIcon>; names?: readonly string[]; fallback?: PickerIcon; emptyLabel?: string; footnote?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s+/g, '-');
    return needle ? names.filter(n => n.includes(needle)) : names;
  }, [q, names]);
  const empty = value === '';
  const known = !!icons[value];
  const Current = icons[value] ?? fallback ?? BADGE_ICONS.award;
  const label = empty ? emptyLabel : `${value}${known ? '' : ' (unknown)'}`;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) close(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function close(refocus = true) {
    setOpen(false);
    setQ('');
    if (refocus) triggerRef.current?.focus();
  }
  function choose(name: string) {
    onChange(name);
    close();
  }
  function focusCell(i: number) {
    const cells = gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-icon]');
    if (!cells?.length) return;
    cells[Math.max(0, Math.min(i, cells.length - 1))].focus();
  }
  function onGridKey(e: React.KeyboardEvent, i: number) {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLS, ArrowUp: -GRID_COLS };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      if (e.key === 'ArrowUp' && i < GRID_COLS) { searchRef.current?.focus(); return; }
      focusCell(i + move);
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popId}
        aria-label={`Icon: ${label}. Change icon`}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="flex items-center gap-2 w-full border border-white/20 rounded-lg pl-2 pr-2.5 py-1.5 text-sm text-white bg-white/5 hover:border-white/35 focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full border flex-shrink-0" style={{ color, backgroundColor: tint(color, 15), borderColor: tint(color, 50) }}>
          <Current className="w-4 h-4" strokeWidth={2.25} aria-hidden />
        </span>
        <span className="flex-1 min-w-0 truncate text-left">{label}</span>
        <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
      </button>
      {open && (
        <div id={popId} role="dialog" aria-label="Choose an icon"
          className="absolute left-0 top-full mt-1 z-30 w-[18.5rem] max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 bg-card shadow-2xl p-2.5 flex flex-col gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
            <input
              ref={searchRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); focusCell(0); }
                if (e.key === 'Enter' && shown.length) { e.preventDefault(); choose(shown[0]); }
              }}
              placeholder="Search icons…"
              aria-label="Search icons"
              className="border border-white/20 rounded-lg pl-8 pr-2 py-1.5 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full"
            />
          </div>
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground px-1 py-2">No icon matches “{q.trim()}”.</p>
          ) : (
            <div ref={gridRef} role="listbox" aria-label="Icons" className="grid grid-cols-6 gap-1 max-h-60 overflow-y-auto">
              {shown.map((name, i) => {
                const Icon = icons[name];
                if (!Icon) return null;
                const on = name === value;
                return (
                  <button
                    key={name}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-icon={name}
                    title={name}
                    aria-label={name}
                    onClick={() => choose(name)}
                    onKeyDown={e => onGridKey(e, i)}
                    className={`flex items-center justify-center h-10 rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${on ? 'border-white/60 bg-white/10' : 'border-transparent hover:bg-white/5 hover:border-white/15'}`}
                    style={{ color }}
                  >
                    <Icon className="w-5 h-5" strokeWidth={2.25} aria-hidden />
                  </button>
                );
              })}
            </div>
          )}
          {footnote && <p className="text-[10px] text-muted-foreground px-1">{footnote}</p>}
        </div>
      )}
    </div>
  );
}
