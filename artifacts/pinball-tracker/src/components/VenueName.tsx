import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { Link } from 'wouter';
import UsernameLink from './UsernameLink';
import { useAppUser } from '../lib/useAppUser';
import { venueOwnerLabel } from '../lib/venueLabel';

/**
 * A venue's name, plus its owner's handle when it's someone's private venue: "HOME (@collasta)", or
 * "HOME (you)" for your own (lib/venueLabel.ts has the rule and the plain-text form). Use it for
 * every venue name the app shows.
 *
 * - `ownerUsername` comes from the server, which only sends it when the viewer may see that venue's
 *   activity. Null/absent → just the name.
 * - The handle is always a UsernameLink to the profile. Pass `href` to make the NAME a link too: the
 *   two render as sibling links, never one inside the other. So never put this inside an `<a>` or a
 *   `<button>` — make the row clickable with `clickableRow()` instead (the handle's click doesn't
 *   bubble, so it never also picks/opens the row).
 * - `className` goes on the wrapper (truncate, colour, weight); `nameClassName` on the name alone
 *   (e.g. the hover colour of a name link); `ownerClassName` on the "(@handle)" part.
 */
export default function VenueName({
  name,
  ownerUsername,
  href,
  className,
  nameClassName,
  ownerClassName,
  style,
}: {
  name: string;
  ownerUsername?: string | null;
  href?: string;
  className?: string;
  nameClassName?: string;
  /** Extra classes for the "(@handle)" part, e.g. a smaller size beside a big heading. */
  ownerClassName?: string;
  style?: CSSProperties;
}) {
  const me = useAppUser();
  const owner = venueOwnerLabel(ownerUsername, me?.username);
  const nameEl = href
    ? <Link href={href} className={nameClassName ?? 'hover:text-venue/80 transition-colors'}>{name}</Link>
    : nameClassName ? <span className={nameClassName}>{name}</span> : <>{name}</>;
  return (
    <span className={className} style={style}>
      {nameEl}
      {owner && (
        <>
          {' '}
          <span className={`font-normal normal-case tracking-normal text-muted-foreground whitespace-nowrap ${ownerClassName ?? ''}`}>
            ({owner.kind === 'you' ? 'you' : <UsernameLink username={owner.username} />})
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Props that make a `<div>` act as a button — for a picker row that shows a VenueName, whose handle
 * link can't sit inside a real `<button>`. Enter/Space pick the row only when the row itself has
 * focus, so pressing Enter on the handle link just follows the link.
 */
export function clickableRow(onClick: () => void, opts: { disabled?: boolean } = {}) {
  return {
    role: 'button' as const,
    tabIndex: opts.disabled ? -1 : 0,
    'aria-disabled': opts.disabled || undefined,
    onClick: (e: MouseEvent) => { if (!opts.disabled && !e.defaultPrevented) onClick(); },
    onKeyDown: (e: KeyboardEvent) => {
      if (opts.disabled || e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
    },
  };
}
