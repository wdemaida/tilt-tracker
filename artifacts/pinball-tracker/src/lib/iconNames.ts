// The icon names an admin can pick (kebab-case lucide names, as stored). Pure — no React or lucide —
// so the api-server's tests can import it: siteContent.ts keeps a twin of WELCOME_ICON_NAMES to
// validate the welcome page's step icons, and its test checks the two lists match.
//
// BadgeImage's BADGE_ICONS map is typed against BADGE_ICON_NAMES (`satisfies`), so adding an icon
// means adding it here and there — tsc fails if either side has one the other doesn't.

export const BADGE_ICON_NAMES = [
  'award', 'trophy', 'medal', 'crown', 'star', 'flame', 'zap', 'target', 'gift',
  'calendar-check', 'calendar-heart', 'heart', 'users', 'user-plus', 'user-check', 'handshake', 'sparkles',
  'rocket', 'gem', 'shield', 'swords', 'timer', 'trending-up', 'map-pin', 'globe', 'compass', 'gamepad-2',
  'snowflake', 'tree-pine', 'party-popper', 'ghost', 'skull', 'crosshair', 'circle-dot', 'list-checks',
  'library', 'cloud-rain', 'scale', 'hourglass', 'sun', 'moon', 'coffee', 'beer', 'camera', 'footprints',
  'repeat', 'clover', 'mountain', 'infinity', 'joystick', 'dices', 'music', 'cake',
] as const;

export type BadgeIconName = (typeof BADGE_ICON_NAMES)[number];

/** The app's flipper icon (PinballIcon) — offered for welcome-page icons, not for badges. */
export const PINBALL_ICON = 'pinball';

/** Icons a welcome-page tile may use: the flipper first, then the badge set alphabetically. */
export const WELCOME_ICON_NAMES: readonly string[] = [PINBALL_ICON, ...[...BADGE_ICON_NAMES].sort()];

export function isWelcomeIcon(name: unknown): name is string {
  return typeof name === 'string' && WELCOME_ICON_NAMES.includes(name);
}
