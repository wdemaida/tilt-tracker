import { useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { formatDistanceToNow } from 'date-fns';
import { ShieldCheck, X, Loader2 } from 'lucide-react';
import AdminNav from '../AdminNav';
import UsernameLink from '../UsernameLink';
import type { ActivityEvent, UserRef } from '../../lib/adminApi';

// Shared pieces of the admin area (pages under /admin). Same visual language as the rest of the app:
// dark cards on white/10 borders, black uppercase headings, the segmented pill from ScopeToggle.

export function AdminShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`${wide ? 'max-w-6xl' : 'max-w-4xl'} mx-auto`}>
      <div className="flex items-center gap-3 mb-6">
        <ShieldCheck className="w-7 h-7 text-primary" />
        <h1 className="text-2xl sm:text-3xl font-black uppercase tracking-widest text-white">Admin</h1>
      </div>
      <AdminNav />
      {children}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 mt-8 first:mt-0">
      <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">{children}</h2>
      {right}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-white/10 bg-white/[0.03] ${className}`}>{children}</div>;
}

export function Segmented<T extends string>({ options, value, onChange }: {
  options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto gap-0.5 p-1 rounded-lg bg-white/5 border border-white/10">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wider whitespace-nowrap transition-colors ${
            value === o.value ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function StatTile({ label, value, sub, href }: { label: string; value: ReactNode; sub?: ReactNode; href?: string }) {
  const inner = (
    <Card className={`p-4 h-full ${href ? 'hover:border-white/25 transition-colors' : ''}`}>
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-2xl font-black text-white mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </Card>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'primary' | 'danger' | 'ok' | 'warn' }) {
  const tones = {
    muted: 'bg-white/10 text-muted-foreground',
    primary: 'bg-primary/20 text-primary',
    danger: 'bg-red-500/15 text-red-400',
    ok: 'bg-emerald-500/15 text-emerald-400',
    warn: 'bg-amber-500/15 text-amber-400',
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide ${tones[tone]}`}>{children}</span>;
}

/** "3 hours ago", with the exact local time on hover. */
export function When({ at, fallback = '—' }: { at: string | null | undefined; fallback?: string }) {
  if (!at) return <span className="text-muted-foreground">{fallback}</span>;
  const d = new Date(at);
  return <time dateTime={at} title={d.toLocaleString()}>{formatDistanceToNow(d, { addSuffix: true })}</time>;
}

export function Who({ user, fallback = 'System' }: { user: UserRef | null | undefined; fallback?: string }) {
  if (!user) return <span className="text-muted-foreground italic">{fallback}</span>;
  return <UsernameLink username={user.username} />;
}

/** The admin user page link for someone (distinct from their public profile, which UsernameLink opens). */
export function AdminUserLink({ user }: { user: UserRef }) {
  return (
    <Link href={`/admin/users/${user.id}`} className="font-semibold text-white hover:text-primary transition-colors">
      {user.displayName}
    </Link>
  );
}

export function LoadMore({ hasMore, loading, onClick }: { hasMore: boolean; loading: boolean; onClick: () => void }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center mt-4">
      <button
        type="button" onClick={onClick} disabled={loading}
        className="px-4 py-2 rounded-lg border border-white/15 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-white disabled:opacity-50"
      >
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = (error as any)?.message ?? 'Something went wrong';
  return <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{msg}</p>;
}

/**
 * Every admin action goes through this: a modal that says exactly what will happen, optionally asks
 * for a reason (stored with the action in the activity log), and shows the server's refusal inline.
 */
