import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { CheckCircle2, XCircle, HelpCircle } from 'lucide-react';
import { useAdminApi } from '../lib/adminApi';
import { AdminShell, SectionTitle, StatTile, Card, When, ActivityList, ErrorNote } from '../components/admin/AdminParts';

// /admin — Overview: headline counts, active users, system health, and the latest activity.
// (The users table that used to live here is /admin/users.)

function HealthRow({ label, ok, note }: { label: string; ok: boolean | null; note?: React.ReactNode }) {
  const Icon = ok === null ? HelpCircle : ok ? CheckCircle2 : XCircle;
  const tone = ok === null ? 'text-muted-foreground' : ok ? 'text-emerald-400' : 'text-red-400';
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tone}`} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-white">{label}</p>
        {note && <p className="text-xs text-muted-foreground mt-0.5 break-words">{note}</p>}
      </div>
    </li>
  );
}

export default function AdminPage() {
  const admin = useAdminApi();
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'overview'], queryFn: admin.overview, refetchInterval: 60_000 });
  const recent = useQuery({ queryKey: ['admin', 'activity', 'overview'], queryFn: () => admin.activity({ limit: 10 }) });

  const c = data?.counts;
  const h = data?.health;
  const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
  const fresh = (at: string | null) => (at ? Date.now() - +new Date(at) < 36 * 3_600_000 : null);

  return (
    <AdminShell>
      <ErrorNote error={error} />
      {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {c && data && h && (
        <>
          <SectionTitle>People</SectionTitle>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Users" value={n(c.users)} sub={`${n(c.new_users_7d)} new this week${c.disabled_users ? ` · ${c.disabled_users} disabled` : ''}`} href="/admin/users" />
            <StatTile label="Active · 7 days" value={n(data.activeUsers.clerk7d ?? data.activeUsers.app7d)}
              sub={data.activeUsers.clerk7d != null ? `Clerk last active · ${n(data.activeUsers.app7d)} did something` : 'from app activity'} />
            <StatTile label="Active · 30 days" value={n(data.activeUsers.clerk30d ?? data.activeUsers.app30d)}
              sub={data.activeUsers.clerk30d != null ? `Clerk last active · ${n(data.activeUsers.app30d)} did something` : 'from app activity'} />
            <StatTile label="Friendships" value={n(c.friendships)} sub={`${n(c.pending_requests)} pending · ${n(c.pods)} pods`} href="/admin/social" />
          </div>

          <SectionTitle>Play</SectionTitle>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Scores today" value={n(c.scores_today)} sub={`${n(c.scores_7d)} this week · ${n(c.scores)} total`} href="/admin/scores" />
            <StatTile label="Photos" value={n(c.full_photos)} sub={`full-size · ${n(c.thumbnails)} thumbnails`} href="/admin/scores" />
            <StatTile label="Challenges" value={n(c.active_challenges)} sub={`active · ${n(c.pending_challenges)} pending`} href="/admin/social?tab=challenges" />
            <StatTile label="Notifications today" value={n(c.notifications_today)} sub={`${n(c.notifications_unread)} unread overall`} href="/admin/social?tab=notifications" />
          </div>

          <SectionTitle>System</SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-white/5">
              <HealthRow
                label="Pinball Map"
                ok={!h.pm.breakerOpenUntil && (h.pm.catalog?.machineCount ?? 0) > 0}
                note={<>
                  mode {h.pm.mode} · {h.pm.liveCallsToday} live call{h.pm.liveCallsToday === 1 ? '' : 's'} today (this process)
                  {h.pm.catalog
                    ? <> · catalog {h.pm.catalog.machineCount.toLocaleString()} machines{h.pm.catalog.fetchedAt ? <>, <When at={h.pm.catalog.fetchedAt} /></> : ', never fetched'}{h.pm.catalog.stale ? ' (stale)' : ''}</>
                    : ' · catalog status unknown'}
                  {h.pm.breakerOpenUntil && <> · breaker open until {new Date(h.pm.breakerOpenUntil).toLocaleTimeString()} ({h.pm.breakerReason})</>}
                </>}
              />
              <HealthRow label="Full-size photos (R2)" ok={h.r2.configured} note={h.r2.configured ? 'configured' : 'not configured — uploads keep thumbnails only'} />
              <HealthRow label="Clerk sign-in webhook" ok={h.clerkWebhook.configured}
                note={h.clerkWebhook.configured ? 'configured' : 'CLERK_WEBHOOK_SIGNING_SECRET not set — sign-ins aren’t being logged'} />
              <HealthRow label="Clerk API" ok={h.clerkApi.reachable} note={h.clerkApi.reachable ? 'last sign-in / active times available' : 'unreachable — sign-in times unavailable'} />
              <HealthRow label="Daily stat snapshot" ok={fresh(h.cron.statSnapshot)}
                note={h.cron.statSnapshot ? <>last ran <When at={h.cron.statSnapshot} /></> : 'no run recorded'} />
              <HealthRow label="Daily challenge sweep" ok={fresh(h.cron.challengeSweep)}
                note={h.cron.challengeSweep ? <>last ran <When at={h.cron.challengeSweep} /></> : 'no run recorded yet (logged from this release on)'} />
            </ul>
          </Card>
          <p className="text-xs text-muted-foreground mt-2">
            Full service checks (HERE, Anthropic, GitHub, Vercel, env vars) are on <Link href="/admin/health" className="text-primary hover:underline">Health</Link>.
          </p>

          <SectionTitle right={<Link href="/admin/activity" className="text-xs font-bold uppercase tracking-wider text-primary hover:underline">All activity</Link>}>
            Latest activity
          </SectionTitle>
          <ActivityList items={recent.data?.items ?? []} empty={recent.isLoading ? 'Loading…' : 'Nothing logged yet.'} />
          <p className="text-xs text-muted-foreground mt-2">
            {c.events.toLocaleString()} events logged{c.events_since ? <> since <When at={c.events_since} /></> : ''}. The log starts when this release shipped; nothing before it was recorded.
          </p>
        </>
      )}
    </AdminShell>
  );
}
