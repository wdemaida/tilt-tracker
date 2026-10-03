// The client-side twin of validateInternalPath() in api-server src/lib/announcements.ts: is this an
// in-app path safe to hand to a wouter <Link>? Used before linking an admin announcement — the server
// already validated it on send, this is belt and braces (and covers rows from an older server).
// Refuses anything that could leave the app: a scheme, "//host", "/\host", whitespace or control
// characters (browsers drop tabs/newlines inside URLs), encoded slashes/backslashes/dots/controls,
// dot segments, /api, and any first segment that isn't an app route. Keep the two in step —
// internalPath.test.ts runs the server's cases too.

export const LINK_MAX = 200;

/** First path segment a link may start with ('' = "/" itself). Mirrors LINK_ROOTS on the server. */
export const LINK_ROOTS = ['', 'users', 'venues', 'machines', 'crew', 'challenges', 'badges', 'stats', 'add', 'welcome', 'notifications'];

const ORIGIN = 'https://tilttrack.invalid';

export function isInternalPath(link: unknown): link is string {
  if (typeof link !== 'string' || !link || link.length > LINK_MAX) return false;
  if (/[\s\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/u.test(link)) return false;
  if (link[0] !== '/' || link[1] === '/' || link.includes('\\')) return false;
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f|2e)/i.test(link)) return false;
  try { decodeURIComponent(link); } catch { return false; }
  if (/[{}]/.test(link)) return false; // placeholders are substituted server-side before delivery
  const pathOnly = link.split(/[?#]/)[0];
  if (pathOnly.split('/').some(seg => seg === '.' || seg === '..')) return false;
  const root = pathOnly.split('/')[1] ?? '';
  if (!LINK_ROOTS.includes(root)) return false;
  try {
    return new URL(link, ORIGIN).origin === ORIGIN;
  } catch {
    return false;
  }
}
