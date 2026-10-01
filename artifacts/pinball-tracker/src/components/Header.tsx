import { Link, useLocation } from 'wouter';
import { PlusCircle, Bell } from 'lucide-react';
import { SignedIn, SignedOut, useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { UNREAD_COUNT_KEY } from '../lib/myFriends';
import { useBadgeToasts } from '../lib/badgeToasts';
import AvatarMenu from './AvatarMenu';
import BrandLogo from './BrandLogo';
import { SCORES, MACHINES, VENUES, STATS, CREW, isActivePath, badgeText, useCrewBadgeCount } from './nav';

const navItems = [SCORES, MACHINES, VENUES, STATS];

/**
 * The inbox bell: unread count badge, polled every 30s (while the tab is visible) and on window
 * focus; anything in the app that can raise a notification for the viewer themself (saving a score,
 * an admin badge action) also invalidates ['notifications'] so the bell moves at once. The count
 * also drives the "badge earned" toasts (lib/badgeToasts.tsx). Opens /notifications (a page, not a
 * dropdown — see NotificationsPage). Only rendered for a signed-in user with a profile;
 * /api/notifications is the caller's own rows only.
 */
function NotificationBell({ active, userId }: { active: boolean; userId: number }) {
  const api = useApi();
  const { data } = useQuery({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: api.notifications.unreadCount,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
  useBadgeToasts(userId, data?.count);
  const count = data?.count ?? 0;
  return (
    <Link
      href="/notifications"
      aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
      className={`relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors hover:text-white ${active ? 'text-primary' : 'text-muted-foreground'}`}
    >
      <Bell className="w-5 h-5" aria-hidden />
      {count > 0 && (
        <span className="absolute top-1 right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-friend text-zinc-950 text-[10px] font-black leading-[1.1rem] text-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  );
}

export default function Header() {
  const [location] = useLocation();
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const crewBadge = useCrewBadgeCount();

  const { data: appUser } = useQuery({
    queryKey: ['me'],
    queryFn: api.users.me,
    enabled: isLoaded && !!isSignedIn,
    retry: false,
  });

  // Crew (friends, pods) is private to its owner, so the entry only exists for signed-in users.
  // Admin and your profile live in the avatar menu. Below md this nav is replaced by MobileTabBar,
  // and the header slims down to logo, bell and avatar.
  const mainNavItems = [...navItems, ...(isSignedIn ? [CREW] : [])];

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-background/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-14 md:h-20">
          <Link href="/" aria-label="TiltTrack home" className="flex items-center hover:opacity-90 transition-opacity">
            <BrandLogo size="header" />
          </Link>

          <nav className="hidden md:flex items-center space-x-5 lg:space-x-8">
            {mainNavItems.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center space-x-2 text-sm font-bold uppercase tracking-wider transition-colors hover:text-white ${
                  isActivePath(location, href) ? 'text-glow-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden />
                <span>{label}</span>
                {href === CREW.href && crewBadge > 0 && (
                  <span
                    className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-friend text-zinc-950 text-[10px] font-black leading-[1.1rem] text-center"
                    aria-label={`${crewBadge} waiting on you`}
                  >
                    {badgeText(crewBadge)}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <SignedIn>
              {appUser && <NotificationBell active={location === '/notifications'} userId={appUser.id} />}
              {/* Add Score on mobile is the tab bar's center button. */}
              <Link
                href="/add"
                className="hidden md:flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity"
              >
                <PlusCircle className="w-4 h-4" />
                Add Score
              </Link>
              <AvatarMenu />
            </SignedIn>
            <SignedOut>
              <Link
                href="/sign-in"
                className="text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors px-2 py-2"
              >
                Sign in
              </Link>
            </SignedOut>
          </div>
        </div>
      </div>
    </header>
  );
}
