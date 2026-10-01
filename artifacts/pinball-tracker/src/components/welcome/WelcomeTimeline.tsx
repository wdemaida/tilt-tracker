import { useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { RichText } from '../RichText';
import type { WelcomeContent } from '../../lib/welcomeContent';

type Timeline = WelcomeContent['welcome.timeline'];

// The founder section's timeline: a vertical rail of stops, each showing only its "when" and title.
// Hovering a stop with a mouse opens its story; clicking or tapping (or Enter/Space — they're real
// buttons) toggles it. One stop is open at a time. The last stop is "now" and gets the glowing node.
export default function WelcomeTimeline({ timeline }: { timeline: Timeline }) {
  // The first stop starts open, so the page shows how the timeline works without needing a hint.
  const [open, setOpen] = useState<number | null>(0);
  // A click on the stop the mouse just opened by hovering keeps it open — otherwise "hover to
  // preview, click to read" would close the story the moment you click it.
  const hoverOpened = useRef<number | null>(null);
  const baseId = useId();
  const last = timeline.entries.length - 1;

  // Both read the ref, never the render's `open`: a quick mouse can enter and click before React
  // re-renders, and a stale `open` then closed the story the hover had just opened.
  function hover(i: number) {
    setOpen(o => {
      if (o !== i) hoverOpened.current = i;
      return i;
    });
  }

  function click(i: number) {
    if (hoverOpened.current === i) {
      hoverOpened.current = null;
      setOpen(i);
      return;
    }
    hoverOpened.current = null;
    setOpen(o => (o === i ? null : i));
  }

  return (
    <div>
      {timeline.title && (
        <h3 className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">{timeline.title}</h3>
      )}
      {timeline.hint && <p className="mt-2 text-sm text-muted-foreground/80">{timeline.hint}</p>}
      <ol className="relative mt-6">
        {/* The rail: blue fading into the pink "now" node. */}
        <span
          aria-hidden
          className="absolute left-[11px] top-3 bottom-3 w-0.5 rounded-full"
          style={{ background: 'linear-gradient(180deg, hsl(var(--machine)), hsl(var(--machine) / 0.35) 70%, hsl(var(--primary)))' }}
        />
        {timeline.entries.map((entry, i) => {
          const isOpen = open === i;
          const isNow = i === last;
          const panelId = `${baseId}-stop-${i}`;
          return (
            <li key={i} className="relative pl-11 pb-2 last:pb-0">
              <span
                aria-hidden
                className={`absolute left-[3px] top-[13px] w-[18px] h-[18px] rounded-full border-[3px] transition-colors ${
                  isNow
                    ? 'border-primary bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.8),0_0_26px_hsl(var(--primary)/0.45)]'
                    : isOpen ? 'border-machine bg-machine' : 'border-machine bg-background'
                }`}
              />
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onPointerEnter={e => { if (e.pointerType === 'mouse') hover(i); }}
                onClick={() => click(i)}
                className={`group w-full text-left rounded-xl px-3 py-2.5 -ml-3 transition-colors hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-username ${
                  isOpen ? 'bg-white/[0.04]' : ''
                }`}
              >
                <span className={`block text-xs font-extrabold uppercase tracking-[0.16em] tabular-nums ${isNow ? 'text-primary' : 'text-machine'}`}>
                  {entry.when}
                </span>
                <span className="mt-1 flex items-center justify-between gap-3">
                  <span className="font-extrabold text-white">{entry.title}</span>
                  <ChevronDown
                    aria-hidden
                    className={`w-4 h-4 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  />
                </span>
              </button>
              <div
                id={panelId}
                role="region"
                aria-label={entry.title}
                className={`-ml-3 grid transition-[grid-template-rows,visibility] duration-200 ${isOpen ? 'grid-rows-[1fr] visible' : 'grid-rows-[0fr] invisible'}`}
              >
                <div className="overflow-hidden">
                  <RichText
                    text={entry.body}
                    className={`mt-1 mb-3 rounded-xl border bg-card px-4 py-3.5 space-y-2 text-sm leading-relaxed text-muted-foreground ${
                      isNow ? 'border-primary/45' : 'border-white/10'
                    }`}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
