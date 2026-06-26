import { Link, useLocation } from 'wouter';
import { Trophy, Map, BarChart2, PlusCircle, Building2, ShieldCheck, Menu, X } from 'lucide-react';
import { PinballIcon } from './PinballIcon';
import { SignedIn, SignedOut, UserButton, useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { useState, useEffect, useRef } from 'react';

const navItems = [
  { href: '/', label: 'Scores', Icon: Trophy },
  { href: '/machines', label: 'Machines', Icon: PinballIcon },
  { href: '/venues', label: 'Venues', Icon: Building2 },
  { href: '/map', label: 'Map', Icon: Map },
  { href: '/stats', label: 'Stats', Icon: BarChart2 },
];

export default function Header() {
  const [location] = useLocation();
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
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

  const isAdmin = appUser?.role === 'admin';

  const allNavItems = [
    ...navItems,
    ...(isAdmin ? [{ href: '/admin', label: 'Admin', Icon: ShieldCheck }] : []),
  ];

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

          <nav className="hidden md:flex items-center space-x-8">
            {navItems.map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center space-x-2 text-sm font-bold uppercase tracking-wider transition-colors hover:text-white ${
                  location === href ? 'text-glow-primary' : 'text-muted-foreground'
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden />
                <span>{label}</span>
              </Link>
            ))}
            {isAdmin && (
              <Link
                href="/admin"
                className={`flex items-center space-x-2 text-sm font-bold uppercase tracking-wider transition-colors hover:text-white ${
                  location === '/admin' ? 'text-glow-primary' : 'text-muted-foreground'
                }`}
              >
                <ShieldCheck className="w-4 h-4" aria-hidden />
                <span>Admin</span>
              </Link>
            )}
          </nav>

          <div className="flex items-center gap-3">
            <SignedIn>
              {/* Add Score hidden on mobile — accessible via hamburger menu */}
              <Link
                href="/add"
                className="hidden md:flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity"
              >
                <PlusCircle className="w-4 h-4" />
                Add Score
              </Link>
              <UserButton afterSignOutUrl="/" />
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
                  location === href ? 'text-primary bg-primary/10' : 'text-muted-foreground'
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
