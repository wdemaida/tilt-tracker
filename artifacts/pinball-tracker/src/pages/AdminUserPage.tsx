import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'wouter';
import { ArrowLeft, Pencil, UserX, UserCheck, BellOff, X } from 'lucide-react';
import { useAdminApi, type AdminUserDetail } from '../lib/adminApi';
import { useAppUser } from '../lib/useAppUser';
import UsernameLink from '../components/UsernameLink';
import {
  AdminShell, SectionTitle, Card, Pill, When, StatTile, ActivityList, LoadMore, ConfirmDialog, ErrorNote, AdminUserLink,
} from '../components/admin/AdminParts';
import { AdminScoreRow, AdminChallengeRow } from '../components/admin/AdminRows';

// /admin/users/:id — one person: profile facts, Clerk sign-in times, their friendships, pods,
// challenges, recent scores and full activity timeline, plus the account actions.

const btn = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors';

function EditUserModal({ user, onClose }: { user: AdminUserDetail['user']; onClose: () => void }) {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState(user.role);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const updates: { role?: string; displayName?: string; username?: string } = {};
    if (role !== user.role) updates.role = role;
    if (displayName.trim() !== user.displayName) updates.displayName = displayName;
    if (username.trim() !== user.username) updates.username = username;
    if (!Object.keys(updates).length) return onClose();
    setSaving(true);
    setError(null);
    try {
      await admin.updateUser(user.id, updates);
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const input = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full';
  const label = 'text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 block';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <form onSubmit={save} onClick={e => e.stopPropagation()}
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black uppercase tracking-widest text-white">Edit user</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-white" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <div><label className={label}>Username</label><input value={username} onChange={e => setUsername(e.target.value)} className={input} required /></div>
        <div><label className={label}>Display name</label><input value={displayName} onChange={e => setDisplayName(e.target.value)} className={input} required /></div>
        <div>
          <label className={label}>Role</label>
          <select value={role} onChange={e => setRole(e.target.value as 'admin' | 'user')} className={`${input} cursor-pointer`}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <ErrorNote error={error} />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="flex-1 border border-white/20 text-muted-foreground hover:text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider">Cancel</button>
          <button type="submit" disabled={saving} className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm text-white mt-0.5 break-words">{children}</p>
    </div>
  );
}

