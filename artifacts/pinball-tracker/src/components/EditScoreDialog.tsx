import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { invalidateChallengeQueries } from '../lib/challenges';
import type { ChallengeFit } from '../lib/api';
import ScoreRepairSection from './ScoreRepairSection';
import ScoreVenuePicker from './ScoreVenuePicker';
import { FullPhotoUploadButton } from './FullPhotoUpload';
import ChallengeFitSummary from './ChallengeFitSummary';
import { toLocalInput, localInputToIso } from '../lib/datetime';

// The one edit-score dialog: Home's score cards open it, and so does Add Score's "Edit played time"
// (a score that missed its challenges because of an old photo's EXIF time). PATCH /api/scores/:id
// returns how the score now fares in its author's challenges (`challenges`); when there are any, the
// dialog stays open on that summary instead of closing, so the player sees whether the fix worked.

export interface EditScoreTarget {
  id: number;
  machineId: number;
  machineName: string;
  score: number;
  type: 'casual' | 'tournament';
  playedAt: string;
  venueId: number | null;
  venueName: string | null;
  venueTimezone: string | null;
  hasFullPhoto: boolean;
  /** The server only lets a score's owner upload its photo — admins editing others' scores can't. */
  isOwn: boolean;
}

/** What a save changed, for a caller showing the score (Add Score's step 4). */
export interface EditScoreSaved {
  machineId: number;
  machineName: string;
  score: number;
  type: 'casual' | 'tournament';
  playedAt: string;
  venueId: number | null;
  venueName: string | null;
  venueTimezone: string | null;
  challenges: ChallengeFit[];
}

