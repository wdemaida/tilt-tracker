import { format } from 'date-fns';
import { TZDate } from '@date-fns/tz';

// One place that decides what clock a score is shown on.
//
// A play happened at a time *somewhere*. Rendering it in the viewer's zone means a Friday night in
// Portland reads as 10pm–1am once you're back on the east coast, and a late score can land on the
// wrong calendar date depending on where you happen to be browsing from. Rendering it in the
// **venue's** zone makes the displayed time equal what the camera recorded, permanently, for
// everyone — which is the property worth having in a journal.
//
// Falls back to the viewer's zone when the venue is unknown: a score with no venue, a venue that
// predates `venues.timezone`, or a hidden-tier residence whose zone is redacted (a timezone is a
// coarse location hint, so it is withheld alongside the address — see venuePrivacy.ts).

/**
 * @param playedAt ISO instant from the API
 * @param timezone the venue's IANA zone, or null/undefined to use the viewer's
 * @param fmt      a date-fns format string
 */
export function formatScoreTime(
  playedAt: string | Date,
  timezone: string | null | undefined,
  fmt: string,
): string {
  const d = playedAt instanceof Date ? playedAt : new Date(playedAt);
  if (Number.isNaN(d.getTime())) return '';
  return format(timezone ? new TZDate(d.getTime(), timezone) : d, fmt);
}

/**
 * A short zone label ("CDT") for when a score is shown on a clock that isn't the viewer's. Returns
 * null when the venue's zone matches the viewer's, so the common case stays uncluttered — the label
 * is only there to answer "why does this say 6pm when I remember 7pm?".
 */
export function zoneAbbreviation(playedAt: string | Date, timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (viewer === timezone) return null;

  const d = playedAt instanceof Date ? playedAt : new Date(playedAt);
  if (Number.isNaN(d.getTime())) return null;

  // Two zones can share an offset without sharing a name (America/New_York and
  // America/Kentucky/Louisville both sit at -04:00 in summer). Comparing the rendered label rather
  // than the zone id keeps the badge off scores that read identically anyway.
  const label = (tz: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? null;

  const venueLabel = label(timezone);
  return venueLabel && venueLabel !== label(viewer) ? venueLabel : null;
}
