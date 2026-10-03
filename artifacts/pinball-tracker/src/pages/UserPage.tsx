import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useUser } from '@clerk/clerk-react';
import { useParams, Link, useLocation, useSearch } from 'wouter';
import { MapPin, Clock, Home, Pencil } from 'lucide-react';
import { useAppUser } from '../lib/useAppUser';
import UserAvatar from '../components/UserAvatar';
import ProfileEditForm from '../components/ProfileEditForm';
import { formatScoreTime, zoneAbbreviation } from '../lib/scoreTime';
import { useApi } from '../lib/useApi';
import { usePodMembership } from '../lib/myPods';
import PodMemberIcons from '../components/PodMemberIcons';
import FriendButton from '../components/FriendButton';
import ChallengeRecordCard from '../components/ChallengeRecordCard';
import { ChallengeMeChips, ChallengeMeEditor } from '../components/ChallengeMeCard';
import { ChallengeLink } from '../components/ChallengeParts';
import { FRIEND_WITH_KEY } from '../lib/myFriends';
import { FullPhotoButton } from '../components/PhotoViewer';
import BadgeShelf from '../components/BadgeShelf';
import VenueName from '../components/VenueName';

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

  const me = useAppUser();
  const { user: clerkUser } = useUser();
  const [editing, setEditing] = useState(false);
  // Navigating from your profile to someone else's must not carry the open form along.
  useEffect(() => setEditing(false), [username]);
  // `?setup=1` (from /setup and the Home nudge): open "Machines you can get to" with its intro. Held
  // for the profile it arrived on, then stripped from the URL so a reload or share doesn't repeat it.
  const search = useSearch();
  const [location, navigate] = useLocation();
  const [introFor] = useState(() => new URLSearchParams(search).get('setup') === '1' ? username : null);
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (!params.has('setup')) return;
    params.delete('setup');
    const rest = params.toString();
    navigate(rest ? `${location}?${rest}` : location, { replace: true });
  }, [search, location]);

  if (isLoading) return <p className="text-muted-foreground">Loading...</p>;
  if (!data) return <p className="text-muted-foreground">User not found.</p>;

  const { user, scores } = data;

  // Your own profile: the photo comes live from Clerk (an upload shows at once; Clerk's generated
  // default — hasImage false — is never shown). Anyone else's: the server's imageUrl, which it only
  // sends to signed-in viewers.
  const isSelf = !!me && me.username === user.username;
  const imageUrl = isSelf && clerkUser ? (clerkUser.hasImage ? clerkUser.imageUrl : null) : (user.imageUrl ?? null);

  return (
    <div>
      {/* Phone: identity → (edit form) → badges → actions, stacked. md+: badges right-justified in a
          second column beside the name, spanning the identity and actions rows. */}
      <header className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-3 mb-8">
        <div className="flex items-center gap-4 min-w-0 md:col-start-1">
          <UserAvatar imageUrl={imageUrl} size="lg" />
          <div className="min-w-0">
            <div className="flex items-start gap-2">
              <h1 className="text-2xl sm:text-3xl font-black uppercase tracking-wide sm:tracking-widest text-white [overflow-wrap:anywhere]">{user.displayName}</h1>
              {isSelf && !editing && (
                <button type="button" onClick={() => setEditing(true)} aria-label="Edit your profile" title="Edit your name and photo"
                  className="mt-1 p-1.5 rounded text-muted-foreground hover:text-white hover:bg-white/5 transition-colors flex-shrink-0">
                  <Pencil className="w-4 h-4" />
                </button>
              )}
            </div>
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 flex-wrap">
              <span className="text-username">@{user.username}</span>
              <PodMemberIcons pods={podMembership.get(user.username)} />
              <span>· {scores.length} scores</span>
            </p>
          </div>
        </div>
        {isSelf && editing && (
          <div className="md:col-start-1">
            <ProfileEditForm displayName={user.displayName} onDone={() => setEditing(false)} />
          </div>
        )}
        {/* Public — anyone who can see the profile sees the badges. Below md it's indented to the name
            column: the lg avatar's width plus the row's gap-4 (w-16 → pl-20, sm:w-20 → sm:pl-24). */}
        <BadgeShelf username={user.username} variant="header"
          className="pl-20 sm:pl-24 md:pl-0 md:col-start-2 md:row-start-1 md:row-span-2 md:justify-self-end md:max-w-[22rem]" />
        {friendship && friendship.relationship !== 'self' && (
          <div className="md:col-start-1 flex flex-wrap items-center gap-2">
            <FriendButton userId={friendship.user.id} name={friendship.user.displayName} relationship={friendship.relationship} />
            {friendship.relationship === 'friends' && <ChallengeLink friend={friendship.user.username} />}
          </div>
        )}
      </header>

      {/* Signed-in only; hidden until they've finished a challenge. */}
      {isSignedIn && friendship && (
        <ChallengeRecordCard username={user.username} self={friendship.relationship === 'self'} />
      )}

      {/* Yours: edit what friends get recommended. A friend's: their "Challenge me on" machines (the
          server only sends challengeMe to accepted friends). */}
      {isSignedIn && friendship?.relationship === 'self' && <ChallengeMeEditor where="profile" intro={isSelf && introFor === username} />}
      {isSignedIn && friendship?.relationship === 'friends' && data.challengeMe && (
        <ChallengeMeChips username={user.username} machines={data.challengeMe} />
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
              {/* Phone: the name never gets narrower than its longest word (min-width auto = min-content,
                  capped at the row by max-w-full); when that word plus the photo/type chips won't fit, the
                  chips wrap under the name. Squeezed below it, break-words split "TRANSFORMERS" from its
                  ":". The clamp sits on an inner span because overflow:hidden zeroes a flex item's auto
                  min-width. sm+: unchanged — the name shrinks beside the chips. */}
              <div className="flex flex-wrap sm:flex-nowrap items-start justify-between sm:justify-start gap-2 min-w-0">
                <Link href={`/machines/${encodeURIComponent(s.machineName)}`} className="basis-0 grow max-w-full sm:basis-auto sm:grow-0 sm:min-w-0 text-sm font-bold uppercase tracking-wider text-machine hover:text-machine/80 transition-colors">
                  <span className="line-clamp-2 break-words">{s.machineName}</span>
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
                    <VenueName
                      name={s.venueName}
                      ownerUsername={s.venueOwnerUsername}
                      href={s.venueId != null ? `/venues/${s.venueId}` : undefined}
                      className="truncate"
                    />
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