export default function EditScoreDialog({ score, onClose, onSaved }: {
  score: EditScoreTarget | null;
  onClose: () => void;
  onSaved?: (saved: EditScoreSaved) => void;
}) {
  const authApi = useApi();
  const [editScore, setEditScore] = useState<EditScoreTarget | null>(score);
  const [editScoreVal, setEditScoreVal] = useState('');
  const [editType, setEditType] = useState<'casual' | 'tournament'>('casual');
  const [editPlayedAt, setEditPlayedAt] = useState('');
  const [editMachineSearch, setEditMachineSearch] = useState('');
  /** Set after a save that reported challenges: the dialog shows the summary instead of the form. */
  const [saved, setSaved] = useState<EditScoreSaved | null>(null);

  function load(s: EditScoreTarget) {
    setEditScore(s);
    setEditScoreVal(Number(s.score).toLocaleString());
    setEditType(s.type);
    setEditPlayedAt(toLocalInput(s.playedAt, s.venueTimezone));
    setEditMachineSearch(s.machineName);
  }

  const { data: machineSuggestions = [] } = useQuery({
    queryKey: ['machine-search-edit', editMachineSearch],
    queryFn: () => authApi.machines.search(editMachineSearch),
    enabled: !!editScore && editMachineSearch.length > 1 && editMachineSearch !== editScore?.machineName,
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => authApi.scores.patch(id, body),
    onSuccess: (row, { body }) => {
      queryClient.invalidateQueries({ queryKey: ['scores'] });
      queryClient.invalidateQueries({ queryKey: ['machines'] });
      if (!editScore) return;
      const challenges = Array.isArray(row?.challenges) ? row.challenges : [];
      const next: EditScoreTarget = {
        ...editScore,
        machineId: body.machineId ?? editScore.machineId,
        machineName: editMachineSearch,
        score: body.score ?? editScore.score,
        type: body.type ?? editScore.type,
        playedAt: typeof row?.playedAt === 'string' ? row.playedAt : body.playedAt,
      };
      onSaved?.({
        machineId: next.machineId, machineName: next.machineName, score: next.score, type: next.type, playedAt: next.playedAt,
        venueId: next.venueId, venueName: next.venueName, venueTimezone: next.venueTimezone, challenges,
      });
      if (!challenges.length) { onClose(); return; }
      // An edit can make it count (and lock it) — the challenge pages and the bell may have changed.
      invalidateChallengeQueries();
      setEditScore(next);
      setSaved({
        machineId: next.machineId, machineName: next.machineName, score: next.score, type: next.type, playedAt: next.playedAt,
        venueId: next.venueId, venueName: next.venueName, venueTimezone: next.venueTimezone, challenges,
      });
    },
  });

  useEffect(() => {
    setSaved(null);
    patchMutation.reset();
    if (score) load(score);
    else setEditScore(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  async function handleSave() {
    if (!editScore) return;
    let resolvedMachineId = editScore.machineId;
    if (editMachineSearch !== editScore.machineName) {
      const machine = await authApi.machines.upsert({ name: editMachineSearch });
      resolvedMachineId = machine.id;
    }
    patchMutation.mutate({
      id: editScore.id,
      body: {
        score: Number(editScoreVal.replace(/,/g, '')),
        type: editType,
        playedAt: localInputToIso(editPlayedAt, editScore.venueTimezone),
        ...(resolvedMachineId !== editScore.machineId && { machineId: resolvedMachineId }),
      },
    });
  }

  return (
    <Dialog.Root open={!!score} onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-card p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-5">
            <Dialog.Title className="text-lg font-black uppercase tracking-wider text-white">{saved ? 'Score Updated' : 'Edit Score'}</Dialog.Title>
            <Dialog.Close className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-white hover:bg-white/10 transition-colors">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          {saved ? (
            <div className="flex flex-col gap-4">
              <ChallengeFitSummary
                fits={saved.challenges}
                playedAt={saved.playedAt}
                venueTimezone={saved.venueTimezone}
                onEditPlayedTime={editScore ? () => { load(editScore); setSaved(null); } : undefined}
              />
              <Dialog.Close className="w-full py-2.5 rounded-lg bg-primary text-white font-bold text-sm hover:opacity-90 transition-opacity">
                Done
              </Dialog.Close>
            </div>
          ) : (
          <div className="flex flex-col gap-4">
            {/* Machine */}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Machine</span>
              <div className="relative">
                <input
                  value={editMachineSearch}
                  onChange={e => setEditMachineSearch(e.target.value)}
                  placeholder="Search machines..."
                  className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                />
                {(machineSuggestions as any[]).length > 0 && editMachineSearch !== editScore?.machineName && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-10 rounded-lg border border-white/10 bg-card overflow-hidden shadow-xl">
                    {(machineSuggestions as any[]).slice(0, 6).map((m: any) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setEditMachineSearch(m.name)}
                        className="w-full text-left px-4 py-2 text-sm text-white hover:bg-white/10 transition-colors"
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </label>

            {/* Score */}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Score</span>
              <input
                type="text"
                inputMode="numeric"
                value={editScoreVal}
                onChange={e => {
                  const raw = e.target.value.replace(/[^0-9]/g, '');
                  setEditScoreVal(raw ? Number(raw).toLocaleString() : '');
                }}
                className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
              />
            </label>

            {/* Type */}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Type</span>
              <select
                value={editType}
                onChange={e => setEditType(e.target.value as 'casual' | 'tournament')}
                className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
              >
                <option value="casual">Casual</option>
                <option value="tournament">Tournament</option>
              </select>
            </label>

            {/* Date & Time — in the venue's zone, like the card (frontend CLAUDE.md "Time zones"). */}
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Date & Time</span>
              <input
                type="datetime-local"
                value={editPlayedAt}
                onChange={e => setEditPlayedAt(e.target.value)}
                className="rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
              />
            </label>

            {/* Venue + linkage. The modal used to drop the venue entirely, which made it
                impossible to tell why a machine couldn't be verified. */}
            {editScore && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Venue</span>
                {editScore.venueId != null ? (
                  <ScoreRepairSection
                    scoreId={editScore.id}
                    onMachineRepaired={name => setEditMachineSearch(name)}
                  />
                ) : (
                  <ScoreVenuePicker
                    scoreId={editScore.id}
                    venueNameSnapshot={editScore.venueName}
                    onAttached={venue => {
                      setEditScore(prev => (prev
                        ? { ...prev, venueId: venue.id, venueName: venue.name, venueTimezone: venue.timezone ?? null }
                        : prev));
                      setEditPlayedAt(toLocalInput(editScore.playedAt, venue.timezone));
                    }}
                  />
                )}
              </div>
            )}

            {/* Full-size photo: the same upload as the photo viewer's button, reachable here for
                scores with no photo at all (which have nothing to tap on the card). */}
            {editScore?.isOwn && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Photo</span>
                <FullPhotoUploadButton
                  scoreId={editScore.id}
                  variant="quiet"
                  align="start"
                  label={editScore.hasFullPhoto ? 'Replace the full-size photo' : 'Upload the full-size photo'}
                />
              </div>
            )}

            {patchMutation.isError && (
              <p className="text-xs text-red-400">{(patchMutation.error as any)?.message}</p>
            )}
            <div className="flex gap-3 pt-1">
              <Dialog.Close className="flex-1 py-2.5 rounded-lg border border-white/10 text-sm text-muted-foreground hover:text-white transition-colors">
                Cancel
              </Dialog.Close>
              <button
                onClick={handleSave}
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
