// "Upload the full-size photo" for a score that's already saved — the owner picks an image and it
// goes through exactly the AddScorePage path: prepareUploadImage (HEIC native decoder, then
// heic2any) → encodeFullSizePhoto (canvas re-encode: no EXIF/GPS, ≤ 4096px) → upload-url → PUT to
// R2 → confirm. Used by PhotoViewer (only when the server says `canUpload`) and the Home edit dialog
// (own scores only). The server enforces owner-only, rate limits, size/type and challenge locks
// regardless; this just keeps the button from being offered where it would be refused.

import { useRef, useState } from 'react';
import { Loader2, Upload, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { prepareUploadImage } from '../lib/prepareUploadImage';
import { encodeFullSizePhoto, uploadFullSizePhoto } from '../lib/fullSizePhoto';

type State =
  | { status: 'idle' }
  | { status: 'working'; step: 'preparing' | 'uploading' }
  | { status: 'saved' }
  | { status: 'failed'; message: string };

/** Every query whose rows carry hasFullPhoto / hasThumbnail, plus the viewer's own. */
const PHOTO_LIST_ROOTS = new Set(['scores', 'user', 'machine', 'venue-scores', 'challenges']);

export function invalidatePhotoQueries(scoreId: number) {
  queryClient.invalidateQueries({ queryKey: ['score-photo', scoreId] });
  queryClient.invalidateQueries({ predicate: q => PHOTO_LIST_ROOTS.has(String(q.queryKey[0])) });
}

export function FullPhotoUploadButton({ scoreId, label, variant = 'primary', align = 'center', onUploaded }: {
  scoreId: number;
  label: string;
  align?: 'center' | 'start';
  /** `primary`: the viewer's main call to action. `quiet`: a text link (replace, edit dialog). */
  variant?: 'primary' | 'quiet';
  onUploaded?: () => void;
}) {
  const api = useApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ status: 'idle' });
  const busy = state.status === 'working';

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) {
      return setState({ status: 'failed', message: 'That isn’t a photo — pick an image file.' });
    }
    setState({ status: 'working', step: 'preparing' });
    let encoded = null;
    try {
      encoded = await encodeFullSizePhoto(await prepareUploadImage(file));
    } catch (err) {
      console.warn('Preparing full-size photo failed:', err);
    }
    if (!encoded) {
      return setState({ status: 'failed', message: 'Couldn’t read that photo in this browser — try a JPEG.' });
    }
    setState({ status: 'working', step: 'uploading' });
    const result = await uploadFullSizePhoto(api, scoreId, encoded);
    if (result.ok) {
      setState({ status: 'saved' });
      invalidatePhotoQueries(scoreId);
      onUploaded?.();
    } else {
      setState({
        status: 'failed',
        message: result.disabled ? 'Photo uploads aren’t available right now.' : result.message || 'Upload failed',
      });
    }
  }

  const buttonClass = variant === 'primary'
    ? 'inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-white hover:opacity-90 transition-opacity disabled:opacity-60'
    : 'inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline hover:text-white transition-colors disabled:opacity-60';

  return (
    <div className={`flex flex-col gap-1.5 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.heic,.heif"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; void handleFile(f); }}
      />
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={buttonClass}>
        {busy
          ? <Loader2 className={variant === 'primary' ? 'w-4 h-4 animate-spin' : 'w-3.5 h-3.5 animate-spin'} />
          : <Upload className={variant === 'primary' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />}
        {state.status === 'working'
          ? (state.step === 'preparing' ? 'Preparing photo…' : 'Uploading…')
          : label}
      </button>
      {state.status === 'failed' && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {state.message}
        </p>
      )}
      {state.status === 'saved' && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" /> Full-size photo saved
        </p>
      )}
    </div>
  );
}