export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
  const userId = Number(id);
  const admin = useAdminApi();
  const me = useAppUser();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'disable' | 'enable' | 'clear' | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'user', userId], queryFn: () => admin.user(userId), enabled: Number.isFinite(userId) });
  const more = useInfiniteQuery({
    queryKey: ['admin', 'user', userId, 'activity-more'],
    queryFn: ({ pageParam }) => admin.activity({ userId, before: pageParam, limit: 30 }),
    initialPageParam: data?.activity.nextBefore ?? null,
    getNextPageParam: last => last.nextBefore,
    enabled: false,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const u = data?.user;
  const isSelf = me?.id === userId;
  const extraActivity = more.data?.pages.flatMap(p => p.items) ?? [];
  const activityItems = [...(data?.activity.items ?? []), ...extraActivity];
  const hasMoreActivity = more.data ? more.hasNextPage : !!data?.activity.nextBefore;

  return (
    <AdminShell wide>
      <Link href="/admin/users" className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white mb-4">
        <ArrowLeft className="w-3.5 h-3.5" /> All users
      </Link>
      <ErrorNote error={error} />
      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {data && u && (
        <>
          <Card className="p-4 sm:p-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-xl font-black text-white break-words">{u.displayName}</h2>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <UsernameLink username={u.username} />
                  {u.role === 'admin' && <Pill tone="primary">admin</Pill>}
                  {u.disabledAt && <Pill tone="danger">disabled</Pill>}
                  {data.clerk?.banned && <Pill tone="warn">banned in Clerk</Pill>}
                  {isSelf && <Pill>you</Pill>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setDialog('edit')} className={`${btn} border-white/15 text-muted-foreground hover:text-white`}><Pencil className="w-3.5 h-3.5" /> Edit</button>
                {u.disabledAt ? (
                  <button type="button" onClick={() => setDialog('enable')} className={`${btn} border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10`}><UserCheck className="w-3.5 h-3.5" /> Re-enable</button>
                ) : (
                  <button type="button" onClick={() => setDialog('disable')} disabled={isSelf || u.role === 'admin'}
                    title={isSelf ? 'You can’t disable yourself' : u.role === 'admin' ? 'Admins can’t be disabled — remove the role first' : undefined}
                    className={`${btn} border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:bg-transparent`}><UserX className="w-3.5 h-3.5" /> Disable</button>
                )}
                <button type="button" onClick={() => setDialog('clear')} disabled={!data.counts.notifications}
                  className={`${btn} border-white/15 text-muted-foreground hover:text-white disabled:opacity-40`}><BellOff className="w-3.5 h-3.5" /> Clear notifications</button>
              </div>
            </div>
            {lastResult && <p className="text-xs text-amber-400 mt-3">{lastResult}</p>}
            {u.disabledAt && (
              <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-4">
                Disabled <When at={u.disabledAt} />{u.disabledBy && <> by <UsernameLink username={u.disabledBy.username} /></>}
                {u.disabledReason && <> — “{u.disabledReason}”</>}
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5">
              <Fact label="User id">{u.id}</Fact>
              <Fact label="Joined"><When at={u.createdAt} /></Fact>
              <Fact label="Last sign-in">{data.clerkAvailable ? <When at={data.clerk?.lastSignInAt} fallback="never" /> : 'Clerk unavailable'}</Fact>
              <Fact label="Last active">{data.clerkAvailable ? <When at={data.clerk?.lastActiveAt} fallback="never" /> : 'Clerk unavailable'}</Fact>
              <Fact label="Pinball Map">{u.pinballMapUsername ?? <span className="text-muted-foreground italic">not linked</span>}{u.hasPmToken ? '' : u.pinballMapUsername ? ' (signed out)' : ''}</Fact>
              <Fact label="Clerk user">{<span className="font-mono text-xs">{u.clerkUserId}</span>}</Fact>
              <Fact label="Home venues">{data.counts.owned_venues}</Fact>
              <Fact label="Notifications">{data.counts.notifications} ({data.counts.unread_notifications} unread)</Fact>
            </div>
          </Card>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <StatTile label="Scores" value={data.counts.scores} sub={`${data.counts.full_photos} with full photo`} href={`/admin/scores?userId=${u.id}`} />
            <StatTile label="Friends" value={data.friendships.filter(f => f.status === 'accepted').length}
              sub={`${data.friendships.filter(f => f.status === 'pending').length} pending · ${data.friendships.filter(f => f.status === 'declined').length} declined`} />
            <StatTile label="Pods" value={data.pods.owned.length} sub={`in ${data.pods.memberOf.length} of others’`} />
            <StatTile label="Challenges" value={data.challenges.length} sub={`${data.challenges.filter(c => c.status === 'active').length} active`} />
          </div>

          <div className="grid lg:grid-cols-2 gap-x-6">
            <div>
              <SectionTitle>Friendships</SectionTitle>
              {data.friendships.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-white/5">
                    {data.friendships.map(f => (
                      <li key={f.id} className="px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm">
                        <AdminUserLink user={f.other} />
                        <Pill tone={f.status === 'accepted' ? 'ok' : f.status === 'pending' ? 'warn' : 'muted'}>{f.status}</Pill>
                        <span className="text-xs text-muted-foreground">
                          {f.outgoing ? 'they asked' : 'asked them'} <When at={f.createdAt} />{f.declineCount ? ` · ${f.declineCount} decline${f.declineCount === 1 ? '' : 's'}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <p className="text-xs text-muted-foreground mt-2">Remove a friendship from Social → Friendships.</p>
            </div>
            <div>
              <SectionTitle>Pods</SectionTitle>
              {data.pods.owned.length + data.pods.memberOf.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
                <Card className="p-4 space-y-3 text-sm">
                  {data.pods.owned.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Their pods (private)</p>
                      <ul className="space-y-1">
                        {data.pods.owned.map(p => (
                          <li key={p.id} className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full" style={{ background: p.color }} aria-hidden />
                            <span className="text-white">{p.name}</span>
                            <span className="text-xs text-muted-foreground">{p.memberCount} member{p.memberCount === 1 ? '' : 's'}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.pods.memberOf.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">In other people’s pods</p>
                      <ul className="space-y-1">
                        {data.pods.memberOf.map(p => <li key={p.podId} className="text-white">{p.name} <span className="text-xs text-muted-foreground">— <UsernameLink username={p.owner.username} /></span></li>)}
                      </ul>
                    </div>
                  )}
                </Card>
              )}
            </div>
          </div>

          <SectionTitle>Challenges</SectionTitle>
          {data.challenges.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            <Card className="overflow-hidden"><ul className="divide-y divide-white/5">{data.challenges.map(c => <AdminChallengeRow key={c.id} c={c} />)}</ul></Card>
          )}

          <SectionTitle right={<Link href={`/admin/scores?userId=${u.id}`} className="text-xs font-bold uppercase tracking-wider text-primary hover:underline">All scores</Link>}>
            Recent scores
          </SectionTitle>
          {data.recentScores.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
            <Card className="overflow-hidden"><ul className="divide-y divide-white/5">{data.recentScores.map(s => <AdminScoreRow key={s.id} s={s} showUser={false} />)}</ul></Card>
          )}

          <SectionTitle>Activity</SectionTitle>
          <ActivityList items={activityItems} empty="Nothing logged for this user yet." />
          <LoadMore hasMore={hasMoreActivity} loading={more.isFetching} onClick={() => (more.data ? more.fetchNextPage() : more.refetch())} />

          {dialog === 'edit' && <EditUserModal user={u} onClose={() => setDialog(null)} />}
          {dialog === 'disable' && (
            <ConfirmDialog
              title={`Disable @${u.username}`} confirmLabel="Disable account" reason="Reason (shown to other admins, kept in the log)"
              body={<>
                <p>They’re locked out of TiltTrack at once (every signed-in request answers “account disabled”), and banned in Clerk so they can’t sign in and their sessions end.</p>
                <p className="text-muted-foreground">Their scores, friendships and challenges stay as they are. Re-enable any time.</p>
              </>}
              onConfirm={async reason => {
                const r = await admin.disableUser(u.id, reason);
                setLastResult(r.clerkBanned === false ? `Disabled in TiltTrack, but the Clerk ban failed: ${r.clerkError ?? 'unknown error'}. Disable again to retry.` : null);
                await refresh();
              }}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog === 'enable' && (
            <ConfirmDialog
              title={`Re-enable @${u.username}`} confirmLabel="Re-enable" danger={false}
              body={<p>Lift the TiltTrack lock and the Clerk ban. They can sign in again straight away.</p>}
              onConfirm={async () => {
                const r = await admin.enableUser(u.id);
                setLastResult(r.clerkUnbanned === false ? `Re-enabled in TiltTrack, but the Clerk unban failed: ${r.clerkError ?? 'unknown error'}. Try again.` : null);
                await refresh();
              }}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog === 'clear' && (
            <ConfirmDialog
              title="Clear notifications" confirmLabel="Clear all"
              body={<p>Delete all {data.counts.notifications} of @{u.username}’s notifications, read or unread. The activity log keeps a record of each one that was sent.</p>}
              onConfirm={async () => { await admin.clearNotifications(u.id); await refresh(); }}
              onClose={() => setDialog(null)}
            />
          )}
        </>
      )}
    </AdminShell>
  );
}
