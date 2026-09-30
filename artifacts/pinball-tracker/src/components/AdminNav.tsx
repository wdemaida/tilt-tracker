import { Link, useLocation } from 'wouter';

const TABS = [
  { href: '/admin',          label: 'Overview' },
  { href: '/admin/users',    label: 'Users' },
  { href: '/admin/activity', label: 'Activity' },
  { href: '/admin/crew',     label: 'Crew' },
  { href: '/admin/scores',   label: 'Scores' },
  { href: '/admin/badges',   label: 'Badges' },
  { href: '/admin/health',   label: 'Health' },
  { href: '/admin/config',   label: 'Config' },
];

export default function AdminNav() {
  const [location] = useLocation();
  // /admin/users/12 keeps "Users" lit.
  const active = (href: string) => (href === '/admin' ? location === '/admin' : location === href || location.startsWith(`${href}/`));
  return (
    // Eight tabs don’t fit a phone: the strip scrolls sideways instead of wrapping, with the
    // scrollbar hidden (scrollbar-none + overflow-y-hidden, index.css) so desktop shows no widget.
    <nav className="flex gap-1 border-b border-white/10 mb-8 overflow-x-auto overflow-y-hidden scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0" aria-label="Admin sections">
      {TABS.map(t => (
        <Link
          key={t.href}
          href={t.href}
          className={`px-3 sm:px-4 py-2.5 text-sm font-bold uppercase tracking-wider whitespace-nowrap border-b-2 -mb-px transition-colors ${
            active(t.href)
              ? 'border-primary text-white'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
