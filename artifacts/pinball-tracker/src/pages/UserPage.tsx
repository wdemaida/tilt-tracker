import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useParams, Link } from 'wouter';
import { User, MapPin, Clock, Home } from 'lucide-react';
import { formatScoreTime, zoneAbbreviation } from '../lib/scoreTime';
import { useApi } from '../lib/useApi';
import { usePodMembership } from '../lib/myPods';
import PodMemberIcons from '../components/PodMemberIcons';
import FriendButton from '../components/FriendButton';
import ChallengeRecordCard from '../components/ChallengeRecordCard';
import { ChallengeLink } from '../components/ChallengeParts';
import { FRIEND_WITH_KEY } from '../lib/myFriends';
import { FullPhotoButton } from '../components/PhotoViewer';

export default function UserPage() {
  const { username } = useParams<{ username: string }>();
  // Authenticated when signed in: your own profile includes scores at home venues whose owner
  // keeps them private; other people's doesn't.
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['user', username],
    queryFn: () => api.users.get(username),
  });
  // Only the viewer's own pods; empty for signed-out viewers and on your own profile. Every score on
  // this page is the profile user's, so the header is the only place the icons go.
  const podMembership = usePodMembership();
  // The viewer's relationship with this person, for the Add friend / request status button. Signed
  // in only; answers 'self' on your own profile, where no button shows.
  const { isSignedIn, isLoaded } = useAuth();
  const { data: friendship } = useQuery({
    queryKey: [...FRIEND_WITH_KEY, username],
    queryFn: () => api.friends.with(username),
    enabled: isLoaded && !!isSignedIn,
    retry: false,
  });

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">User not found.</p>;

  const { user, scores } = data;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 mb-8">
        <div className="w-14 h-14 rounded-full bg-card border border-white/10 flex items-center justify-center">
          <User className="w-7 h-7 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-black uppercase tracking-wide sm:tracking-widest text-white [overflow-wrap:anywhere]">{user.displayName}</h1>
          <p className="text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
            <span className="text-username">@{user.username}</span>
            <PodMemberIcons pods={podMembership.get(user.username)} />
            <span>· {scores.length} scores</span>
          </p>
        </div>
        {friendship && friendship.relationship !== 'self' && (
          <div className="sm:ml-auto flex flex-wrap items-center gap-2">
            <FriendButton userId={friendship.user.id} name={friendship.user.displayName} relationship={friendship.relationship} />
            {friendship.relationship === 'friends' && <ChallengeLink friend={friendship.user.username} />}
          </div>
        )}
      </div>

      {/* Signed-in only; hidden until they've finished a challenge. */}
      {isSignedIn && friendship && (
        <ChallengeRecordCard username={user.username} self={friendship.relationship === 'self'} />
      )}

      <div className="flex flex-col gap-3">
        {scores.map((s: any) => {
          // Only shown when the venue's clock differs from the reader's, as on ScoreCard.
          const zone = zoneAbbreviation(s.playedAt, s.venueTimezone);
          return (
          <div key={s.id} className="flex items-start gap-3 sm:gap-4 rounded-xl border border-white/10 bg-card p-4 hover:border-primary/40 transition-colors">
            <div className="w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 border border-white/10 bg-white/5">
              {s.machineImageUrl ? (
                <img src={s.machineImageUrl} alt={s.machineName} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-bold text-center leading-tight p-1">
                  {s.machineName.split(' ').slice(0, 2).join('\n')}
                </div>
              )}
            </div>
            {/* Phone: name + badge, score, then meta, stacked. sm+: the score moves to a right-hand
                column spanning both text rows. Explicit placement puts the meta back in column 1. */}
            <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4">
              <div className="flex items-start justify-between sm:justify-start gap-2 min-w-0">
                <Link href={`/machines/${encodeURIComponent(s.machineName)}`} className="min-w-0 line-clamp-2 break-words text-sm font-bold uppercase tracking-wider text-machine hover:text-machine/80 transition-colors">
                  {s.machineName}
                </Link>
                <span className="flex-shrink-0 inline-flex items-center gap-1">
                  <FullPhotoButton
                    scoreId={s.id}
                    hasFullPhoto={s.hasFullPhoto}
                    hasThumbnail={s.hasThumbnail}
                    caption={{ machineName: s.machineName, score: s.score, playedAt: s.playedAt, venueTimezone: s.venueTimezone, username: user.username }}
                  />
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground border border-white/20 rounded px-1.5 py-0.5">
                    {s.type}
                  </span>
                </span>
              </div>
              <p className="mt-1 sm:mt-0 text-2xl sm:text-3xl font-black text-primary sm:col-start-2 sm:row-start-1 sm:row-span-2 sm:self-center sm:text-right whitespace-nowrap">
                {Number(s.score).toLocaleString()}
              </p>
              <div className="mt-1.5 flex flex-col gap-1 text-xs text-muted-foreground min-w-0">
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3 flex-shrink-0" />
                  <span>{formatScoreTime(s.playedAt, s.venueTimezone, 'MMM d, yyyy · h:mm a')}</span>
                  {zone && <span className="text-muted-foreground/60">{zone}</span>}
                </div>
                {s.venueName && (
                  <div className="flex items-center gap-1 text-venue min-w-0">
                    <MapPin className="w-3 h-3 flex-shrink-0" />
                    {s.venueId != null ? (
                      <Link href={`/venues/${s.venueId}`} className="truncate hover:text-venue/80 transition-colors">
                        {s.venueName}
                      </Link>
                    ) : (
                      <span className="truncate">{s.venueName}</span>
                    )}
                    {s.venueIsResidence && <Home className="w-3 h-3 flex-shrink-0" />}
                  </div>
                )}
              </div>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
