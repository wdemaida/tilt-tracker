// Small pure helpers behind WelcomePage's editable lists (conventions documented in welcomeContent.ts).
// Kept out of the page so they can be unit-tested without React.

import { isSafeUrl } from './richText';

export interface Chip { label: string; highlighted: boolean }

/** "3 days, *1 week, 2 weeks" → chips; a leading * highlights one. Empty pieces are dropped. */
export function parseChips(text: string): Chip[] {
  return text
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (s.startsWith('*') ? { label: s.slice(1).trim(), highlighted: true } : { label: s, highlighted: false }))
    .filter(c => c.label);
}

/** "First Ball, Explorer, …" → at most four badge names. */
export function parseLadder(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
}

const IMAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp|gif)$/i;

/**
 * The public URL for an admin-entered screenshot file name, or null when it isn't a plain file name
 * in public/welcome/ (no paths, no URLs, no "..") — so stored text can only ever point at our own files.
 */
export function welcomeImageUrl(file: string): string | null {
  const name = file.trim();
  if (!IMAGE_FILE.test(name) || name.includes('..')) return null;
  return `/welcome/${name}`;
}

export type SocialKind = 'instagram' | 'reddit' | 'discord' | 'other';

/** Which icon a socials link gets, from its label (or URL). */
export function socialKind(label: string, url = ''): SocialKind {
  const s = `${label} ${url}`.toLowerCase();
  if (s.includes('instagram')) return 'instagram';
  if (s.includes('reddit') || /(^|\s)r\//.test(s)) return 'reddit';
  if (s.includes('discord')) return 'discord';
  return 'other';
}

/** A socials link's href, or null to render it as "Soon" (no URL yet, or one we won't link to). */
export function socialHref(url: string): string | null {
  const u = url.trim();
  return u && isSafeUrl(u) && !u.toLowerCase().startsWith('mailto:') ? u : null;
}
