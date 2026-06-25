import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { useApi } from '../lib/useApi';
import { ShieldCheck } from 'lucide-react';

function AdminNav() {
  const [location] = useLocation();
  const tabs = [
    { href: '/admin', label: 'Users' },
    { href: '/admin/health', label: 'Health' },
  ];
  return (
    <div className="flex gap-1 border-b border-white/10 mb-8">
      {tabs.map(t => (
        <Link key={t.href} href={t.href} className={`px-4 py-2.5 text-sm font-bold uppercase tracking-wider border-b-2 -mb-px transition-colors ${
          location === t.href ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-white'
        }`}>{t.label}</Link>
      ))}
    </div>
  );
}

export default function AdminPage() {
  const api = useApi();

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.admin.users(),
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ShieldCheck className="w-7 h-7 text-primary" />
        <h1 className="text-3xl font-black uppercase tracking-widest text-white">Admin</h1>
      </div>

      <AdminNav />

      <section>
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">Users</h2>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : (
          <div className="rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/5">
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Username</th>
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Display Name</th>
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Role</th>
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u: any) => (
                  <tr key={u.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                    <td className="px-4 py-3 text-white font-medium">@{u.username}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.displayName}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                        u.role === 'admin' ? 'bg-primary/20 text-primary' : 'bg-white/10 text-muted-foreground'
                      }`}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
