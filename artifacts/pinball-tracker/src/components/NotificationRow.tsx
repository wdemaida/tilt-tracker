import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { Award, Ban, Bell, Flag, Lightbulb, Megaphone, Play, Swords, Timer, Trophy, TrendingUp, UserCheck, UserPlus } from 'lucide-react';
import type { AppNotification, ChallengeType } from '../lib/api';
import { TYPE_META } from '../lib/challenges';
import { isInternalPath } from '../lib/internalPath';

// One inbox row — what a notification says, where it goes, and how it looks. Moved out of
// NotificationsPage.tsx (2026-10-03) so the admin announcement composer can preview a row exactly
// as players will see it.

/** 1st, 2nd, 3rd … (group results). */
function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

const COUNTER_CLOSED: Record<string, string> = {
  rejected: 'kept their original',
  superseded: 'took another suggestion',
  started: 'started the original without it',
  cancelled: 'cancelled the challenge',
  expired: 'let it lapse',
};

const RESULT_TEXT: Record<string, string> = {
  win: 'You won',
  loss: 'You lost',
  tie: 'It’s a tie',
  forfeit: 'You forfeited',
  no_show: 'No score from you',
  abandoned: 'Abandoned',
};

/** What one notification says and where it goes. Unknown kinds (from a newer server) still render. */
export function describe(n: AppNotification): { text: React.ReactNode; href: string | null; Icon: typeof Bell } {
  // Their name plus @handle, like the Friends cards. (A plain @handle, not a UsernameLink: the whole
  // row is already a link.)
  const { displayName, username } = n.payload;
  const name = displayName || username ? (
    <>
      {displayName && <span className="font-semibold text-white">{displayName}</span>}
      {displayName && username && ' '}
      {username && <span className="text-username">@{username}</span>}
    </>
  ) : <span className="font-semibold text-white">Someone</span>;
  switch (n.kind) {
    case 'friend_request':
      return { text: <>{name} sent you a friend request</>, href: '/friends', Icon: UserPlus };
    case 'friend_accepted':
      return {
        text: <>{name} accepted your friend request</>,
        href: n.payload.username ? `/users/${n.payload.username}` : '/friends',
        Icon: UserCheck,
      };
    case 'badge_earned': {
      const badgeName = typeof n.payload.badgeName === 'string' ? n.payload.badgeName : 'a';
      return {
        text: <>You {n.payload.granted ? 'were awarded' : 'earned'} the <span className="font-semibold text-white">{badgeName}</span> badge</>,
        href: '/badges', Icon: Award,
      };
    }
  }

  // Challenge kinds — each links to the challenge page (/challenges/:id).
  if (n.kind.startsWith('challenge_')) {
    const { challengeId, challengeType, machineName } = n.payload;
    const href = typeof challengeId === 'number' ? `/challenges/${challengeId}` : null;
    const what = (
      <>
        {challengeType ? <>{TYPE_META[challengeType as ChallengeType]?.label ?? 'A'} challenge</> : 'A challenge'}
        {machineName && <> on <span className="text-machine font-semibold">{machineName}</span></>}
      </>
    );
    switch (n.kind) {
      case 'challenge_received': {
        const players = typeof n.payload.players === 'number' ? n.payload.players : 2;
        return { text: <>{name} challenged you{players > 2 ? <> and {players - 2} {players === 3 ? 'other' : 'others'}</> : null}: {what}</>, href, Icon: Swords };
      }
      case 'challenge_accepted':
        return { text: <>{name} accepted your challenge: {what}</>, href, Icon: Swords };
      case 'challenge_declined':
        // Neutral on purpose: "can't get to it" isn't a refusal, and "passed" isn't a snub.
        // reason 'backed_out' (older notifications only carry backedOut): an accepted player left before the start.
        if (n.payload.reason === 'backed_out' || n.payload.backedOut) return { text: <>{name} backed out of {what}</>, href, Icon: Ban };
        return n.payload.reason === 'cant_reach'
          ? { text: <>{name} can’t get to the machine for {what}</>, href, Icon: Ban }
          : n.payload.reason === 'no_thanks'
            ? { text: <>{name} passed on {what}</>, href, Icon: Ban }
            : { text: <>{name} declined your challenge: {what}</>, href, Icon: Ban };
      case 'challenge_countered': {
        // challengeId is the suggestion (a proposal — or, for an older one, the new challenge): the
        // link goes there to take it or keep yours.
        const original = typeof n.payload.originalMachineName === 'string' ? n.payload.originalMachineName : null;
        return {
          text: <>{n.payload.reminder && <span className="text-amber-200">Still waiting on you: </span>}{name} can’t get to {original ? <span className="text-machine font-semibold">{original}</span> : 'your machine'} and suggested {what} instead</>,
          href, Icon: Lightbulb,
        };
      }
      case 'challenge_counter_accepted':
        return { text: <>{name} took your suggestion — everyone moves to {what}</>, href, Icon: Swords };
      case 'challenge_counter_rejected': {
        const why = COUNTER_CLOSED[String(n.payload.reason)] ?? 'didn’t take it';
        return { text: <>Your suggestion of {what} wasn’t taken — {name} {why}</>, href, Icon: Ban };
      }
      case 'challenge_moved': {
        const original = typeof n.payload.originalMachineName === 'string' ? n.payload.originalMachineName : null;
        const by = n.payload.proposedBy as { username?: string } | null | undefined;
        return {
          text: <>{name}’s challenge{original && <> on <span className="text-machine font-semibold">{original}</span></>} moved{by?.username && <> (<span className="text-username">@{by.username}</span>’s suggestion)</>} — you’re invited again: {what}</>,
          href, Icon: Swords,
        };
      }
      case 'challenge_started': {
        const players = typeof n.payload.players === 'number' ? n.payload.players : null;
        return { text: <>It’s on{players ? <> — {players} players</> : null}: {what}</>, href, Icon: Play };
      }
      case 'challenge_missed':
        return { text: <>{what} started without you — you didn’t answer in time</>, href, Icon: Timer };
      case 'challenge_cancelled':
        return { text: <>{name} withdrew their challenge: {what}</>, href, Icon: Ban };
      case 'challenge_voided':
        return { text: <>An admin voided {what} — it won’t count toward anyone’s record</>, href, Icon: Ban };
      case 'challenge_opponent_scored': {
        const score = n.payload.score;
        const scoreText = typeof score === 'number' ? <span className="text-primary font-semibold">{Math.round(score).toLocaleString()}</span> : 'a score';
        // One notice per score (2026-09-30): `challengeCount` is how many of your challenges it counts
        // in. Older notices have no count — one challenge.
        const count = typeof n.payload.challengeCount === 'number' ? n.payload.challengeCount : 1;
        if (count > 1) {
          const machine = typeof n.payload.scoreMachineName === 'string' ? n.payload.scoreMachineName : machineName;
          return {
            text: <>{name} posted {scoreText}{machine && <> on <span className="text-machine font-semibold">{machine}</span></>} — counts in {count} of your challenges</>,
            href: '/crew?tab=challenges', Icon: TrendingUp,
          };
        }
        return { text: <>{name} posted {scoreText} in your challenge: {what}</>, href, Icon: TrendingUp };
      }
      case 'challenge_ending_soon':
        return { text: <>Less than a day left: {what}</>, href, Icon: Timer };
      case 'challenge_result': {
        const count = typeof n.payload.playerCount === 'number' ? n.payload.playerCount : 2;
        const rank = typeof n.payload.rank === 'number' ? n.payload.rank : null;
        // Only players with a counting score are ranked (newer servers say who posted; older ones don't).
        const postedCount = typeof n.payload.postedCount === 'number' ? n.payload.postedCount : null;
        const placed = count > 2 && rank != null && n.payload.posted !== false
          && (n.payload.outcome === 'loss' || n.payload.outcome === 'tie' || n.payload.outcome === 'win');
        const outcome = n.payload.void ? 'Nobody played, so no result'
          : placed ? (postedCount != null && postedCount < count ? `You placed ${ordinal(rank!)} of ${postedCount} who posted` : `You placed ${ordinal(rank!)} of ${count}`)
          : RESULT_TEXT[String(n.payload.outcome)] ?? 'Challenge over';
        return { text: <>{outcome}: {what}</>, href, Icon: n.payload.outcome === 'win' ? Trophy : Flag };
      }
      default:
        return { text: <>{what} was updated</>, href, Icon: Swords };
    }
  }
  return { text: 'You have a new notification', href: null, Icon: Bell };
}

