// Full-screen viewer for a score's full-size photo (Cloudflare R2 — see src/lib/fullSizePhoto.ts).
//
// Opens instantly: the list's thumbnail (when there is one) is blown up and blurred as a placeholder
// while GET /api/scores/:id/photo signs a URL, then the full image cross-fades in.
//
// Thumbnail-only scores (no full-size photo was saved — e.g. posted from an old cached app) open here
// too: the endpoint answers `url: null` plus the thumbnail, which is shown unblurred but capped at
// THUMB_MAX_UPSCALE × its natural size so it isn't smeared across a desktop screen, with a note saying
// so. When the server says `canUpload` (the viewer owns the score), the viewer offers "Upload the
// full-size photo" (or a quiet "Replace photo") — see FullPhotoUpload.tsx. Zoom and pan are
// a few lines of pointer maths rather than a library: pinch / drag on touch, wheel / click on desktop,
// double-tap to toggle. Closes with ×, Escape, a tap on the backdrop, or a swipe down at 1×.
//
// Portalled to <body> at z-50: above the mobile tab bar (z-40) and the sticky header, like every
// other modal.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { Camera, Loader2, X, AlertTriangle } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { FullPhotoUploadButton } from './FullPhotoUpload';
import { formatScoreTime } from '../lib/scoreTime';

export interface PhotoCaption {
  machineName?: string | null;
  score?: number | null;
  playedAt?: string | null;
  venueTimezone?: string | null;
  username?: string | null;
}

interface Props {
  scoreId: number;
  /** The list's data-URL thumbnail, shown blurred until the full image arrives. Lists that don't
   *  carry thumbnails omit it; a thumbnail-only score's arrives with the photo response instead. */
  thumbnail?: string | null;
  caption?: PhotoCaption;
  onClose: () => void;
}

const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 8;
const DISMISS_DRAG_PX = 110;
/** A thumbnail-only score is shown at most this many times its natural (~160px) size. */
const THUMB_MAX_UPSCALE = 3;

interface View { s: number; x: number; y: number }
const IDENTITY: View = { s: 1, x: 0, y: 0 };

export function captionText(c: PhotoCaption | undefined): string {
  if (!c) return '';
  return [
    c.machineName,
    c.score != null ? Number(c.score).toLocaleString() : null,
    c.playedAt ? formatScoreTime(c.playedAt, c.venueTimezone ?? null, 'MMM d, yyyy') : null,
    c.username ? `@${c.username}` : null,
  ].filter(Boolean).join(' · ');
}