export function ConfirmDialog({ title, body, confirmLabel, danger = true, reason, onConfirm, onClose }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Ask for a reason: the placeholder text. */
  reason?: string;
  onConfirm: (reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function go() {
    setPending(true);
    setError(null);
    try {
      await onConfirm(text.trim());
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={pending ? undefined : onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div role="dialog" aria-modal="true" aria-label={title}
        className="relative bg-[#1a1a2e] border border-white/10 rounded-2xl shadow-2xl w-full max-w-md p-5 sm:p-6 flex flex-col gap-4"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-black uppercase tracking-widest text-white">{title}</h2>
          <button type="button" onClick={onClose} disabled={pending} className="text-muted-foreground hover:text-white" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="text-sm text-white/80 space-y-2">{body}</div>
        {reason !== undefined && (
          <textarea
            value={text} onChange={e => setText(e.target.value)} placeholder={reason} rows={2} maxLength={500}
            className="border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full"
          />
        )}
        <ErrorNote error={error} />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={pending}
            className="flex-1 border border-white/20 text-muted-foreground hover:text-white rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider">
            Cancel
          </button>
          <button type="button" onClick={go} disabled={pending}
            className={`flex-1 inline-flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold uppercase tracking-wider text-white disabled:opacity-50 ${
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-primary hover:bg-primary/90'}`}>
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── activity rendering ───────────────────────────────────────────────────────

const TYPE_TEXT: Record<string, string> = {
  'user.signed_up': 'signed up (Clerk)',
  'user.signed_in': 'signed in',
  'user.first_setup': 'set up their profile',
  'user.clerk_deleted': 'Clerk account deleted',
  'score.created': 'posted a score',
  'score.edited': 'edited a score',
  'score.deleted': 'deleted a score',
  'score.repair_machine': 'repaired a score’s machine',
  'photo.uploaded': 'uploaded a full-size photo',
  'photo.replaced': 'replaced a full-size photo',
  'venue.repair_here': 're-ran the HERE lookup for a venue',
  'venue.repair_here_attach': 'attached a HERE place to a venue',
  'venue.repair_place': 'set a venue’s place',
  'venue.repair_pm_link': 'changed a venue’s Pinball Map link',
  'venue.resync_applied': 're-synced a venue’s scores',
  'venue.merged': 'merged a duplicate venue',
  'friend.request_sent': 'sent a friend request to',
  'friend.request_resent': 're-sent a friend request to',
  'friend.request_accepted': 'became friends with',
  'friend.request_declined': 'declined a friend request from',
  'friend.request_cancelled': 'withdrew a friend request to',
  'friend.removed': 'unfriended',
  'pod.created': 'created a pod',
  'pod.updated': 'changed a pod',
  'pod.deleted': 'deleted a pod',
  'pod.member_added': 'added to a pod:',
  'pod.member_removed': 'removed from a pod:',
  'challenge.created': 'challenged',
  'challenge.accepted': 'accepted a challenge',
  'challenge.declined': 'declined a challenge',
  'challenge.cancelled': 'withdrew a challenge',
  'challenge.forfeited': 'forfeited a challenge',
  'challenge.resolved': 'Challenge resolved',
  'challenge.expired': 'Challenge expired unanswered',
  'notification.sent': 'Notification sent to',
  'pm.connected': 'connected their Pinball Map account',
  'pm.score_posted': 'posted a score to Pinball Map',
  'pm.score_post_failed': 'failed to post a score to Pinball Map',
  'admin.user_updated': 'edited user',
  'admin.user_disabled': 'disabled',
  'admin.user_enabled': 're-enabled',
  'admin.score_deleted': 'deleted a score by',
  'admin.photo_deleted': 'deleted a full-size photo of',
  'admin.thumbnail_deleted': 'deleted a thumbnail of',
  'admin.challenge_voided': 'voided a challenge',
  'admin.friendship_removed': 'removed a friendship',
  'admin.notification_deleted': 'deleted a notification of',
  'admin.notifications_cleared': 'cleared the notifications of',
  'admin.venue_deleted': 'deleted a venue',
  'admin.machine_updated': 'edited a machine',
  'admin.machine_deleted': 'deleted a machine',
  'admin.settings_changed': 'changed a setting',
  'admin.photo_orphans_run': 'ran the photo orphan sweep',
  'system.stat_snapshot': 'Daily stat snapshot ran',
  'system.challenge_sweep': 'Daily challenge sweep ran',
  'system.activity_retention': 'Activity-log retention ran',
  'system.photo_orphans': 'Weekly photo orphan sweep ran',
};

const CATEGORY_TONE: Record<string, 'muted' | 'primary' | 'danger' | 'ok' | 'warn'> = {
  admin: 'danger', auth: 'ok', pm: 'warn', challenge: 'primary',
};

function targetLink(ev: ActivityEvent): ReactNode {
  const id = ev.targetId;
  if (!id) return null;
  switch (ev.targetType) {
    case 'challenge': return <Link href={`/challenges/${id}`} className="text-primary hover:underline">challenge #{id}</Link>;
    case 'venue': return <Link href={`/venues/${id}`} className="text-venue hover:underline">venue #{id}</Link>;
    case 'score': return <span className="text-muted-foreground">score #{id}</span>;
    case 'pod': return <span className="text-muted-foreground">pod #{id}</span>;
    case 'machine': return <span className="text-muted-foreground">machine #{id}</span>;
    default: return null;
  }
}

/** One short line of detail from the payload, for the types where it adds something. */
function detail(ev: ActivityEvent): string | null {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case 'score.created': case 'score.deleted': case 'admin.score_deleted':
      return [p.machineName, typeof p.score === 'number' ? p.score.toLocaleString() : null].filter(Boolean).join(' · ') || null;
    case 'score.edited':
      return p.changes ? Object.entries(p.changes as Record<string, any>).map(([k, v]) => `${k}: ${v?.from ?? '∅'} → ${v?.to ?? '∅'}`).join(', ') : null;
    case 'notification.sent': return String(p.kind ?? '');
    case 'challenge.resolved':
      return Array.isArray(p.outcomes) ? p.outcomes.map((o: any) => `@${o.username ?? o.userId} ${o.outcome}`).join(', ') + (p.reason ? ` (${p.reason})` : '') : null;
    case 'challenge.created': case 'challenge.accepted': case 'challenge.declined': case 'challenge.cancelled': case 'challenge.forfeited':
      return [p.challengeType, p.machineName].filter(Boolean).join(' · ') || null;
    case 'pod.created': case 'pod.deleted': case 'pod.member_added': case 'pod.member_removed':
      return p.name ?? null;
    case 'pod.updated': return p.renamedFrom ? `“${p.renamedFrom}” → “${p.name}”` : p.color ? `color ${p.color}` : null;
    case 'admin.user_disabled': return [p.reason, p.clerkBanned === false ? `Clerk ban failed: ${p.clerkError ?? ''}` : null].filter(Boolean).join(' · ') || null;
    case 'admin.challenge_voided': return [p.previousStatus ? `was ${p.previousStatus}` : null, p.reason].filter(Boolean).join(' · ') || null;
    case 'pm.score_posted': case 'pm.score_post_failed':
      return [p.machineName, typeof p.score === 'number' ? p.score.toLocaleString() : null, ev.type === 'pm.score_post_failed' ? `HTTP ${p.status}` : null].filter(Boolean).join(' · ') || null;
    case 'user.signed_in': return [p.city, p.country, p.isMobile ? 'mobile' : null].filter(Boolean).join(', ') || null;
    case 'system.challenge_sweep': return `resolved ${p.resolved ?? 0}, expired ${p.expired ?? 0}, errors ${p.errors ?? 0}`;
    case 'admin.user_updated': return p.changes ? Object.keys(p.changes).join(', ') : null;
    case 'admin.settings_changed': {
      if (!p.before || !p.after) return p.setting ?? null;
      const diffs = Object.keys(p.after).filter(k => p.before[k] !== p.after[k]).map(k => `${k}: ${p.before[k]} → ${p.after[k]}`);
      return `${p.setting ?? 'setting'}${diffs.length ? ` · ${diffs.join(', ')}` : ' (unchanged)'}`;
    }
    case 'system.activity_retention':
      return `deleted ${p.total ?? 0} (high-volume ${p.deleted?.high_volume ?? 0}, standard ${p.deleted?.standard ?? 0}, admin ${p.deleted?.admin ?? 0})${p.capped ? ' · capped' : ''}${p.errors?.length ? ` · ${p.errors.length} error(s)` : ''}`;
    case 'system.photo_orphans': case 'admin.photo_orphans_run':
      return `${p.dryRun ? 'dry run · ' : ''}${p.orphans ?? 0} orphan(s) of ${p.listed ?? 0} objects${p.dryRun ? '' : `, deleted ${p.deleted ?? 0}`}${p.failed ? `, ${p.failed} failed` : ''}${p.capped ? ' · capped' : ''}`;
    default: return null;
  }
}

export function ActivityRow({ ev }: { ev: ActivityEvent }) {
  const [open, setOpen] = useState(false);
  const verb = TYPE_TEXT[ev.type] ?? ev.type;
  const systemish = !ev.actor && (ev.type.startsWith('system.') || ev.type.startsWith('challenge.re') || ev.type.startsWith('challenge.ex') || ev.type === 'notification.sent');
  const line = detail(ev);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-white/85 break-words">
            {!systemish && <><Who user={ev.actor} fallback={ev.targetType === 'clerk_user' ? 'Clerk user (no profile yet)' : 'System'} />{' '}</>}
            {verb}
            {ev.subject && <>{' '}<UsernameLink username={ev.subject.username} /></>}
            {targetLink(ev) && <>{' · '}{targetLink(ev)}</>}
          </p>
          {line && <p className="text-xs text-muted-foreground mt-0.5 break-words">{line}</p>}
          <p className="text-[11px] text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill tone={CATEGORY_TONE[ev.category] ?? 'muted'}>{ev.category}</Pill>
            <When at={ev.createdAt} />
            <button type="button" onClick={() => setOpen(o => !o)} className="underline decoration-dotted hover:text-white">
              {open ? 'hide' : 'details'}
            </button>
          </p>
        </div>
      </div>
      {open && (
        <pre className="mt-2 text-[11px] leading-relaxed text-white/70 bg-black/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify({ id: ev.id, type: ev.type, at: ev.createdAt, target: ev.targetType ? `${ev.targetType}:${ev.targetId}` : null, ip: ev.ip, userAgent: ev.userAgent, payload: ev.payload }, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function ActivityList({ items, empty = 'No activity yet.' }: { items: ActivityEvent[]; empty?: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-white/5">{items.map(ev => <ActivityRow key={ev.id} ev={ev} />)}</ul>
    </Card>
  );
}
