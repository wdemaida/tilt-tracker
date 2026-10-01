import { useEffect, useRef, useState } from 'react';
import { MapPin, Play } from 'lucide-react';
import { welcomeImageUrl } from '../../lib/welcomeParts';

// "See it in action": a phone-framed screen recording and a grid of screenshots. Both are files in
// public/welcome/ that may not exist yet. Anything that hasn't loaded shows an illustration instead —
// never a broken image. (Unknown paths come back as the SPA's index.html on Vercel and Vite, so the
// browser's own load/error events are the only reliable "is it there" check.)

export const SCORE_SUBMISSION_VIDEO = '/welcome/score-submission.mp4';
export const SCORE_SUBMISSION_POSTER = '/welcome/score-submission-poster.jpg';

/** Muted, looping, inline; plays only while on screen. Shows the placeholder until it can play. */
export function PhoneVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useEffect(() => {
    const video = ref.current;
    if (!video || state !== 'ready' || typeof IntersectionObserver === 'undefined') return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !reduce) void video.play().catch(() => {});
      else video.pause();
    }, { threshold: 0.4 });
    io.observe(video);
    return () => io.disconnect();
  }, [state]);

  return (
    <div className="w-full max-w-[280px] mx-auto aspect-[9/19.5] rounded-[40px] p-2.5 bg-[hsl(240_8%_14%)] border border-white/15 shadow-[0_30px_70px_hsl(0_0%_0%/0.6)]">
      <div className="relative h-full rounded-[31px] overflow-hidden bg-card">
        {state !== 'missing' && (
          <video
            ref={ref}
            src={SCORE_SUBMISSION_VIDEO}
            poster={SCORE_SUBMISSION_POSTER}
            muted
            loop
            playsInline
            preload="metadata"
            aria-label="Screen recording of a score being submitted with one photo"
            onLoadedData={() => setState('ready')}
            onError={() => setState('missing')}
            className={`absolute inset-0 w-full h-full object-cover ${state === 'ready' ? '' : 'invisible'}`}
          />
        )}
        {state !== 'ready' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <span aria-hidden className="absolute top-2.5 left-1/2 -translate-x-1/2 w-[84px] h-[22px] rounded-full bg-[hsl(240_8%_14%)]" />
            <span className="w-16 h-16 rounded-full flex items-center justify-center bg-primary/15 border border-primary/45 text-primary">
              <Play className="w-6 h-6 ml-1 fill-current" aria-hidden />
            </span>
            <span className="text-sm font-bold text-white">Watch a score go in</span>
            <span className="text-xs text-muted-foreground">Video coming soon</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A screenshot from public/welcome/, or the illustration for its slot until the file exists. */
export function Screenshot({ title, image, index }: { title: string; image: string; index: number }) {
  const src = welcomeImageUrl(image);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <figure className="m-0 min-w-0 rounded-2xl border border-white/10 bg-card overflow-hidden">
      <div className="relative aspect-[16/10] bg-gradient-to-b from-[hsl(240_9%_10%)] to-card">
        {showImage && (
          <img
            src={src}
            alt={title}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={`absolute inset-0 w-full h-full object-cover object-top ${loaded ? '' : 'invisible'}`}
          />
        )}
        {!loaded && <Illustration kind={illustrationFor(image, index)} />}
      </div>
      <figcaption className="px-3.5 py-3 border-t border-white/10 text-sm font-bold">{title}</figcaption>
    </figure>
  );
}

type IllustrationKind = 'trend' | 'venue' | 'badges' | 'challenge';
const ORDER: IllustrationKind[] = ['trend', 'venue', 'badges', 'challenge'];

function illustrationFor(image: string, index: number): IllustrationKind {
  const name = image.toLowerCase();
  return ORDER.find(k => name.includes(k)) ?? ORDER[index % ORDER.length];
}

const TREND_POINTS = [[30, 160], [85, 150], [140, 118], [195, 126], [250, 80], [300, 48]];

function Illustration({ kind }: { kind: IllustrationKind }) {
  const line = 'h-2 rounded bg-border';
  return (
    <div aria-hidden className="absolute inset-0 p-3.5 flex flex-col gap-2">
      {kind === 'trend' && (
        <svg viewBox="0 0 320 200" className="w-full h-full block">
          {[30, 100, 170].map(y => <line key={y} x1="20" y1={y} x2="310" y2={y} stroke="hsl(var(--border))" />)}
          <polyline points={TREND_POINTS.map(p => p.join(',')).join(' ')} fill="none" stroke="hsl(var(--username))" strokeWidth="2.5" strokeLinecap="round" opacity="0.8" />
          {TREND_POINTS.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === TREND_POINTS.length - 1 ? 6 : 5} fill="hsl(var(--username))" />)}
        </svg>
      )}
      {kind === 'venue' && (
        <>
          <div className={`${line} w-[55%] bg-venue/50`} />
          <div className={`${line} w-[35%]`} />
          <div className="flex-1 rounded-xl bg-[hsl(240_9%_12%)] flex items-center justify-center text-venue"><MapPin className="w-7 h-7" /></div>
          <div className={`${line} w-4/5`} />
          <div className={`${line} w-[65%]`} />
        </>
      )}
      {kind === 'badges' && (
        <div className="flex-1 flex flex-wrap content-center justify-center gap-3">
          <span className="w-10 h-10 rounded-full border-2 border-primary/45 bg-primary/15" />
          <span className="w-10 h-10 rounded-full border-2 border-machine/45 bg-machine/10" />
          <span className="w-10 h-10 rounded-full border-2 border-username/45 bg-username/10" />
          <span className="w-10 h-10 rounded-full border-2 border-dashed border-border" />
          <span className="w-10 h-10 rounded-full border-2 border-dashed border-border" />
        </div>
      )}
      {kind === 'challenge' && (
        <>
          <div className={`${line} w-[45%] bg-machine/50`} />
          <div className="h-2.5 rounded bg-primary/15"><div className="h-full w-[70%] rounded bg-primary" /></div>
          <div className="h-2.5 rounded bg-friend/10"><div className="h-full w-[52%] rounded bg-friend" /></div>
          <div className={`${line} w-[60%]`} />
        </>
      )}
    </div>
  );
}
