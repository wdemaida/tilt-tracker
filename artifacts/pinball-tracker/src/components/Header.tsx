import { Link, useLocation } from 'wouter';
import { Trophy, PlusCircle, Menu, X, Bell } from 'lucide-react';
import { SignedIn, SignedOut, useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { useState, useEffect, useRef } from 'react';
import { UNREAD_COUNT_KEY } from '../lib/myFriends';
import AvatarMenu from './AvatarMenu';
import { SCORES, MACHINES, VENUES, STATS, CREW, isActivePath, badgeText, useCrewBadgeCount } from './nav';

const navItems = [SCORES, MACHINES, VENUES, STATS];

/**
 * The inbox bell: unread count badge, polled every 60s and on window focus. Opens /notifications
 * (a page, not a dropdown — see NotificationsPage). Only rendered for a signed-in user with a profile;
 * /api/notifications is the caller's own rows only.
 */
function NotificationBell({ active }: { active: boolean }) {
  const api = useApi();
  const { data } = useQuery({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: api.notifications.unreadCount,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const { data: appUser } = useQuery({
    queryKey: ['me'],
    queryFn: api.users.me,
    enabled: isLoaded && !!isSignedIn,
    retry: false,
  });

  // Crew (friends, pods) is private to its owner, so the entry only exists for signed-in users.
  // Admin and your profile live in the avatar menu.
  const mainNavItems = [...navItems, ...(isSignedIn ? [CREW] : [])];
  const allNavItems = mainNavItems;

  return (
    <header ref={menuRef} className="sticky top-0 z-50 w-full border-b border-white/10 bg-background/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          <Link href="/" className="flex items-center space-x-3 group">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/50 group-hover:border-primary transition-colors">
              <Trophy className="w-6 h-6 text-primary group-hover:text-glow-primary transition-all" aria-hidden />
            </div>
            <span className="font-display text-xl sm:text-2xl tracking-widest text-white group-hover:text-glow-primary transition-all">
              TILT<span className="text-primary">TRACK</span>
            </span>
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
                    aria-label={`${crewBadge} pending friend ${crewBadge === 1 ? 'request' : 'requests'}`}
                  >
                    {badgeText(crewBadge)}
                  </span>
                )}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-1.5 sm:gap-3">
            <SignedIn>
              {appUser && <NotificationBell active={location === '/notifications'} />}
              {/* Add Score hidden on mobile — accessible via hamburger menu */}
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
                className="hidden md:block text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors"
              >
                Sign in
              </Link>
            </SignedOut>

            {/* Hamburger — mobile only */}
            <button
              className="md:hidden flex items-center justify-center w-10 h-10 rounded-lg text-white hover:text-primary transition-colors"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-white/10 bg-background/95 backdrop-blur-xl">
          <nav className="max-w-7xl mx-auto px-4 py-3 flex flex-col gap-1">
            {allNavItems.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={() => setMenuOpen(false)}
                className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-bold uppercase tracking-wider transition-colors hover:bg-white/5 hover:text-white ${
                  isActivePath(location, href) ? 'text-primary bg-primary/10' : 'text-muted-foreground'
                }`}
              >
                <Icon className="w-5 h-5" aria-hidden />
                {label}
              </Link>
            ))}
            <SignedIn>
              <Link
                href="/add"
                onClick={() => setMenuOpen(false)}
                className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-bold uppercase tracking-wider transition-colors hover:bg-white/5 hover:text-white ${
                  location === '/add' ? 'text-primary bg-primary/10' : 'text-muted-foreground'
                }`}
              >
                <PlusCircle className="w-5 h-5" aria-hidden />
                Add Score
              </Link>
            </SignedIn>
            <SignedOut>
              <Link
                href="/sign-in"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-bold uppercase tracking-wider text-muted-foreground hover:bg-white/5 hover:text-white transition-colors"
              >
                Sign in
              </Link>
            </SignedOut>
          </nav>
        </div>
      )}
    </header>
  );
}
