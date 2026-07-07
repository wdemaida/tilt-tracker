import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/useApi';
import { ShieldCheck, X, RefreshCw } from 'lucide-react';
import AdminNav from '../components/AdminNav';

type StatDef = {
  id: number;
  key: string;
  label: string;
  description: string | null;
  createdAt: string;
};

type HistoryRow = {
  id: number;
  statId: number;
  key: string;
  label: string;
  value: number;
  periodDate: string;
};

const inputClass = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full';
const labelClass = 'text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block';

function EditStatModal({ stat, onClose }: { stat: StatDef; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [label, setLabel] = useState(stat.label);
  const [description, setDescription] = useState(stat.description ?? '');
  const [error, setError] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (data: { label?: string; description?: string }) => api.admin.updateStat(stat.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-stats'] }); onClose(); },
    onError: (err: any) => setError(err?.message ?? 'Failed to save changes'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.admin.deleteStat(stat.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin-stats'] }); onClose(); },
    onError: (err: any) => setError(err?.message ?? 'Failed to delete stat'),
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const updates: { label?: string; description?: string } = {};
    if (label.trim() !== stat.label) updates.label = label;
    if (description.trim() !== (stat.description ?? '')) updates.description = description;
    if (Object.keys(updates).length === 0) { onClose(); return; }
    saveMutation.mutate(updates);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black uppercase tracking-widest text-white">Edit Stat</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-white/5 rounded-xl p-4">
          <span className="text-muted-foreground text-xs uppercase tracking-wider">Key</span>
          <p className="text-white font-mono mt-0.5">{stat.key}</p>
          <p className="text-xs text-muted-foreground mt-2">
            Not editable — the daily snapshot job matches on this to know which computed value belongs here.
          </p>
        </div>

        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <div>
            <label className={labelClass}>Label</label>
            <input value={label} onChange={e => setLabel(e.target.value)} className={inputClass} required />
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className={inputClass}
              rows={3}
            />
          </div>

          {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

          {confirmingDelete ? (
            <div className="flex flex-col gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-sm text-red-300">Delete this stat? Blocked if any history rows reference it.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="flex-1 border border-white/20 text-muted-foreground hover:text-white rounded-lg py-2 text-xs font-bold uppercase tracking-wider transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="flex-1 bg-red-600 hover:bg-red-500 text-white rounded-lg py-2 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Confirm Delete'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg px-4 py-2.5 text-sm font-bold uppercase tracking-wider transition-colors"
              >
                Delete
              </button>
              <button
                type="submit"
                disabled={saveMutation.isPending}
                className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default function AdminStatsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [editingStat, setEditingStat] = useState<StatDef | null>(null);
  const [snapshotMsg, setSnapshotMsg] = useState('');

  const { data: statDefs = [], isLoading } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => api.admin.stats(),
  });

  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ['admin-stats-history'],
    queryFn: () => api.admin.statHistory(60),
  });

  const snapshotMutation = useMutation({
    mutationFn: () => api.admin.runStatSnapshot(),
    onSuccess: (result: any) => {
      qc.invalidateQueries({ queryKey: ['admin-stats-history'] });
      setSnapshotMsg(`Captured ${result.periodDate}: ${Object.entries(result.values).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    },
    onError: (err: any) => setSnapshotMsg(err?.message ?? 'Snapshot failed'),
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <ShieldCheck className="w-7 h-7 text-primary" />
        <h1 className="text-3xl font-black uppercase tracking-widest text-white">Admin</h1>
      </div>

      <AdminNav />

      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Stat Definitions <span className="normal-case font-normal text-white/40">— click a row to edit</span>
          </h2>
        </div>
        {isLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : (
          <div className="rounded-xl border border-white/10 overflow-hidden overflow-x-auto">
            <table className="w-full text-sm min-w-[500px]">
              <thead>
                <tr className="border-b border-white/10 bg-white/5">
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Key</th>
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Label</th>
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Description</th>
                </tr>
              </thead>
              <tbody>
                {(statDefs as StatDef[]).map(s => (
                  <tr
                    key={s.id}
                    onClick={() => setEditingStat(s)}
                    className="border-b border-white/5 last:border-0 hover:bg-white/5 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-white font-mono text-xs">{s.key}</td>
                    <td className="px-4 py-3 text-white font-medium">{s.label}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Recent History <span className="normal-case font-normal text-white/40">— written daily at 1am ET</span>
          </h2>
          <button
            onClick={() => { setSnapshotMsg(''); snapshotMutation.mutate(); }}
            disabled={snapshotMutation.isPending}
            className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${snapshotMutation.isPending ? 'animate-spin' : ''}`} /> Run Snapshot Now
          </button>
        </div>
        {snapshotMsg && <p className="text-xs text-muted-foreground mb-3">{snapshotMsg}</p>}
        {historyLoading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : (history as HistoryRow[]).length === 0 ? (
          <p className="text-muted-foreground text-sm">No history captured yet.</p>
        ) : (
          <div className="rounded-xl border border-white/10 overflow-hidden overflow-x-auto">
            <table className="w-full text-sm min-w-[400px]">
              <thead>
                <tr className="border-b border-white/10 bg-white/5">
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Date</th>
                  <th className="text-left px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Stat</th>
                  <th className="text-right px-4 py-3 font-bold uppercase tracking-wider text-muted-foreground">Value</th>
                </tr>
              </thead>
              <tbody>
                {(history as HistoryRow[]).map(row => (
                  <tr key={row.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3 text-muted-foreground">{row.periodDate}</td>
                    <td className="px-4 py-3 text-white">{row.label}</td>
                    <td className="px-4 py-3 text-right text-white font-bold">{row.value.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editingStat && <EditStatModal stat={editingStat} onClose={() => setEditingStat(null)} />}
    </div>
  );
}