/**
 * An admin announcement: signed "TiltTrack", bold title, the body as plain text with its line breaks
 * kept (React escapes it — never HTML), and a link only when it passes isInternalPath (the server
 * validated it on send; this re-checks).
 */
function AnnouncementRow({ n, preview }: { n: AppNotification; preview: boolean }) {
  const p = n.payload;
  const title = typeof p.title === 'string' ? p.title : 'Announcement';
  const body = typeof p.body === 'string' ? p.body : '';
  const link = typeof p.link === 'string' ? p.link : null;
  const href = !preview && isInternalPath(link) ? link : null;
  const unread = !n.readAt;
  const inner = (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
      unread ? 'border-primary/50 bg-primary/10' : 'border-primary/25 bg-card'
    } ${href ? 'hover:border-primary/70' : ''}`}>
      <Megaphone className={`w-4 h-4 mt-0.5 flex-shrink-0 ${unread ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-bold uppercase tracking-wider text-primary">TiltTrack</p>
        <p className="text-sm font-bold text-white break-words">{title}</p>
        {body && <p className="text-sm text-white/80 whitespace-pre-line break-words mt-0.5">{body}</p>}
        <p className="text-[11px] text-muted-foreground mt-1">
          {preview ? 'just now' : formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
          {href && <span className="text-primary"> · Open</span>}
          {preview && link && <span className="text-primary break-all"> · links to {link}</span>}
        </p>
      </div>
      {unread && <span className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" aria-label="New" />}
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}

/** `preview`: render without linking (the admin composer's live preview). */
export default function NotificationRow({ n, preview = false }: { n: AppNotification; preview?: boolean }) {
  if (n.kind === 'announcement') return <AnnouncementRow n={n} preview={preview} />;
  const { text, href: target, Icon } = describe(n);
  const href = preview ? null : target;
  const unread = !n.readAt;
  const inner = (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
      unread ? 'border-friend/40 bg-friend/5' : 'border-white/10 bg-card'
    } ${href ? 'hover:border-white/25' : ''}`}>
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${unread ? 'text-friend' : 'text-muted-foreground'}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white/80">{text}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}</p>
      </div>
      {unread && <span className="w-2 h-2 rounded-full bg-friend mt-1.5 flex-shrink-0" aria-label="New" />}
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}
