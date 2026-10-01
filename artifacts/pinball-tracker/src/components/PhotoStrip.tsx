// A row of the photos the user just picked (AddScorePage step 3), each a button that opens
// PhotoViewer's local mode on that photo. `size="lg"` is for when the digits matter — the
// "Which player were you?" cards and filling in a partial read's x's.
//
// The viewer pushes its own history entry (`historyEntry`), so the back gesture closes the photo
// rather than stepping the wizard back — see src/lib/photoViewerHistory.ts.

import { useState } from 'react';
import { Camera, Maximize2 } from 'lucide-react';
import PhotoViewer from './PhotoViewer';

export default function PhotoStrip({ sources, size = 'sm', className = '' }: {
  /** Object or data URLs of the prepared images. */
  sources: string[];
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // A server-decoded HEIC can't be drawn by most browsers: show a camera icon in its place.
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  if (sources.length === 0) return null;
  const lg = size === 'lg';
  const many = sources.length > 1;
  return (
    <>
      <div className={`flex gap-2 overflow-x-auto ${className}`}>
        {sources.map((src, i) => (
          <button
            key={src}
            type="button"
            onClick={() => setOpenIndex(i)}
            aria-label={many ? `View photo ${i + 1} full size` : 'View photo full size'}
            className={`relative flex-shrink-0 rounded-lg overflow-hidden border border-white/10 bg-black group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${lg ? 'h-32' : 'h-16'}`}
            style={lg ? { maxWidth: many ? '80%' : '100%' } : undefined}
          >
            {broken[src] ? (
              <span className={`flex h-full items-center justify-center text-muted-foreground ${lg ? 'w-32' : 'w-16'}`}>
                <Camera className="w-5 h-5" />
              </span>
            ) : (
              <img
                src={src}
                alt=""
                draggable={false}
                onError={() => setBroken(b => ({ ...b, [src]: true }))}
                className={`h-full w-auto object-contain transition-opacity group-hover:opacity-90 ${lg ? 'min-w-[4rem]' : 'min-w-[3rem] max-w-[5.5rem]'}`}
              />
            )}
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/65 p-0.5" aria-hidden>
              <Maximize2 className={`${lg ? 'w-3 h-3' : 'w-2.5 h-2.5'} text-white`} />
            </span>
          </button>
        ))}
      </div>
      {openIndex != null && (
        <PhotoViewer
          sources={sources}
          initialIndex={openIndex}
          historyEntry
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  );
}
