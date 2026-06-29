import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { ShieldCheck, X } from 'lucide-react';
import AdminNav from '../components/AdminNav';

type User = {
  id: number;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  createdAt: string;
  pinballMapUsername: string | null;
};

function EditUserModal({ user, onClose }: { user: User; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (data: { role?: string; displayName?: string; username?: string }) =>
      api.admin.updateUser(user.id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: (err: any) => {
      setError(err?.message ?? 'Failed to save changes');
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const updates: { role?: string; displayName?: string; username?: string } = {};
    if (role !== user.role) updates.role = role;
    if (displayName.trim() !== user.displayName) updates.displayName = displayName;
    if (username.trim() !== user.username) updates.username = username;
    if (Object.keys(updates).length === 0) { onClose(); return; }
    mutation.mutate(updates);
  }

  const inputClass = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full';
  const labelClass = 'text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black uppercase tracking-widest text-white">Edit User</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Read-only info */}
        <div className="grid grid-cols-2 gap-3 text-sm bg-white/5 rounded-xl p-4">
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wider">User ID</span>
            <p className="text-white font-mono mt-0.5">{user.id}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs uppercase tracking-wider">Joined</span>
            <p className="text-white mt-0.5">{new Date(user.createdAt).toLocaleDateString()}</p>
          </div>
          <div className="col-span-2">
            <span className="text-muted-foreground text-xs uppercase tracking-wider">Pinball Map Account</span>
            <p className="text-white mt-0.5">{user.pinballMapUsername ?? <span className="text-muted-foreground italic">not linked</span>}</p>
          </div>
        </div>

        {/* Editable fields */}
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div>
            <label className={labelClass}>Username</label>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Display Name</label>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as 'admin' | 'user')}
              className={inputClass + ' cursor-pointer'}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>

          {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-white/20 text-muted-foreground hover:text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const api = useApi();
  const [editingUser, setEditingUser] = useState<User | null>(null);

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
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground mb-4">
          Users <span className="normal-case font-normal text-white/40">— click a row to edit</span>
        </h2>
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
                {(users as User[]).map(u => (
                  <tr
                    key={u.id}
                    onClick={() => setEditingUser(u)}
                    className="border-b border-white/5 last:border-0 hover:bg-white/5 cursor-pointer transition-colors"
                  >
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

      {editingUser && (
        <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} />
      )}
    </div>
  );
}
