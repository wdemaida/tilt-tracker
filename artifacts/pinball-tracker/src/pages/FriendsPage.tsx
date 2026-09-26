import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Loader2, Lock, RotateCw, UserCheck, UserMinus, Users } from 'lucide-react';
import FriendButton from '../components/FriendButton';
import { ChallengeLink } from '../components/ChallengeParts';
import { useApi } from '../lib/useApi';
import { useMyFriends, invalidateFriendQueries } from '../lib/myFriends';
import type { PodUser } from '../lib/api';

// Friends — mutual: you ask, they accept. Your list and your requests are only ever yours. Friends
// show up in the Friends compare view on the machine, venue and stats pages (in the friend color),
// and are who you can challenge (the Challenge button on each friend row).

function errorText(e: unknown, fallback: string): string {
  return (e as any)?.message ?? fallback;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function ago(iso: string) {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

function PersonName({ user }: { user: PodUser }) {
  return (
    <Link href={`/users/${user.username}`} className="min-w-0 group">
      <span className="block text-sm font-medium text-white/90 group-hover:text-white truncate">{user.displayName}</span>
      <span className="block text-xs text-username truncate">@{user.username}</span>
    </Link>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">
        {title}{count !== undefined && <span className="ml-1.5 text-white/60">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

const rowClass = 'flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-card px-4 py-3';

// ── search ─────────────────────────────────────────────────────────────────

function FriendSearch() {
  const api = useApi();
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 250);
  const { data: results = [], isFetching, error } = useQuery({
    queryKey: ['friend-search', q],
    queryFn: () => api.friends.search(q),
    enabled: q.length > 0,
    staleTime: 10_000,
  });

  return (
    <div className="mb-8">
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Find players by name or username…"
        aria-label="Find players to add as friends"
        className="w-full rounded-lg border border-white/10 bg-background px-3 py-2.5 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-friend/60"
      />
      {query.trim().length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {error ? (
            <p className="text-xs text-red-400">{errorText(error, 'Search failed')}</p>
          ) : (isFetching || q !== query.trim()) && results.length === 0 ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Searching…</p>
          ) : results.length === 0 ? (
            <p className="text-xs text-muted-foreground">No players match “{query.trim()}”.</p>
          ) : (
            results.map(u => (
              <div key={u.id} className={rowClass}>
                <PersonName user={u} />
                <FriendButton userId={u.id} name={u.displayName} relationship={u.relationship} size="sm" />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── rows ───────────────────────────────────────────────────────────────────

function OutgoingRow({ user, requestedAt }: { user: PodUser; requestedAt: string }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (action: 'send' | 'cancel') => api.friends[action](user.id),
    onSuccess: () => { setError(null); invalidateFriendQueries(); },
    onError: e => { setError(errorText(e, 'Something went wrong')); invalidateFriendQueries(); },
  });
  return (
    <div className={rowClass}>
      <div className="min-w-0">
        <PersonName user={user} />
        <p className="text-[11px] text-muted-foreground mt-0.5">Sent {ago(requestedAt)}</p>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          disabled={act.isPending}
          onClick={() => act.mutate('send')}
          title="Send it again — it moves back to the top of their notifications"
          aria-label={`Resend your friend request to ${user.displayName}`}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider border border-white/15 text-muted-foreground hover:text-white hover:border-white/30 disabled:opacity-50 transition-colors"
        >
          {act.isPending && act.variables === 'send' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" aria-hidden />} Resend
        </button>
        <button
          type="button"
          disabled={act.isPending}
          onClick={() => act.mutate('cancel')}
          aria-label={`Cancel your friend request to ${user.displayName}`}
          className="px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white disabled:opacity-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FriendRow({ user, since }: { user: PodUser; since: string }) {
  const api = useApi();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.friends.remove(user.id),
    onSuccess: () => { setError(null); invalidateFriendQueries(); },
    onError: e => setError(errorText(e, 'Could not remove friend')),
  });
  return (
    <div className={`${rowClass} flex-wrap`}>
      <div className="flex items-center gap-3 min-w-0">
        <UserCheck className="w-4 h-4 text-friend flex-shrink-0" aria-hidden />
        <div className="min-w-0">
          <PersonName user={user} />
          <p className="text-[11px] text-muted-foreground mt-0.5">Friends since {new Date(since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
        </div>
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
          <span className="text-xs text-muted-foreground">Remove {user.displayName}?</span>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            className="px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
          >
            {remove.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Remove'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          <ChallengeLink friend={user.username} size="sm" />
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Remove ${user.displayName} from your friends`}
            title="Remove friend"
            className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors flex-shrink-0"
          >
            <UserMinus className="w-4 h-4" />
          </button>
        </div>
      )}
      {error && <p className="basis-full text-[11px] text-red-400">{error}</p>}
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

export default function FriendsPage() {
  const { friends, incoming, outgoing, isLoading } = useMyFriends();

  return (
    <div className="max-w-3xl">
      {/* The "Crew" heading and the Friends tab title this page (CrewPage) — no h1 of its own. */}
      {/* Icon + ONE <p>: the text must be a single flex item, or each inline span becomes its own column. */}
      <div className="flex items-start gap-1.5 text-sm text-muted-foreground mb-6">
        <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          Only you can see your <span className="text-friend font-semibold">Friends</span> and requests. Compare
          yourself against your <span className="text-friend font-semibold">Friends</span> on any Machine, or on the Stats page.
        </p>
      </div>

      <FriendSearch />

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : (
        <>
          {incoming.length > 0 && (
            <Section title="Requests for you" count={incoming.length}>
              <div className="flex flex-col gap-2">
                {incoming.map(r => (
                  <div key={r.user.id} className={`${rowClass} flex-wrap`}>
                    <div className="min-w-0">
                      <PersonName user={r.user} />
                      <p className="text-[11px] text-muted-foreground mt-0.5">Asked {ago(r.requestedAt)}</p>
                    </div>
                    <div className="ml-auto">
                      <FriendButton userId={r.user.id} name={r.user.displayName} relationship="incoming" size="sm" />
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Your friends" count={friends.length}>
            {friends.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
                <Users className="w-8 h-8 text-muted-foreground mx-auto mb-3" aria-hidden />
                <p className="text-sm text-white font-bold mb-1">No friends yet</p>
                <p className="text-sm text-muted-foreground">Search above for the people you play with, or tap Add friend on a player’s profile.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {friends.map(f => <FriendRow key={f.user.id} user={f.user} since={f.since} />)}
              </div>
            )}
          </Section>

          {outgoing.length > 0 && (
            <Section title="Sent requests" count={outgoing.length}>
              <div className="flex flex-col gap-2">
                {outgoing.map(r => <OutgoingRow key={r.user.id} user={r.user} requestedAt={r.requestedAt} />)}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  );
}
