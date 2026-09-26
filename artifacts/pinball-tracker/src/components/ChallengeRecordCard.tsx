import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { Flame, Swords } from 'lucide-react';
import { useApi } from '../lib/useApi';
import { CHALLENGE_RECORD_KEY } from '../lib/challenges';
import type { ChallengeRecord } from '../lib/api';

// A profile's challenge record: W–L–T big, the neutral outcomes small, win streaks, and — on someone
// else's profile — your head-to-head against them (the server only ever returns that pair there).
// Signed-in only (the record routes need a user); hidden until someone has finished a challenge.

function Counts({ r }: { r: Pick<ChallengeRecord, 'wins' | 'losses' | 'ties' | 'forfeits' | 'noShows' | 'abandoned'> }) {
  const small = [
    r.abandoned ? `${r.abandoned} abandoned` : null,
    r.noShows ? `${r.noShows} no-show${r.noShows === 1 ? '' : 's'}` : null,
    r.forfeits ? `${r.forfeits} forfeit${r.forfeits === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return (
    <div>
      <p className="text-2xl font-black text-white tracking-wide" aria-label={`${r.wins} wins, ${r.losses} losses, ${r.ties} ties`}>
        <span className="text-emerald-300">{r.wins}</span>
        <span className="text-muted-foreground">–</span>
        <span className="text-red-300">{r.losses}</span>
        <span className="text-muted-foreground">–</span>
        <span className="text-amber-200">{r.ties}</span>
      </p>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">W–L–T{small.length > 0 && <span className="normal-case tracking-normal"> · {small.join(' · ')}</span>}</p>
    </div>
  );
}

export default function ChallengeRecordCard({ username, self }: { username: string; self: boolean }) {
  const api = useApi();
  const { isSignedIn, isLoaded } = useAuth();
  const { data: r } = useQuery({
    queryKey: [...CHALLENGE_RECORD_KEY, self ? '@me' : username],
    queryFn: () => api.challenges.record(self ? undefined : username),
    enabled: isLoaded && !!isSignedIn,
    retry: false,
    staleTime: 60_000,
  });
  // Head-to-head from YOUR side: your own record's row for them (their record's row would be their
  // wins, which reads backwards on their page). Shares the query key with your own profile's card.
  const { data: mine } = useQuery({
    queryKey: [...CHALLENGE_RECORD_KEY, '@me'],
    queryFn: () => api.challenges.record(),
    enabled: isLoaded && !!isSignedIn && !self,
    retry: false,
    staleTime: 60_000,
  });
  if (!r || r.played === 0) return null;
  const h2h = self ? null : mine?.headToHead.find(h => h.opponent.username === username) ?? null;

  return (
    <section className="rounded-xl border border-white/10 bg-card p-4 mb-6">
      <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-1.5">
        <Swords className="w-3.5 h-3.5 text-friend" aria-hidden /> Challenge record
        <span className="text-white/60 normal-case tracking-normal font-normal">· {r.played} played</span>
      </h2>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Counts r={r} />
        <div className="flex gap-6">
          <div>
            <p className="text-2xl font-black text-white flex items-center gap-1">
              {r.currentStreak > 0 && <Flame className="w-5 h-5 text-primary" aria-hidden />}{r.currentStreak}
            </p>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Win streak</p>
          </div>
          <div>
            <p className="text-2xl font-black text-white">{r.bestStreak}</p>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Best streak</p>
          </div>
        </div>
      </div>
      {h2h && h2h.played > 0 && (
        <div className="mt-4 pt-3 border-t border-white/10">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
            <span className="text-username">You</span> vs them · {h2h.played} played
          </p>
          <Counts r={h2h} />
        </div>
      )}
    </section>
  );
}
