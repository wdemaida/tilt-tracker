import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Swords, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { useAppUser } from '../lib/useAppUser';
import { CHALLENGE_AREA_KEY, CHALLENGE_PREFS_KEY } from '../lib/challenges';
import { challengeSetupState, readDismissed, shouldNudge, writeDismissed } from '../lib/challengeSetup';

/**
 * Home's "set up challenges" strip (new-user onboarding). Signed-in users with nothing in "Machines
 * you can get to" — no preferred machine, venue or Last Resort area — see one slim line pointing at
 * their profile's card (`?setup=1` opens it with the intro). "Not now" is remembered per user in
 * localStorage (lib/challengeSetup.ts). Reads prefs + area through the card's own query keys, so a
 * later visit to the card costs nothing, and renders nothing while they load.
 */
export default function ChallengeSetupNudge() {
  const api = useApi();
  const me = useAppUser();
  const userId = me?.id ?? null;
  // Keyed on the user so a sign-out → sign-in as someone else re-reads it.
  const [dismissedFor, setDismissedFor] = useState<{ id: number | null; dismissed: boolean }>({ id: null, dismissed: false });
  const dismissed = userId != null && (dismissedFor.id === userId ? dismissedFor.dismissed : readDismissed(userId));
  const active = !!me && !me.disabledAt && !dismissed;
  const prefs = useQuery({ queryKey: CHALLENGE_PREFS_KEY, queryFn: () => api.challenges.prefs(), staleTime: 60_000, enabled: active });
  const area = useQuery({ queryKey: CHALLENGE_AREA_KEY, queryFn: () => api.challenges.area(), staleTime: 60_000, enabled: active });

  if (!active || !prefs.isSuccess || area.isLoading) return null;
  // An area that failed to load counts as none; failed prefs → no strip (prefs.isSuccess above).
  if (!shouldNudge({ me, state: challengeSetupState(prefs.data, area.data), dismissed })) return null;

  const dismiss = () => { writeDismissed(userId!); setDismissedFor({ id: userId, dismissed: true }); };

  return (
    <div className="flex items-center gap-3 rounded-xl border border-friend/25 bg-friend/5 px-3 py-2.5 mb-4">
      <Swords className="w-4 h-4 text-friend flex-shrink-0" aria-hidden />
      <p className="flex-1 min-w-0 text-xs text-white/85">
        Friends can’t challenge you on nearby machines yet. Add the venues and machines you can get to.
      </p>
      <Link
        href={`/users/${encodeURIComponent(me.username)}?setup=1`}
        className="flex-shrink-0 rounded-lg border border-friend/40 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-friend hover:bg-friend/10 transition-colors"
      >
        Set it up
      </Link>
      <button type="button" onClick={dismiss} aria-label="Not now" className="flex-shrink-0 text-muted-foreground hover:text-white">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
