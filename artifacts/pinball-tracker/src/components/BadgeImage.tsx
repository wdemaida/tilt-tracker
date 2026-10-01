import { useState } from 'react';
import {
  Award, Trophy, Medal, Crown, Star, Flame, Zap, Target, Gift, CalendarCheck, CalendarHeart, Heart, Users, UserPlus, UserCheck,
  Handshake, Sparkles, Rocket, Gem, Shield, Swords, Timer, TrendingUp, MapPin, Globe, Compass, Gamepad2, Snowflake, TreePine,
  PartyPopper, Ghost, Skull, Crosshair, CircleDot, ListChecks, Library, CloudRain, Scale, Hourglass, Sun, Moon, Coffee, Beer,
  Camera, Footprints, Repeat, Clover, Mountain, Infinity as InfinityIcon, Joystick, Dices, Music, Cake,
  type LucideIcon,
} from 'lucide-react';
import { badgeImageUrl, type Badge } from '../lib/badges';
import type { BadgeIconName } from '../lib/iconNames';

// Every place a badge appears draws it through this: the uploaded image when there is one, else the
// lucide `icon` in the badge's `color` on a tinted disc. Artwork is optional, so a later move to
// images only is a data change. `locked` is the catalog's not-yet-earned look (grayscale, dimmed) —
// the same image, no second asset.

/**
 * The icons an admin can pick (kebab-case, as stored on the badge). Unknown names fall back to award.
 * The names are BADGE_ICON_NAMES (lib/iconNames.ts); `satisfies` keeps the two lists identical.
 */
export const BADGE_ICONS: Record<string, LucideIcon> = {
  award: Award, trophy: Trophy, medal: Medal, crown: Crown, star: Star, flame: Flame, zap: Zap, target: Target, gift: Gift,
  'calendar-check': CalendarCheck, 'calendar-heart': CalendarHeart, heart: Heart, users: Users, 'user-plus': UserPlus,
  'user-check': UserCheck, handshake: Handshake, sparkles: Sparkles, rocket: Rocket, gem: Gem, shield: Shield, swords: Swords,
  timer: Timer, 'trending-up': TrendingUp, 'map-pin': MapPin, globe: Globe, compass: Compass, 'gamepad-2': Gamepad2,
  snowflake: Snowflake, 'tree-pine': TreePine, 'party-popper': PartyPopper, ghost: Ghost, skull: Skull, crosshair: Crosshair,
  'circle-dot': CircleDot, 'list-checks': ListChecks, library: Library, 'cloud-rain': CloudRain, scale: Scale,
  hourglass: Hourglass, sun: Sun, moon: Moon, coffee: Coffee, beer: Beer, camera: Camera, footprints: Footprints,
  repeat: Repeat, clover: Clover, mountain: Mountain, infinity: InfinityIcon, joystick: Joystick, dices: Dices, music: Music,
  cake: Cake,
} satisfies Record<BadgeIconName, LucideIcon>;

export function badgeIcon(name: string): LucideIcon {
  return BADGE_ICONS[name] ?? Award;
}

const HEX = /^#[0-9a-f]{6}$/i;

export default function BadgeImage({ badge, size = 48, locked = false, className = '' }: {
  badge: Pick<Badge, 'id' | 'name' | 'icon' | 'color' | 'imageVersion'>;
  size?: number;
  locked?: boolean;
  className?: string;
}) {
  // A broken image (deleted between list and load) falls back to the icon rather than a broken glyph.
  const [failed, setFailed] = useState(false);
  const color = HEX.test(badge.color) ? badge.color : '#f59e0b';
  const lockedCls = locked ? 'grayscale opacity-40' : '';
  const box = { width: size, height: size };
  if (badge.imageVersion != null && !failed) {
    return (
      <img
        src={badgeImageUrl(badge.id, badge.imageVersion)}
        alt={badge.name}
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`rounded-full object-contain flex-shrink-0 ${lockedCls} ${className}`}
        style={box}
      />
    );
  }
  const Icon = badgeIcon(badge.icon);
  return (
    <span
      role="img"
      aria-label={badge.name}
      className={`inline-flex items-center justify-center rounded-full flex-shrink-0 border-2 ${lockedCls} ${className}`}
      style={{ ...box, color, backgroundColor: `${color}26`, borderColor: `${color}80` }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.25} aria-hidden />
    </span>
  );
}
