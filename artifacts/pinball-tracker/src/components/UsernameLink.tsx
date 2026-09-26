import type { MouseEvent } from 'react';
import { Link } from 'wouter';

/**
 * An `@username` that links to that player's profile (where you can add them as a friend). Use it
 * for every @handle the app shows, so they all look and behave the same.
 *
 * - It always renders the handle itself, `@` included — callers pass the bare username and never add
 *   their own `@` (a leading `@` on the value is tolerated and not doubled). Surrounding words like
 *   "You (…)" go outside it. A display name (a real name) is not a handle: don't use this for one.
 * - The link's click never bubbles: it may sit inside a clickable row, card or chart, and following
 *   the link must be the only thing that happens. Never put this inside another `<a>` or a
 *   `<button>` — restructure instead, or show a plain `@handle` in `text-username` there.
 * - `className` replaces the default yellow `text-username` treatment, for spots that color the
 *   name differently (e.g. a chart series color, passed via `style`).
 */
export default function UsernameLink({
  username,
  className = 'text-username hover:text-username/80',
  style,
}: {
  username: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const handle = username.replace(/^@+/, '');
  return (
    <Link
      href={`/users/${encodeURIComponent(handle)}`}
      title={`@${handle}`}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      className={`${className} transition-colors`}
      style={style}
    >
      @{handle}
    </Link>
  );
}
