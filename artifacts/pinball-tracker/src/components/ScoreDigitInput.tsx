import { useRef, useState } from 'react';
import { commaBefore, formatTemplate, setAt, trailingZerosSuggestion, unknownCount, type ScoreConflict } from '../lib/scoreTemplate';

interface Props {
  /** Current template: digits plus `?` for positions still to fill. */
  value: string;
  /** The template as read off the photo — tells us which cells the user has filled in. */
  original: string;
  /** Indexes the model read but wasn't sure of. Amber, still editable, no confirmation needed. */
  lowConfidence: number[];
  /** Positions where multiple photos disagreed — offered as a small picker. */
  conflicts: ScoreConflict[];
  onChange: (next: string) => void;
  /** "Edit as plain number" escape hatch. */
  onPlainMode: () => void;
}

// A single sentinel character lives in the hidden input so that a mobile keyboard's backspace
// produces a change event (an empty input has nothing to delete, so it wouldn't). Every change is
// interpreted and the input is reset to the sentinel.
const SENTINEL = ' ';

/**
 * Digit-cell score entry for a partial read. Cells are right-aligned with commas every three digits;
 * unread positions show an amber "x". Typing fills the next x left-to-right; tapping a cell selects
 * it so the next digit overwrites that cell instead. Backspace clears the selected cell back to x,
 * or — with nothing selected — un-fills the most recently filled x.
 */
export function ScoreDigitInput({ value, original, lowConfidence, conflicts, onChange, onPlainMode }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  const remaining = unknownCount(value);
  const nextUnknown = value.indexOf('?');
  const zeros = trailingZerosSuggestion(value);
  const openConflicts = conflicts.filter(c => value[c.index] === '?');

  function focus(cell: number | null) {
    setSelected(cell);
    inputRef.current?.focus();
  }

  function typeDigits(digits: string) {
    // Applied one at a time against a running value, so a pasted "00" fills two x's, not one twice.
    let next = value;
    let sel = selected;
    for (const d of digits) {
      if (sel != null) { next = setAt(next, sel, d); sel = null; continue; }
      const i = next.indexOf('?');
      if (i >= 0) next = setAt(next, i, d);
    }
    // After correcting a specific cell, carry on with the x's rather than trapping focus there.
    setSelected(null);
    if (next !== value) onChange(next);
  }

  function backspace() {
    if (selected != null) {
      onChange(setAt(value, selected, '?'));
      return;
    }
    // Filling runs left-to-right, so the rightmost filled x is the most recent one.
    for (let i = value.length - 1; i >= 0; i--) {
      if (original[i] === '?' && value[i] !== '?') {
        onChange(setAt(value, i, '?'));
        return;
      }
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    if (v.length < SENTINEL.length) backspace();
    else typeDigits(v.replace(/[^0-9]/g, ''));
    e.target.value = SENTINEL;
    e.target.setSelectionRange(SENTINEL.length, SENTINEL.length);
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label={`Score ${formatTemplate(value)}, ${remaining} digits to fill`}
        onClick={() => focus(null)}
        className={`relative flex justify-end items-end gap-0.5 rounded-lg border bg-background px-3 py-2.5 cursor-text overflow-x-auto ${focused ? 'border-primary/50' : 'border-border'}`}
      >
        {[...value].map((ch, i) => {
          const unknown = ch === '?';
          const filledByUser = original[i] === '?' && !unknown;
          const low = !unknown && lowConfidence.includes(i) && !filledByUser;
          const isSelected = selected === i;
          const isNext = focused && selected == null && i === nextUnknown;
          const cls = unknown
            ? 'border-amber-400/70 border-dashed bg-amber-500/15 text-amber-400'
            : low
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
              : filledByUser
                ? 'border-primary/40 bg-primary/10 text-white'
                : 'border-white/10 text-white';
          return (
            <span key={i} className="flex items-end">
              {commaBefore(value, i) && <span className="text-muted-foreground text-lg font-bold px-0.5 select-none">,</span>}
              <button
                type="button"
                aria-label={unknown ? `Digit ${i + 1}: unread` : `Digit ${i + 1}: ${ch}${low ? ' (unsure)' : ''}`}
                onClick={e => { e.stopPropagation(); focus(isSelected ? null : i); }}
                className={`w-7 h-10 rounded-md border text-lg font-bold font-mono flex items-center justify-center transition-colors ${cls} ${isSelected || isNext ? 'ring-2 ring-primary' : ''}`}
              >
                {unknown ? 'x' : ch}
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Type the missing digits"
          defaultValue={SENTINEL}
          onChange={handleInput}
          onFocus={e => { setFocused(true); e.target.setSelectionRange(SENTINEL.length, SENTINEL.length); }}
          onBlur={() => { setFocused(false); }}
          className="absolute inset-0 opacity-0 pointer-events-none"
        />
      </div>

      {openConflicts.map(c => (
        <div key={c.index} className="flex items-center gap-2 text-xs text-amber-400">
          <span>Digit {c.index + 1} — your photos disagree:</span>
          {c.candidates.map((d, k) => (
            <span key={d} className="flex items-center gap-1">
              {k > 0 && <span className="text-muted-foreground">or</span>}
              <button
                type="button"
                onClick={() => onChange(setAt(value, c.index, d))}
                className="w-7 h-7 rounded-md border border-amber-500/50 bg-amber-500/10 font-mono font-bold text-amber-300 hover:bg-amber-500/20"
              >
                {d}
              </button>
            </span>
          ))}
          <span className="text-muted-foreground">?</span>
        </div>
      ))}

      <div className="flex items-center gap-3 flex-wrap">
        {zeros && (
          <button
            type="button"
            onClick={() => { onChange(zeros); setSelected(null); }}
            className="text-xs px-2.5 py-1 rounded-full border border-primary/40 bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors"
          >
            {Number(zeros).toLocaleString()} — fill with 0s?
          </button>
        )}
        <button
          type="button"
          onClick={onPlainMode}
          className="text-xs text-muted-foreground hover:text-white transition-colors ml-auto"
        >
          Edit as plain number
        </button>
      </div>
    </div>
  );
}
