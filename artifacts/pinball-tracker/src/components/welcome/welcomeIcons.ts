import { BADGE_ICONS } from '../BadgeImage';
import { PinballIcon } from '../PinballIcon';
import type { PickerIcon } from '../admin/IconPicker';
import { PINBALL_ICON, WELCOME_ICON_NAMES } from '../../lib/iconNames';

// The icons a welcome-page tile can show, by stored name: the badge set plus the app's flipper.
export const WELCOME_ICONS: Record<string, PickerIcon> = { [PINBALL_ICON]: PinballIcon, ...BADGE_ICONS };

export { WELCOME_ICON_NAMES };
