import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';

type Tier = 'full' | 'city_state' | 'hidden';

export interface EditVenueTarget {
  id: number;
  name: string;
  address: string;
  isResidence: boolean;
  privacyTier: Tier;
  /** "Show my machines/scores publicly" — defaults on. Only meaningful for a private venue. */
  showMachinesAndScores: boolean;
  /** Whether the venue was public when the dialog opened — to warn before it loses its links. */
  wasPublic: boolean;
  hadPinballMap: boolean;
}

/** Builds the dialog's starting state from a venue payload the viewer may edit (`canEdit`). */
export function editTargetFromVenue(v: {
  id: number; name: string; address: string | null; isResidence: boolean; privacyTier?: Tier;
  showMachinesAndScores?: boolean; pinballMapId?: number | null;
}): EditVenueTarget {
  const privacyTier = v.privacyTier ?? 'full';
  return {
    id: v.id,
    name: v.name,
    address: v.address ?? '',
    isResidence: v.isResidence,
    privacyTier,
    showMachinesAndScores: v.showMachinesAndScores ?? true,
    wasPublic: !isPrivateEdit({ isResidence: v.isResidence, privacyTier }),
    hadPinballMap: v.pinballMapId != null,
  };
}

const isPrivateEdit = (v: { isResidence: boolean; privacyTier: string }) => v.isResidence || v.privacyTier !== 'full';

// The Edit Venue dialog — shared by the Venues page and the venue detail page (same permission:
// the server's `canEdit`, i.e. the venue's owner or an admin).
export default function EditVenueDialog({ venue, onClose }: { venue: EditVenueTarget | null; onClose: () => void }) {
  const authApi = useApi();
  const [edit, setEdit] = useState<EditVenueTarget | null>(venue);

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => authApi.venues.patch(id, body),
    onSuccess: () => {
      // A privacy-tier change alters the redacted lat/lng baked into every score at this venue
      // (see venuePrivacy.ts), and the show-publicly switch changes which scores other people get.
      // removeQueries (not just invalidate) for lists that aren't mounted here: the next mount
      // would otherwise render the old cached copy first — a wrong pin, or scores that should now
      // be hidden — before the background refetch lands.
      queryClient.invalidateQueries({ queryKey: ['venues'] });
      queryClient.invalidateQueries({ queryKey: ['venue-scores'] });
      queryClient.invalidateQueries({ queryKey: ['venue-machines'] });
      for (const key of ['scores', 'machine', 'machines', 'user', 'stats']) queryClient.removeQueries({ queryKey: [key] });
      onClose();
    },
  });

  // Re-seed on every open, and drop a previous attempt's error.
  const { reset } = patchMutation;
  useEffect(() => { setEdit(venue); reset(); }, [venue, reset]);

  return (
    <Dialog.Root open={!!edit} onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-5">
            <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white">Edit Venue</Dialog.Title>
            <Dialog.Close className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          {edit && (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</span>
                <input
                  value={edit.name}
                  onChange={e => setEdit({ ...edit, name: e.target.value })}
                  className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Address</span>
                <input
                  value={edit.address}
                  onChange={e => setEdit({ ...edit, address: e.target.value })}
                  className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={edit.isResidence}
                  onChange={e => setEdit({ ...edit, isResidence: e.target.checked, privacyTier: e.target.checked ? edit.privacyTier : 'full' })}
                />
                This is my residence
              </label>
              {edit.isResidence && (
                <div className="flex flex-col gap-1.5 pl-1">
                  <span className="text-xs text-muted-foreground">Show my address as:</span>
                  {([
                    { value: 'full', label: 'Full address' },
                    { value: 'city_state', label: 'City & state only' },
                    { value: 'hidden', label: 'Fully hidden' },
                  ] as const).map(opt => (
                    <label key={opt.value} className="flex items-center gap-2 text-sm text-white/80">
                      <input
                        type="radio"
                        name="editPrivacyTier"
                        checked={edit.privacyTier === opt.value}
                        onChange={() => setEdit({ ...edit, privacyTier: opt.value })}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}
              {/* Only a private venue's owner can hide its machines and scores — a public venue's
                  scores belong to everyone who played there (the server ignores it there too). */}
              {isPrivateEdit(edit) && (
                <label className="flex items-start gap-2 text-sm text-white/80">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={edit.showMachinesAndScores}
                    onChange={e => setEdit({ ...edit, showMachinesAndScores: e.target.checked })}
                  />
                  <span>
                    Show my machines/scores publicly
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {edit.showMachinesAndScores
                        ? 'Anyone can see the machines here and the scores logged here. Your address stays as set above.'
                        : 'Only you (and admins) see the machines and scores here. Players still see their own scores.'}
                    </span>
                  </span>
                </label>
              )}
              {edit.wasPublic && isPrivateEdit(edit) && (
                // The server clears hereId / pinballMapId in the same save; they don't come back.
                <p className="text-xs rounded-lg bg-amber-500/10 text-amber-400 px-3 py-2">
                  Switching to private removes this venue’s Pinball Map and HERE links
                  {edit.hadPinballMap ? ' — its machine list will no longer come from Pinball Map' : ''}.
                  Switching back later won’t restore them.
                </p>
              )}
              {patchMutation.isError && (
                <p className="text-xs text-red-400">{(patchMutation.error as any)?.message}</p>
              )}
              <div className="flex gap-3 pt-1">
                <Dialog.Close className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
                  Cancel
                </Dialog.Close>
                <button
                  onClick={() => patchMutation.mutate({
                    id: edit.id,
                    body: {
                      name: edit.name, address: edit.address, isResidence: edit.isResidence, privacyTier: edit.privacyTier,
                      showMachinesAndScores: edit.showMachinesAndScores,
                    },
                  })}
                  disabled={patchMutation.isPending}
                  className="flex-1 py-2.5 rounded-lg bg-primary text-white font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {patchMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
