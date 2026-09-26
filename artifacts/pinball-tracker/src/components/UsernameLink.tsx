import type { MouseEvent } from 'react';
import { Link } from 'wouter';

/**
 * An `@username` that links to that player's profile (where you can add them as a friend). Use it
 * for every @handle the app shows, so they all behave the same.
 *
 * - The link's click never bubbles: it may sit inside a clickable row, card or chart (a Recharts
 *   wrapper re-pins its tooltip on click), and following the link must be the only thing that
 *   happens. Never put this inside another `<a>` or a `<button>` — restructure instead.
 * - `className` replaces the default yellow `text-username` treatment, for spots that color the
 *   name differently (e.g. a chart series color, passed via `style`).
 */
export default function UsernameLink({
  username,
  className = 'text-username hover:text-username/80',
  style,
  children,
}: {
  username: string;
  className?: string;
  style?: React.CSSProperties;
  /** What to show; defaults to `@username`. */
  children?: React.ReactNode;
}) {
  return (
    <Link
      href={`/users/${username}`}
      title={`@${username}`}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      className={`${className} transition-colors`}
      style={style}
    >
      {children ?? `@${username}`}
    </Link>
  );
}
