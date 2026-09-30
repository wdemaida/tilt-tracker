import { useState } from 'react';
import { Link } from 'wouter';
import { ChevronDown, Clock, Swords } from 'lucide-react';
import type { ChallengeFit } from '../lib/api';
import { formatScoreTime } from '../lib/scoreTime';
import { typeLabel } from '../lib/challenges';
import { isLockedPlayedAt, lockedFromLabel, type PlayedAtSource } from '../lib/captureTime';

// "How did this score fare in my challenges?" — shown on Add Score's "Score saved" step and in the
// edit-score dialog after a save (POST / PATCH /api/scores return `challenges`). The server decides
// (challengeRules.ts scoreChallengeFits, the same rules as the standings); this only words it.
// Challenges with the same outcome and reason share one line; tap a line for the challenges in it.
// Nothing renders when the score's machine has no challenges.
//
// A camera-recorded played time (playedAtSource photo / video) can't be edited by the player, so its
// played-time lines say where the time came from — "played May 2, before they started (time from your
// photo)" — and the caller leaves out onEditPlayedTime (only an admin can correct it).

/** The reasons an edit of the played time can fix — the only thing the "Edit played time" action offers. */
const TIME_REASONS = new Set(['played_before_start', 'played_after_end']);

interface Group { key: string; status: string; reason: string; fits: ChallengeFit[] }

function groupFits(fits: ChallengeFit[]): Group[] {
  const map = new Map<string, Group>();
  for (const f of fits) {
    const key = `${f.status}|${f.reason}`;
    const g = map.get(key) ?? { key, status: f.status, reason: f.reason, fits: [] };
    g.fits.push(f);
    map.set(key, g);
  }
  // What needs doing first, then what's waiting, then what counted.
  const rank = (s: string) => (s === 'not_counted' ? 0 : s === 'not_started' ? 1 : 2);
  return [...map.values()].sort((a, b) => rank(a.status) - rank(b.status));
}

/** "Munsters (Pro)" — the leading "The" reads badly after "your". Several machines → none named. */
function machineLabel(fits: ChallengeFit[]): string {
  const names = [...new Set(fits.map(f => f.machineName))];
  return names.length === 1 ? names[0].replace(/^the\s+/i, '') + ' ' : '';
}

function playedDate(playedAt: string, timezone: string | null | undefined): string {
  const sameYear = formatScoreTime(playedAt, timezone, 'yyyy') === String(new Date().getFullYear());
  return formatScoreTime(playedAt, timezone, sameYear ? 'MMM d' : 'MMM d, yyyy');
}

/** The line for one group. Exported for the copy's sake (see the frontend CLAUDE.md). */
export function fitLine(
  g: Pick<Group, 'status' | 'reason' | 'fits'>, playedAt: string, timezone: string | null | undefined,
  playedAtSource?: PlayedAtSource,
): string {
  const n = g.fits.length;
  const one = n === 1;
  const it = one ? 'it' : 'they';
  const machine = machineLabel(g.fits);
  const noun = `${machine}challenge${one ? '' : 's'}`;
  if (g.status === 'counted') return one ? `Counts in your ${noun}` : `Counts in ${n} of your ${machine}challenges`;
  if (g.status === 'not_started') {
    return one
      ? `Your ${noun} hasn't started yet — plays after it starts will count`
      : `Your ${n} ${noun} haven't started yet — plays after they start will count`;
  }
  const head = `Not counted in your ${noun}`;
  const played = playedDate(playedAt, timezone);
  const from = isLockedPlayedAt(playedAtSource) ? ` (time from your ${lockedFromLabel(playedAtSource)})` : '';
  switch (g.reason) {
    case 'played_before_start': return `${head} — played ${played}, before ${it} started${from}`;
    case 'played_after_end': return `${head} — played ${played}, after ${it} ended${from}`;
    case 'posted_before_start': return `${head} — logged before ${it} started`;
    case 'posted_after_end': return `${head} — logged after ${it} ended`;
    case 'no_photo': return `${head} — challenge scores need a photo`;
    case 'not_visible': return `${head} — the other players can't see scores at this venue`;
    case 'wrong_venue': {
      const venues = [...new Set(g.fits.map(f => f.venueName).filter(Boolean))];
      const where = venues.length === 1 ? venues[0] : one ? 'its venue' : 'their venues';
      return `${head} — ${it} only count${one ? 's' : ''} at ${where}`;
    }
    default: return head;
  }
}

export default function ChallengeFitSummary({ fits, playedAt, venueTimezone, playedAtSource, onEditPlayedTime }: {
  fits: ChallengeFit[] | undefined;
  playedAt: string;
  venueTimezone: string | null | undefined;
  /** Where the played time came from; photo / video reads "(time from your photo)" on played-time lines. */
  playedAtSource?: PlayedAtSource;
  /** Offered when a played-time fix could make it count (and nothing counted — a counted score is locked).
   *  Callers omit it for a camera-recorded time the viewer can't change (anyone but an admin). */
  onEditPlayedTime?: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!fits?.length) return null;
  const groups = groupFits(fits);
  const allCounted = groups.length === 1 && groups[0].status === 'counted';
  const canEdit = !!onEditPlayedTime && !fits.some(f => f.status === 'counted')
    && fits.some(f => f.status === 'not_counted' && TIME_REASONS.has(f.reason));

  return (
    <div className="w-full rounded-xl border border-white/10 bg-background/40 p-3 flex flex-col gap-2 text-left" role="status" aria-label="Challenges">
      {groups.map(g => {
        const tone = g.status === 'counted' ? 'text-emerald-300' : g.status === 'not_counted' ? 'text-amber-300' : 'text-muted-foreground';
        const Icon = g.status === 'not_started' ? Clock : Swords;
        const line = allCounted && g.fits.length > 1 ? `Counts in ${g.fits.length} of your challenges` : fitLine(g, playedAt, venueTimezone, playedAtSource);
        const expanded = open === g.key;
        return (
          <div key={g.key} className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : g.key)}
              aria-expanded={expanded}
              className={`flex items-start gap-2 text-sm text-left ${tone}`}
            >
              <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="flex-1">{line}</span>
              <ChevronDown className={`w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
            {expanded && (
              <ul className="ml-6 flex flex-col gap-1">
                {g.fits.map(f => (
                  <li key={f.challengeId}>
                    <Link href={`/challenges/${f.challengeId}`} className="text-xs text-primary hover:underline [overflow-wrap:anywhere]">
                      {typeLabel(f)} · {f.machineName}{f.opponents.length ? ` · vs ${f.opponents.join(', ')}` : ''}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {canEdit && (
        <button
          type="button"
          onClick={onEditPlayedTime}
          className="self-start mt-1 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-bold uppercase tracking-wider text-white hover:border-white/30 transition-colors"
        >
          Edit played time
        </button>
      )}
    </div>
  );
}
