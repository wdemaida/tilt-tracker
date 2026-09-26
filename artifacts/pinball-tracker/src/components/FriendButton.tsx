import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check, Loader2, UserCheck, UserPlus, X } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { invalidateFriendQueries } from '../lib/myFriends';
import type { FriendRelationship } from '../lib/api';

function errorText(e: unknown, fallback: string): string {
  return (e as any)?.message ?? fallback;
}

/**
 * The one friend control for a person, for whatever the relationship is right now: Add friend,
 * Requested (+ cancel), Accept / Decline, Friends, or — after the pair's third decline — a quiet
 * "Unavailable" that doesn't say why. Used by the /friends search results and the profile page.
 * Unfriending isn't offered here; it lives on /friends behind a confirm.
 */
export default function FriendButton({ userId, name, relationship, size = 'md' }: {
  userId: number;
  /** For accessible labels ("Accept Finn's request"). */
  name: string;
  relationship: FriendRelationship;
  size?: 'sm' | 'md';
}) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (action: 'send' | 'accept' | 'decline' | 'cancel') => api.friends[action](userId),
    onSuccess: () => { setError(null); invalidateFriendQueries(); },
    onError: (e: any) => {
      // The decline cap: the page will re-read the relationship as 'unavailable'.
      if (e?.code === 'request_unavailable') { setError(null); invalidateFriendQueries(); return; }
      setError(errorText(e, 'Something went wrong'));
    },
  });

  const pad = size === 'sm' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';
  const base = `inline-flex items-center gap-1.5 rounded-lg font-bold uppercase tracking-wider transition-colors disabled:opacity-50 ${pad}`;
  const busy = act.isPending;
  const spin = <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />;

  let body;
  if (relationship === 'friends') {
    body = (
      <span className={`${base} border border-friend/40 bg-friend/10 text-friend`}>
        <UserCheck className="w-3.5 h-3.5" aria-hidden /> Friends
      </span>
    );
  } else if (relationship === 'unavailable') {
    body = <span className={`${base} border border-white/10 text-muted-foreground`}>Unavailable</span>;
  } else if (relationship === 'incoming') {
    body = (
      <span className="inline-flex items-center gap-1.5">
        <button type="button" disabled={busy} onClick={() => act.mutate('accept')} aria-label={`Accept ${name}'s friend request`}
          className={`${base} bg-friend text-zinc-950 hover:opacity-90`}>
          {busy && act.variables === 'accept' ? spin : <Check className="w-3.5 h-3.5" aria-hidden />} Accept
        </button>
        <button type="button" disabled={busy} onClick={() => act.mutate('decline')} aria-label={`Decline ${name}'s friend request`}
          className={`${base} border border-white/15 text-muted-foreground hover:text-white hover:border-white/30`}>
          {busy && act.variables === 'decline' ? spin : <X className="w-3.5 h-3.5" aria-hidden />} Decline
        </button>
      </span>
    );
  } else if (relationship === 'outgoing') {
    body = (
      <span className="inline-flex items-center gap-1.5">
        <span className={`${base} border border-white/10 text-muted-foreground`}>Requested</span>
        <button type="button" disabled={busy} onClick={() => act.mutate('cancel')} aria-label={`Cancel your friend request to ${name}`}
          className={`${base} text-muted-foreground hover:text-white`}>
          {busy ? spin : 'Cancel'}
        </button>
      </span>
    );
  } else {
    body = (
      <button type="button" disabled={busy} onClick={() => act.mutate('send')} aria-label={`Send ${name} a friend request`}
        className={`${base} border border-friend/50 text-friend hover:bg-friend/10`}>
        {busy ? spin : <UserPlus className="w-3.5 h-3.5" aria-hidden />} Add friend
      </button>
    );
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      {body}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </span>
  );
}
