import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Plus, Pencil, Trash2, Users, X, Loader2, Lock, ChevronDown } from 'lucide-react';
import PodChip from '../components/PodChip';
import PodColorPicker from '../components/PodColorPicker';
import { useApi } from '../lib/useApi';
import { queryClient } from '../lib/queryClient';
import { nextPodColor, podColorVars } from '../lib/podColor';
import type { Pod, PodUser } from '../lib/api';

// Pods — private groups of other players to compare against. Everything here is the signed-in
// user's own: the server scopes every call to pods they own, and members are never told.

const PODS_KEY = ['pods'];
const NAME_MAX = 40;

function errorText(e: unknown, fallback: string): string {
  return (e as any)?.message ?? fallback;
}

/** Replace one pod in the cached list (or drop it when `next` is null). */
function patchCache(id: number, next: Pod | null) {
  queryClient.setQueryData<Pod[]>(PODS_KEY, old => {
    if (!old) return old;
    if (!next) return old.filter(p => p.id !== id);
    return old.some(p => p.id === id) ? old.map(p => (p.id === id ? next : p)) : [...old, next];
  });
  queryClient.invalidateQueries({ queryKey: PODS_KEY });
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function memberCountLabel(n: number) {
  return `${n} ${n === 1 ? 'member' : 'members'}`;
}

// ── name + color form (create and edit) ────────────────────────────────────

function PodForm({ idPrefix, initialName, initialColor, submitLabel, pending, error, onSubmit, onCancel }: {
  idPrefix: string;
  initialName: string;
  initialColor: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string, color: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const trimmed = name.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (trimmed) onSubmit(trimmed, color);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label htmlFor={`${idPrefix}-name`} className="block text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
          Name
        </label>
        <input
          id={`${idPrefix}-name`}
          type="text"
          value={name}
          maxLength={NAME_MAX}
          autoFocus
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Tuesday league"
          className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
        />
      </div>
      <div>
        <span className="block text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1.5">Color</span>
        <PodColorPicker idPrefix={idPrefix} value={color} onChange={setColor} />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">Preview</span>
        <PodChip color={color}>{trimmed || 'Pod name'}</PodChip>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!trimmed || pending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {pending && <Loader2 className="w-4 h-4 animate-spin" />}
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-white/10 text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── member picker ──────────────────────────────────────────────────────────

function MemberPicker({ pod }: { pod: Pod }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = useDebounced(query.trim(), 250);

  const { data: results = [], isFetching, error: searchError } = useQuery({
    queryKey: ['pod-user-search', q],
    queryFn: () => api.pods.searchUsers(q),
    enabled: q.length > 0,
    staleTime: 30_000,
  });

  const add = useMutation({
    mutationFn: (u: PodUser) => api.pods.addMember(pod.id, u.id),
    onSuccess: next => { setError(null); setQuery(''); patchCache(pod.id, next); },
    onError: e => setError(errorText(e, 'Could not add that player')),
  });

  const inPod = new Set(pod.members.map(m => m.id));

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={e => { setQuery(e.target.value); setError(null); }}
        placeholder="Add a player — search by name or username…"
        aria-label={`Add a player to ${pod.name}`}
        className="w-full rounded-lg border border-white/10 bg-background px-3 py-2 text-sm text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
      />
      {query.trim().length > 0 && (
        <div className="mt-1 rounded-lg border border-white/10 bg-background max-h-60 overflow-y-auto">
          {searchError ? (
            <p className="px-3 py-2 text-xs text-red-400">{errorText(searchError, 'Search failed')}</p>
          ) : (isFetching || q !== query.trim()) && results.length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No players match “{query.trim()}”.</p>
          ) : (
            results.map(u => {
              const already = inPod.has(u.id);
              return (
                <button
                  key={u.id}
                  type="button"
                  disabled={already || add.isPending}
                  onClick={() => add.mutate(u)}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
                >
                  <span className="min-w-0">
                    <span className="text-white/90 font-medium">{u.displayName}</span>
                    <span className="block text-xs text-username">@{u.username}</span>
                  </span>
                  {already
                    ? <span className="text-xs text-muted-foreground flex-shrink-0">In pod</span>
                    : <Plus className="w-4 h-4 text-pod-text flex-shrink-0" aria-hidden />}
                </button>
              );
            })
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

// ── one pod ────────────────────────────────────────────────────────────────

function PodCard({ pod }: { pod: Pod }) {
  const api = useApi();
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-delete'>('view');
  const [membersOpen, setMembersOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (body: { name: string; color: string }) => api.pods.update(pod.id, body),
    onSuccess: next => { setError(null); setMode('view'); patchCache(pod.id, next); },
    onError: e => setError(errorText(e, 'Could not save the pod')),
  });
  const remove = useMutation({
    mutationFn: () => api.pods.delete(pod.id),
    onSuccess: () => patchCache(pod.id, null),
    onError: e => setError(errorText(e, 'Could not delete the pod')),
  });
  const removeMember = useMutation({
    mutationFn: (userId: number) => api.pods.removeMember(pod.id, userId),
    onSuccess: next => { setError(null); patchCache(pod.id, next); },
    onError: e => setError(errorText(e, 'Could not remove that player')),
  });

  if (mode === 'edit') {
    return (
      <section className="rounded-xl border border-white/10 bg-card p-4">
        <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">Edit pod</h2>
        <PodForm
          idPrefix={`pod-${pod.id}`}
          initialName={pod.name}
          initialColor={pod.color}
          submitLabel="Save"
          pending={update.isPending}
          error={error}
          onSubmit={(name, color) => update.mutate({ name, color })}
          onCancel={() => { setError(null); setMode('view'); }}
        />
      </section>
    );
  }

  return (
    // The pod's color is scoped to the card, so `text-pod-text`, `border-pod/30` etc. inside it
    // resolve to this pod (podColor.ts).
    <section style={podColorVars(pod.color)} className="rounded-xl border border-pod/30 bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setMembersOpen(o => !o)}
          aria-expanded={membersOpen}
          className="flex items-center gap-2 min-w-0 text-left group"
        >
          <PodChip color={pod.color} className="text-sm max-w-full">
            <span className="truncate">{pod.name}</span>
          </PodChip>
          <span className="text-xs text-muted-foreground flex-shrink-0">{memberCountLabel(pod.memberCount)}</span>
          <ChevronDown className={`w-4 h-4 text-muted-foreground group-hover:text-white transition-transform flex-shrink-0 ${membersOpen ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => { setError(null); setMode('edit'); }}
            aria-label={`Edit ${pod.name}`}
            title="Rename or recolor"
            className="p-1.5 rounded text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => { setError(null); setMode('confirm-delete'); }}
            aria-label={`Delete ${pod.name}`}
            title="Delete pod"
            className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {mode === 'confirm-delete' && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/5 p-3">
          <p className="text-sm text-white">
            Delete <span className="font-bold">{pod.name}</span>? Its {memberCountLabel(pod.memberCount)} won’t be affected or notified.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {remove.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Delete pod
            </button>
            <button
              type="button"
              onClick={() => setMode('view')}
              className="px-3 py-1.5 rounded-lg border border-white/10 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {membersOpen && (
        <div className="mt-4 flex flex-col gap-3">
          {pod.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one in this pod yet. Search below to add players.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pod.members.map(m => (
                <li key={m.id} className="flex items-center justify-between gap-3 rounded-lg border border-pod/20 bg-pod/5 px-3 py-2">
                  <Link href={`/users/${m.username}`} className="min-w-0 group">
                    <span className="block text-sm font-bold text-pod-text group-hover:opacity-80 transition-opacity truncate">{m.displayName}</span>
                    <span className="block text-xs text-username truncate">@{m.username}</span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => removeMember.mutate(m.id)}
                    disabled={removeMember.isPending}
                    aria-label={`Remove ${m.displayName} from ${pod.name}`}
                    title="Remove from pod"
                    className="p-1.5 rounded text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <MemberPicker pod={pod} />
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </section>
  );
}

// ── page ───────────────────────────────────────────────────────────────────

export default function PodsPage() {
  const api = useApi();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: pods = [], isLoading, error } = useQuery({
    queryKey: PODS_KEY,
    queryFn: api.pods.list,
  });

  const create = useMutation({
    mutationFn: (body: { name: string; color: string }) => api.pods.create(body),
    onSuccess: next => { setCreateError(null); setCreating(false); patchCache(next.id, next); },
    onError: e => setCreateError(errorText(e, 'Could not create the pod')),
  });

  return (
    <div className="max-w-3xl">
      {/* The "Crew" heading and the Pods tab title this page (CrewPage) — no h1 of its own. */}
      <div className="flex items-start justify-end gap-4 mb-1">
        {!creating && (
          <button
            type="button"
            onClick={() => { setCreateError(null); setCreating(true); }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity flex-shrink-0"
          >
            <Plus className="w-4 h-4" />
            New pod
          </button>
        )}
      </div>
      <div className="flex items-start gap-1.5 text-sm text-muted-foreground mb-6">
        <Lock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          Groups of players to compare your scores against. Only you can see your pods — the people in them aren’t notified.
        </p>
      </div>

      {creating && (
        <section className="rounded-xl border border-white/10 bg-card p-4 mb-6">
          <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3">New pod</h2>
          <PodForm
            idPrefix="new-pod"
            initialName=""
            initialColor={nextPodColor(pods.map(p => p.color))}
            submitLabel="Create pod"
            pending={create.isPending}
            error={createError}
            onSubmit={(name, color) => create.mutate({ name, color })}
            onCancel={() => { setCreateError(null); setCreating(false); }}
          />
        </section>
      )}

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your pods…
        </p>
      ) : error ? (
        <p className="text-sm text-red-400">{errorText(error, 'Could not load your pods')}</p>
      ) : pods.length === 0 ? (
        !creating && (
          <div className="rounded-xl border border-dashed border-white/15 p-8 text-center">
            <Users className="w-8 h-8 text-muted-foreground mx-auto mb-3" aria-hidden />
            <p className="text-sm text-white font-bold mb-1">No pods yet</p>
            <p className="text-sm text-muted-foreground">
              Make one for your league night, your regular crew, or the rivals you’re chasing.
            </p>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-3">
          {pods.map(p => <PodCard key={p.id} pod={p} />)}
        </div>
      )}
    </div>
  );
}
