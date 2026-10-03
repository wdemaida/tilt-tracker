// Profile field rules — pure, unit-tested (profileFields.test.ts). The ONE normalizer for a display
// name, shared by POST /api/users/setup, PATCH /api/users/me and the admin PATCH /api/admin/users/:id
// (which used to save a blank name: it trimmed but never checked). The username is chosen once at
// setup and locked for the user after that (PATCH /me answers 400 username_locked); only an admin can
// change it, through the same normalizeUsername() rule as setup.

export const DISPLAY_NAME_MAX = 40;

export type UsernameError =
  | { code: 'username_required'; error: string }
  | { code: 'username_invalid'; error: string };

/**
 * The username rule from POST /api/users/setup: lowercased, everything but a–z, 0–9 and _ dropped,
 * and something must be left. Not unique here — the users.username UNIQUE index is the authority
 * (both routes answer its 23505 with 409 "Username already taken").
 *
 * `strict` (the admin PATCH): refuse instead of silently dropping characters, so an admin typing
 * "Will D" is told why rather than saving "willd". Case is still folded.
 */
export function normalizeUsername(raw: unknown, { strict = false }: { strict?: boolean } = {}):
  { ok: true; value: string } | ({ ok: false } & UsernameError) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'username_required', error: 'Username is required' };
  const lower = raw.trim().toLowerCase();
  const value = lower.replace(/[^a-z0-9_]/g, '');
  if (!value || (strict && value !== lower)) {
    return { ok: false, code: 'username_invalid', error: 'Username can only use letters, numbers and underscores' };
  }
  return { ok: true, value };
}

export type ProfileFieldError =
  | { code: 'display_name_required'; error: string }
  | { code: 'display_name_too_long'; error: string }
  | { code: 'display_name_at'; error: string };

// C0/C1 controls (tabs and newlines included — they become spaces first) and the bidi
// embedding/override/isolate characters, which can make a name render reversed or hijack the text
// around it. Zero-width joiners stay: emoji sequences need them.
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/**
 * Trim, collapse whitespace (any run, incl. tabs/newlines → one space), strip control and bidi
 * override characters, NFC. 1–40 characters (counted as code points, so an emoji is one), and no
 * leading "@" — that's how usernames are written, and a display name posing as one is confusing.
 * Not unique: two people can both be "Mike".
 */
export function normalizeDisplayName(raw: unknown): { ok: true; value: string } | ({ ok: false } & ProfileFieldError) {
  if (typeof raw !== 'string') return { ok: false, code: 'display_name_required', error: 'Display name is required' };
  const value = raw.normalize('NFC').replace(/\s+/g, ' ').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, code: 'display_name_required', error: 'Display name is required' };
  if ([...value].length > DISPLAY_NAME_MAX) {
    return { ok: false, code: 'display_name_too_long', error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer` };
  }
  if (value.startsWith('@')) return { ok: false, code: 'display_name_at', error: "Display name can't start with @" };
  return { ok: true, value };
}

/**
 * The user's own profile photo from a Clerk user object — the webhook's snake_case payload
 * (`has_image`, `image_url`) or the Backend SDK's camelCase User (`hasImage`, `imageUrl`). Null when
 * they have none: Clerk always sends an image URL, a generated default when `has_image` is false,
 * and we never store that one. Only https URLs are accepted (it's rendered in an <img>).
 */
export function avatarFromClerk(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const has = d.has_image ?? d.hasImage;
  const url = d.image_url ?? d.imageUrl;
  if (has !== true || typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** A Clerk ms timestamp (`updated_at` / `updatedAt`) as a Date, or null. */
export function clerkInstant(ms: unknown): Date | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}
