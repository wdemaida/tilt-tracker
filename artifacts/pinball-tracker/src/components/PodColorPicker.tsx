import { useEffect, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { POD_PALETTE, normalizePodColor, nearReservedColor, reservedThemeColors } from '../lib/podColor';
import { useTheme } from '../lib/theme';

/**
 * Pod color picker: the preset palette as swatches, a native color input for anything else, and a
 * hex field. `value` is always a normalized `#rrggbb` — the hex field only calls `onChange` once
 * what's typed normalizes. Warns (doesn't block) when the pick is close to any of the five fixed
 * theme colors: a pod that looks like "You" or "All other players" misreads on a chart, and one
 * that looks like the machine-name blue (or the venue / score colors) blurs into the labels.
 */
export default function PodColorPicker({ value, onChange, idPrefix }: {
  value: string;
  onChange: (hex: string) => void;
  idPrefix: string;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(value);
  // Follow outside changes (a swatch click), but not the echo of our own typing — "#abc" on the way
  // to "#abcdef" normalizes to #aabbcc, and resetting the field to that would eat the keystrokes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (normalizePodColor(draft) !== value) setDraft(value); }, [value]);

  const draftValid = normalizePodColor(draft) !== null;
  const reservedClash = nearReservedColor(value, reservedThemeColors(colors));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Pod color">
        {POD_PALETTE.map(c => {
          const selected = c === value;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Color ${c}`}
              onClick={() => onChange(c)}
              className={`w-8 h-8 rounded-full border-2 flex items-center justify-center transition-transform hover:scale-110 ${
                selected ? 'border-white' : 'border-white/10'
              }`}
              style={{ background: c }}
            >
              {selected && <Check className="w-4 h-4 text-white drop-shadow" aria-hidden />}
            </button>
          );
        })}

        <div className="relative w-8 h-8" title="Pick any color">
          <div
            className={`w-8 h-8 rounded-full border-2 ${
              (POD_PALETTE as readonly string[]).includes(value) ? 'border-dashed border-white/30' : 'border-white'
            }`}
            style={{ background: (POD_PALETTE as readonly string[]).includes(value) ? 'conic-gradient(#f87171, #facc15, #4ade80, #60a5fa, #c084fc, #f87171)' : value }}
          />
          <input
            type="color"
            value={value}
            onChange={e => { const c = normalizePodColor(e.target.value); if (c) onChange(c); }}
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            aria-label="Pick a custom color"
          />
        </div>

        <label htmlFor={`${idPrefix}-hex`} className="sr-only">Hex color</label>
        <input
          id={`${idPrefix}-hex`}
          type="text"
          value={draft}
          maxLength={7}
          spellCheck={false}
          onChange={e => {
            setDraft(e.target.value);
            const c = normalizePodColor(e.target.value);
            if (c) onChange(c);
          }}
          onBlur={() => setDraft(value)}
          className={`w-24 rounded-lg border bg-background px-2 py-1.5 text-sm font-mono text-white focus:outline-none ${
            draftValid ? 'border-white/10 focus:border-primary/50' : 'border-red-400/60'
          }`}
        />
      </div>
      {!draftValid && <p className="text-xs text-red-400 mt-1.5">Use a hex color like #fe7b32.</p>}
      {reservedClash && (
        <p className="flex items-center gap-1.5 text-xs text-amber-400 mt-1.5">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
          Looks a lot like the color TiltTrack uses for {reservedClash} — consider another.
        </p>
      )}
    </div>
  );
}