export default function PhotoViewer({ scoreId, thumbnail, caption, onClose }: Props) {
  const api = useApi();
  // `canUpload` depends on who's asking, so the viewer's identity is part of the key. Invalidating
  // ['score-photo', id] (FullPhotoUpload) still matches every variant.
  const { userId } = useAuth();
  // The signed URL lives ~10 minutes; refetch well inside that.
  const { data, isError } = useQuery({
    queryKey: ['score-photo', scoreId, userId ?? 'guest'],
    queryFn: () => api.scores.photo(scoreId),
    staleTime: 4 * 60_000,
    gcTime: 8 * 60_000,
    retry: 1,
  });
  const [loaded, setLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const failed = isError || imgError;
  const thumbOnly = !!data && !data.url;
  const thumbSrc = thumbnail ?? data?.thumbnail ?? null;
  // A refetch re-signs the same object (new query string); only a different object — a replacement
  // upload — should drop back to the placeholder.
  const photoIdentity = data?.url ? data.url.split('?')[0] : null;
  useEffect(() => { setLoaded(false); setImgError(false); }, [photoIdentity]);
  const loading = !failed && (!data || (!!data.url && !loaded));

  // ── layout: the photo box is sized from its aspect ratio to fit the stage ──
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [thumbSize, setThumbSize] = useState<{ w: number; h: number } | null>(null);
  const thumbRatio = thumbSize ? thumbSize.w / thumbSize.h : null;
  const ratio = data?.width && data?.height ? data.width / data.height : thumbRatio ?? 4 / 3;
  const fit = stage.w && stage.h
    ? (stage.w / stage.h > ratio ? { w: stage.h * ratio, h: stage.h } : { w: stage.w, h: stage.w / ratio })
    : { w: 0, h: 0 };
  // No fake sharpness: a thumbnail-only photo stops growing at THUMB_MAX_UPSCALE × natural size.
  const cap = thumbOnly && thumbSize && fit.w ? Math.min(1, (thumbSize.w * THUMB_MAX_UPSCALE) / fit.w) : 1;
  const box = { w: fit.w * cap, h: fit.h * cap };

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── zoom / pan state ──
  const [view, setViewState] = useState<View>(IDENTITY);
  const viewRef = useRef<View>(IDENTITY);
  const [dragY, setDragY] = useState(0);
  const [animating, setAnimating] = useState(false);
  const boxRef = useRef(box);
  boxRef.current = box;
  const stageSizeRef = useRef(stage);
  stageSizeRef.current = stage;

  const clamp = useCallback((v: View): View => {
    const s = Math.min(MAX_SCALE, Math.max(1, v.s));
    if (s === 1) return IDENTITY;
    const b = boxRef.current;
    const st = stageSizeRef.current;
    const maxX = Math.max(0, (b.w * s - st.w) / 2);
    const maxY = Math.max(0, (b.h * s - st.h) / 2);
    return { s, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  }, []);

  const setView = useCallback((v: View, animate = false) => {
    const next = clamp(v);
    viewRef.current = next;
    setAnimating(animate);
    setViewState(next);
  }, [clamp]);

  /** Zoom to `s` keeping the stage point `p` (relative to the stage centre) fixed under the finger. */
  const zoomAbout = useCallback((from: View, s: number, p: { x: number; y: number }): View => {
    const k = s / from.s;
    return { s, x: p.x - (p.x - from.x) * k, y: p.y - (p.y - from.y) * k };
  }, []);

  const toStage = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  // ── close: Escape, scroll lock, focus ──
  const closeRef = useRef<HTMLButtonElement>(null);
  // Callers pass an inline arrow; a ref keeps this effect to one run per open, not one per render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, []);

  // ── wheel zoom (desktop); needs a non-passive listener to stop the page scrolling ──
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const from = viewRef.current;
      const s = Math.min(MAX_SCALE, Math.max(1, from.s * Math.exp(-e.deltaY * 0.0025)));
      setView(zoomAbout(from, s, toStage(e.clientX, e.clientY)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView, zoomAbout]);

  // ── pointers: pinch, pan, swipe-to-dismiss, taps ──
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: 'pan'; start: { x: number; y: number }; from: View; moved: boolean; onPhoto: boolean; type: string }
    | { kind: 'pinch'; dist: number; mid: { x: number; y: number }; from: View }
    | null
  >(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const pinchInfo = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: toStage((a.x + b.x) / 2, (a.y + b.y) / 2) };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-viewer-chrome]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      setDragY(0);
      gesture.current = { kind: 'pinch', ...pinchInfo(), from: viewRef.current };
    } else if (pointers.current.size === 1) {
      const onPhoto = !!(e.target as HTMLElement).closest('[data-viewer-photo]');
      gesture.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, from: viewRef.current, moved: false, onPhoto, type: e.pointerType };
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const { dist, mid } = pinchInfo();
      const s = Math.min(MAX_SCALE, Math.max(1, g.from.s * (dist / g.dist)));
      const z = zoomAbout(g.from, s, g.mid);
      setView({ s, x: z.x + (mid.x - g.mid.x), y: z.y + (mid.y - g.mid.y) });
    } else if (g.kind === 'pan') {
      const dx = e.clientX - g.start.x;
      const dy = e.clientY - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) > TAP_SLOP_PX) g.moved = true;
      if (!g.moved) return;
      if (g.from.s > 1) setView({ ...g.from, x: g.from.x + dx, y: g.from.y + dy });
      else if (g.type !== 'mouse') setDragY(Math.max(0, dy)); // swipe down to dismiss
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // One finger still down after a pinch: carry on as a pan from here, never as a tap.
      const rest = [...pointers.current.values()][0];
      gesture.current = rest ? { kind: 'pan', start: rest, from: viewRef.current, moved: true, onPhoto: true, type: 'touch' } : null;
      if (viewRef.current.s < 1.05) setView(IDENTITY, true);
      return;
    }
    gesture.current = null;
    if (!g || g.kind !== 'pan') return;

    if (g.moved) {
      if (dragY > DISMISS_DRAG_PX) return onClose();
      setAnimating(true);
      setDragY(0);
      return;
    }
    // A tap.
    const p = toStage(e.clientX, e.clientY);
    if (!g.onPhoto) {
      if (viewRef.current.s === 1) onClose();
      return;
    }
    const zoomToggle = () => setView(viewRef.current.s > 1 ? IDENTITY : zoomAbout(viewRef.current, 2.5, p), true);
    if (g.type === 'mouse') return zoomToggle(); // click to zoom on desktop
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(prev.x - e.clientX, prev.y - e.clientY) < 30) {
      lastTap.current = null;
      zoomToggle();
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId);
    gesture.current = null;
    setAnimating(true);
    setDragY(0);
  };

  const text = captionText(caption);
  const zoomed = view.s > 1;
  const backdropOpacity = Math.max(0.35, 1 - dragY / 500);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={text ? `Photo: ${text}` : 'Score photo'}
      className="fixed inset-0 z-50 flex flex-col select-none"
      style={{ backgroundColor: `rgba(0,0,0,${0.97 * backdropOpacity})` }}
    >
      <div
        ref={stageRef}
        className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          data-viewer-photo
          className="relative"
          style={{
            width: box.w,
            height: box.h,
            transform: `translate3d(${view.x}px, ${view.y + dragY}px, 0) scale(${view.s})`,
            transition: animating ? 'transform 200ms ease-out' : 'none',
            cursor: zoomed ? 'zoom-out' : 'zoom-in',
          }}
          onTransitionEnd={() => setAnimating(false)}
        >
          {thumbSrc && (
            <img
              src={thumbSrc}
              alt={thumbOnly ? (text ? `Score photo thumbnail: ${text}` : 'Score photo thumbnail') : ''}
              aria-hidden={!thumbOnly}
              draggable={false}
              onLoad={e => {
                const t = e.currentTarget;
                if (t.naturalWidth && t.naturalHeight) setThumbSize({ w: t.naturalWidth, h: t.naturalHeight });
              }}
              className="absolute inset-0 w-full h-full object-contain transition-opacity duration-300"
              style={{ filter: failed || thumbOnly ? 'none' : 'blur(14px)', opacity: loaded ? 0 : 1 }}
            />
          )}
          {data?.url && !imgError && (
            <img
              src={data.url}
              alt={text ? `Score photo: ${text}` : 'Score photo'}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setImgError(true)}
              className="absolute inset-0 w-full h-full object-contain transition-opacity duration-300"
              style={{ opacity: loaded ? 1 : 0 }}
            />
          )}
        </div>

        {loading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-white/80 animate-spin" aria-label="Loading full-size photo" />
          </div>
        )}
        {failed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
            <p className="flex items-center gap-2 rounded-lg bg-black/70 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5" /> Couldn't load the photo
            </p>
          </div>
        )}

        <button
          ref={closeRef}
          type="button"
          data-viewer-chrome
          onClick={onClose}
          aria-label="Close photo"
          className="absolute right-3 rounded-full bg-black/60 p-2 text-white hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ top: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div
        data-viewer-chrome
        className="flex-shrink-0 px-4 pt-3 text-center"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))', opacity: backdropOpacity }}
      >
        {text && <p className="text-sm font-semibold text-white truncate">{text}</p>}
        {thumbOnly && (
          <p className="mt-1 text-xs text-amber-200/90">
            Thumbnail only — the full-size photo wasn't saved for this score.
          </p>
        )}
        {data?.canUpload && (
          <div className="mt-2 flex justify-center">
            {thumbOnly
              ? <FullPhotoUploadButton scoreId={scoreId} label="Upload the full-size photo" />
              : <FullPhotoUploadButton scoreId={scoreId} label="Replace photo" variant="quiet" />}
          </div>
        )}
        <p className="mt-1 text-[11px] text-white/50">
          {zoomed ? 'Drag to pan · double-tap or click to reset' : 'Pinch, scroll or double-tap to zoom'}
        </p>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A small camera button for score rows that don't show a thumbnail (user, machine, venue, challenge
 * lists). Full-size photo: the normal button. Thumbnail only: the same button, dimmed — the thumbnail
 * is still the score's proof photo (and the viewer is where its owner can add the full one), but it
 * shouldn't compete with rows that have a real photo. No photo at all: nothing.
 */
export function FullPhotoButton({ scoreId, hasFullPhoto, hasThumbnail, caption, className = '' }: {
  scoreId: number;
  hasFullPhoto?: boolean;
  hasThumbnail?: boolean;
  caption?: PhotoCaption;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!hasFullPhoto && !hasThumbnail) return null;
  const label = hasFullPhoto ? 'View photo' : 'View photo thumbnail';
  return (
    <>
      <button
        type="button"
        onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        aria-label={label}
        title={hasFullPhoto ? label : 'View thumbnail (no full-size photo)'}
        className={`inline-flex items-center justify-center rounded p-1 hover:text-white hover:bg-white/10 transition-colors ${hasFullPhoto ? 'text-muted-foreground' : 'text-muted-foreground/45'} ${className}`}
      >
        <Camera className="w-3.5 h-3.5" />
      </button>
      {open && <PhotoViewer scoreId={scoreId} caption={caption} onClose={() => setOpen(false)} />}
    </>
  );
}
