import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Search } from 'lucide-react';
import { useAdminApi, type AdminUserRow } from '../lib/adminApi';
import UsernameLink from '../components/UsernameLink';
import { AdminShell, Card, Segmented, Pill, When, ErrorNote } from '../components/admin/AdminParts';

// /admin/users — everyone, searchable, with Clerk's last sign-in / last active. A row opens the
// admin user page (/admin/users/:id), where the edit and account actions live.

type Filter = 'all' | 'disabled' | 'admins';

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Badges({ u }: { u: AdminUserRow }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {u.role === 'admin' && <Pill tone="primary">admin</Pill>}
      {u.disabledAt && <Pill tone="danger">disabled</Pill>}
      {u.clerk?.banned && !u.disabledAt && <Pill tone="warn">banned in Clerk</Pill>}
    </span>
  );
}

export default function AdminUsersPage() {
  const admin = useAdminApi();
  const [, navigate] = useLocation();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const dq = useDebounced(q);
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'users', dq, filter], queryFn: () => admin.users(dq, filter) });
  const rows = data?.items ?? [];
  const open = (u: AdminUserRow) => navigate(`/admin/users/${u.id}`);

  return (
    <AdminShell wide>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <label className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q} onChange={e => setQ(e.target.value)} placeholder="Search username or name"
            className="w-full border border-white/20 rounded-lg pl-9 pr-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </label>
        <Segmented<Filter> value={filter} onChange={setFilter}
          options={[{ value: 'all', label: 'All' }, { value: 'disabled', label: 'Disabled' }, { value: 'admins', label: 'Admins' }]} />
      </div>
      <ErrorNote error={error} />
      {data && !data.clerkAvailable && (
        <p className="text-xs text-amber-400 mb-3">Clerk couldn’t be reached — last sign-in / active times are unavailable.</p>
      )}
      {isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No users match.</p>
      ) : (
        <>
          {/* Phones: cards */}
          <ul className="sm:hidden space-y-2">
            {rows.map(u => (
              <li key={u.id}>
                <Card className="p-3">
                  <button type="button" onClick={() => open(u)} className="w-full text-left">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-white truncate">{u.displayName}</span>
                      <Badges u={u} />
                    </div>
                  </button>
                  <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <UsernameLink username={u.username} />
                    <span>{u.scoreCount} scores</span>
                    <span>{u.friendCount} friends</span>
                  </div>
                  <button type="button" onClick={() => open(u)} className="w-full text-left text-xs text-muted-foreground mt-1">
                    Joined <When at={u.createdAt} /> · signed in <When at={u.clerk?.lastSignInAt} fallback="unknown" /> · active <When at={u.clerk?.lastActiveAt} fallback="unknown" />
                  </button>
                </Card>
              </li>
            ))}
          </ul>

          {/* Tablet / desktop: table */}
          <Card className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 bg-white/5 text-left">
                  {['User', 'Joined', 'Last sign-in', 'Last active', 'Scores', 'Friends', ''].map(h => (
                    <th key={h} className="px-4 py-3 font-bold uppercase tracking-wider text-xs text-muted-foreground whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(u => (
                  <tr key={u.id} onClick={() => open(u)} className="border-b border-white/5 last:border-0 hover:bg-white/5 cursor-pointer transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-white">{u.displayName}</div>
                      <div className="text-xs"><UsernameLink username={u.username} /></div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap"><When at={u.createdAt} /></td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap"><When at={u.clerk?.lastSignInAt} fallback="unknown" /></td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap"><When at={u.clerk?.lastActiveAt} fallback="unknown" /></td>
                    <td className="px-4 py-3 text-white tabular-nums">{u.scoreCount}</td>
                    <td className="px-4 py-3 text-white tabular-nums">{u.friendCount}</td>
                    <td className="px-4 py-3"><Badges u={u} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-muted-foreground mt-2">{rows.length} user{rows.length === 1 ? '' : 's'}</p>
        </>
      )}
    </AdminShell>
  );
}
