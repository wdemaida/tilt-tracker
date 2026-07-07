import { Link, useLocation } from 'wouter';

const TABS = [
  { href: '/admin',        label: 'Users' },
  { href: '/admin/health', label: 'Health' },
  { href: '/admin/config', label: 'Config' },
  { href: '/admin/stats',  label: 'Stats' },
];

export default function AdminNav() {
  const [location] = useLocation();
  return (
    <div className="flex gap-1 border-b border-white/10 mb-8">
      {TABS.map(t => (
        <Link
          key={t.href}
          href={t.href}
          className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
            location === t.href
              ? 'border-primary text-white'
              : 'border-transparent text-muted-foreground hover:text-white'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
