import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { prepareAvatarFile } from '../lib/avatarImage';

// Inline "edit your profile" form in your own profile header (UserPage): display name + photo. The
// username is locked (server: 400 username_locked), so it isn't offered. The photo is uploaded to
// Clerk from a hidden file input — not Clerk's UI, per the mobile sign-in lessons — after a ≤512px
// downscale, then the server re-reads it from Clerk (POST /me/avatar/sync) so it shows at once
// (the user.updated webhook would get there too, a little later).

export const DISPLAY_NAME_MAX = 40; // server: profileFields.ts

export default function ProfileEditForm({ displayName, onDone }: { displayName: string; onDone: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const { user } = useUser();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(displayName);
  const [error, setError] = useState<string | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);

  // A rare action, and the name is embedded in friends/pods/challenges lists: refresh everything.
  const afterChange = (me: unknown) => {
    if (me) qc.setQueryData(['me'], me);
    void qc.invalidateQueries();
  };

  const save = useMutation({
    mutationFn: () => api.users.updateMe({ displayName: name }),
    onSuccess: me => { afterChange(me); onDone(); },
    onError: (e: any) => setError(e?.message ?? 'Couldn’t save'),
  });

  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (!user) throw new Error('Not signed in');
      const upload = file ? await prepareAvatarFile(file) : null;
      await user.setProfileImage({ file: upload });
      await user.reload();
      try {
        return await api.users.syncAvatar();
      } catch {
        // Clerk has it; the webhook / next sign-in will catch the server up.
        setPhotoNote('Photo saved — it may take a minute to show everywhere.');
        return null;
      }
    },
    onMutate: () => { setError(null); setPhotoNote(null); },
    onSuccess: me => afterChange(me),
    onError: (e: any) => setError(e?.errors?.[0]?.longMessage ?? e?.message ?? 'Couldn’t update your photo'),
  });

  const hasPhoto = !!user?.hasImage;
  const busy = save.isPending || photo.isPending;
  const input = 'w-full rounded-lg border border-white/15 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50';
  const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50';

  return (
    <form
      onSubmit={e => { e.preventDefault(); setError(null); save.mutate(); }}
      className="rounded-xl border border-white/10 bg-card p-4 flex flex-col gap-3 max-w-md"
      aria-label="Edit your profile"
    >
      <div>
        <label htmlFor="profile-display-name" className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Display name</label>
        <input id="profile-display-name" value={name} onChange={e => setName(e.target.value)} maxLength={DISPLAY_NAME_MAX}
          autoComplete="nickname" required className={input} />
        <p className="mt-1 text-[11px] text-muted-foreground">Your @username stays the same.</p>
      </div>

      <div>
        <span className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Photo</span>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) photo.mutate(f); }} />
          <button type="button" disabled={busy || !user} onClick={() => fileRef.current?.click()}
            className={`${btn} border border-white/15 text-white hover:bg-white/5`}>
            {photo.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Camera className="w-3.5 h-3.5" aria-hidden />}
            {hasPhoto ? 'Change photo' : 'Add photo'}
          </button>
          {hasPhoto && (
            <button type="button" disabled={busy} onClick={() => photo.mutate(null)}
              className={`${btn} text-muted-foreground hover:text-red-400 hover:bg-red-400/10`}>
              <Trash2 className="w-3.5 h-3.5" aria-hidden /> Remove
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">Only signed-in players see your photo.</p>
        {photoNote && <p className="mt-1 text-xs text-amber-300">{photoNote}</p>}
      </div>

      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={busy || !name.trim()} className={`${btn} bg-primary text-white hover:opacity-90`}>
          {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />} Save
        </button>
        <button type="button" onClick={onDone} disabled={save.isPending}
          className={`${btn} border border-white/10 text-muted-foreground hover:text-white hover:bg-white/5`}>
          Close
        </button>
      </div>
    </form>
  );
}
