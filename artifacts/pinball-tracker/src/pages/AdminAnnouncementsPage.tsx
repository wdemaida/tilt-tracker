import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from 'wouter';
import { Megaphone, Search, Send, Undo2, X } from 'lucide-react';
import {
  useAdminApi, type AnnouncementAudience, type AnnouncementDraft, type AnnouncementHistoryItem, type AnnouncementPreview,
  type UserRef,
} from '../lib/adminApi';
import type { AppNotification } from '../lib/api';
import { isInternalPath } from '../lib/internalPath';
import NotificationRow from '../components/NotificationRow';
import UsernameLink from '../components/UsernameLink';
import {
  AdminShell, SectionTitle, Card, Segmented, Pill, When, LoadMore, ConfirmDialog, ErrorNote,
} from '../components/admin/AdminParts';

// /admin/announcements — send a short plain-text notice, signed "TiltTrack", to every active user or
// to picked users; see who it reached; retract it. The server is the authority on every rule
// (lib/announcements.ts on the api-server) — this page mirrors the limits for counters and the link
// rule for an early warning. `?to=<userId>` pre-picks one user (the "Send notification" button on
// /admin/users/:id).

const DEFAULTS = { titleMax: 80, bodyMax: 500, linkMax: 200, maxPicked: 200, sendsPerHour: 10 };
const QUICK_LINKS: Array<{ label: string; link: string }> = [
  { label: 'Challenges tab', link: '/crew?tab=challenges' },
  { label: 'Their profile', link: '/users/{username}' },
  { label: 'Badges', link: '/badges' },
  { label: 'Add a score', link: '/add' },
];

const input = 'border border-white/20 rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary w-full';
const label = 'text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1 flex items-center justify-between gap-2';

function newRequestId(): string {
  try { return crypto.randomUUID(); } catch { return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`; }
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={`tabular-nums normal-case tracking-normal ${n > max ? 'text-red-400' : 'text-muted-foreground'}`}>{n}/{max}</span>;
}

/** Field errors from a 400 `invalid_announcement` (or an audience error). */
function fieldErrors(err: unknown): Record<string, string> {
  const body = (err as any)?.body;
  return body && typeof body.errors === 'object' && body.errors ? body.errors : {};
}

function UserPicker({ picked, onAdd, onRemove, max }: {
  picked: UserRef[]; onAdd: (u: UserRef) => void; onRemove: (id: number) => void; max: number;
}) {
  const admin = useAdminApi();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const { data, isFetching } = useQuery({
    queryKey: ['admin', 'users', dq, 'all'], queryFn: () => admin.users(dq, 'all'), enabled: dq.length >= 1,
  });
  const pickedIds = new Set(picked.map(u => u.id));
  const results = (data?.items ?? []).filter(u => !pickedIds.has(u.id)).slice(0, 8);
  return (
    <div className="flex flex-col gap-2">
      {picked.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {picked.map(u => (
            <span key={u.id} className="inline-flex items-center gap-1 rounded-full bg-white/10 border border-white/15 pl-2.5 pr-1 py-0.5 text-xs text-white">
              {u.displayName} <span className="text-username">@{u.username}</span>
              <button type="button" onClick={() => onRemove(u.id)} className="p-0.5 text-muted-foreground hover:text-white" aria-label={`Remove @${u.username}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={picked.length >= max ? `At most ${max} users` : 'Search username or name'}
          disabled={picked.length >= max} className={`${input} pl-9`} />
      </label>
      {dq && (
        <Card className="overflow-hidden">
          {isFetching && !data ? <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p> : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No one else matches.</p>
          ) : (
            <ul className="divide-y divide-white/5">
              {results.map(u => (
                <li key={u.id}>
                  <button type="button" disabled={!!u.disabledAt}
                    onClick={() => { onAdd({ id: u.id, username: u.username, displayName: u.displayName }); setQ(''); }}
                    className="w-full text-left px-3 py-2 text-sm text-white hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent flex items-center gap-2">
                    <span className="truncate">{u.displayName} <span className="text-username">@{u.username}</span></span>
                    {u.disabledAt && <Pill tone="danger">disabled — won’t receive</Pill>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function ReviewBody({ p, sendsPerHour }: { p: AnnouncementPreview; sendsPerHour: number }) {
  return (
    <>
      <p>
        <span className="font-bold text-white">{p.recipientCount} {p.recipientCount === 1 ? 'user' : 'users'}</span>
        {p.audience === 'all' ? ' — every active user (disabled accounts are left out).' : ' will get it in their notifications.'}
        {' '}It shows as a toast if they have the app open. It can’t be edited after sending — only retracted.
      </p>
      {p.sample.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Including {p.sample.map(u => `@${u.username}`).join(', ')}{p.recipientCount > p.sample.length ? ` and ${p.recipientCount - p.sample.length} more` : ''}.
        </p>
      )}
      {p.skipped.length > 0 && (
        <p className="text-xs text-amber-400">
          Skipped {p.skipped.length}: {p.skipped.map(s => `${s.username ? `@${s.username}` : `#${s.id}`} (${s.reason})`).join(', ')}.
        </p>
      )}
      {p.duplicateOf && (
        <p className="text-xs text-amber-400">
          The same announcement went to the same audience <When at={p.duplicateOf.at} />. Sending again will notify them twice.
        </p>
      )}
      <div className="pt-1">
        <NotificationRow preview n={previewNotification(p.normalized, p.sample[0]?.username ?? 'someone')} />
      </div>
      <p className="text-[11px] text-muted-foreground">Limit: {sendsPerHour} announcements an hour.</p>
    </>
  );
}

function previewNotification(d: { title: string; body: string; link: string | null }, username: string): AppNotification {
  return {
    id: 0, kind: 'announcement', createdAt: new Date().toISOString(), readAt: null,
    payload: {
      announcementId: 'preview', title: d.title || 'Your title', body: d.body,
      link: d.link ? d.link.split('{username}').join(encodeURIComponent(username)) : null, from: 'TiltTrack',
    },
  };
}

function HistoryRow({ a }: { a: AnnouncementHistoryItem }) {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Megaphone className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-white break-words">{a.title}</p>
          <p className="text-sm text-white/75 whitespace-pre-line break-words mt-0.5">{a.body}</p>
          {a.link && <p className="text-xs text-primary break-all mt-0.5">→ {a.link}</p>}
          <p className="text-[11px] text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <Pill tone={a.audience === 'all' ? 'primary' : 'muted'}>{a.audience === 'all' ? 'everyone' : 'picked'}</Pill>
            <span>Sent <When at={a.sentAt} />{a.sentBy && <> by <UsernameLink username={a.sentBy.username} /></>}</span>
            <span>· {a.recipientCount} recipients</span>
            {a.retractedAt ? (
              <Pill tone="danger">retracted</Pill>
            ) : (
              <span title="Live counts: read notifications are deleted after 30 days and players can clear their inbox">
                · {a.delivered} in inboxes, {a.unread} unread
              </span>
            )}
          </p>
          {a.retractedAt && (
            <p className="text-[11px] text-muted-foreground mt-0.5">Retracted <When at={a.retractedAt} />{a.retracted != null && <> — removed from {a.retracted} {a.retracted === 1 ? 'inbox' : 'inboxes'}</>}</p>
          )}
        </div>
        {!a.retractedAt && (
          <button type="button" onClick={() => setConfirm(true)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-red-500/30 text-[11px] font-bold uppercase tracking-wider text-red-400 hover:bg-red-500/10 transition-colors">
            <Undo2 className="w-3 h-3" /> Retract
          </button>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Retract announcement" confirmLabel="Retract"
          body={<p>Remove “{a.title}” from every inbox it’s still in ({a.delivered}), read or not. Players who already saw it can’t unsee it. The activity log keeps the record.</p>}
          onConfirm={async () => { await admin.retractAnnouncement(a.announcementId); await qc.invalidateQueries({ queryKey: ['admin'] }); }}
          onClose={() => setConfirm(false)}
        />
      )}
    </li>
  );
}

export default function AdminAnnouncementsPage() {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const params = new URLSearchParams(useSearch());
  const toParam = Number(params.get('to'));

  const limitsQ = useQuery({ queryKey: ['admin', 'announcement-limits'], queryFn: admin.announcementLimits, staleTime: Infinity });
  const lim = { ...DEFAULTS, ...(limitsQ.data ?? {}) };

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [audience, setAudience] = useState<AnnouncementAudience>(Number.isSafeInteger(toParam) && toParam > 0 ? 'users' : 'all');
  const [picked, setPicked] = useState<UserRef[]>([]);
  const [requestId, setRequestId] = useState(newRequestId);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<AnnouncementPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<string | null>(null);

  // ?to=<id>: pre-pick that user once their details load.
  const toUser = useQuery({
    queryKey: ['admin', 'user', toParam], queryFn: () => admin.user(toParam),
    enabled: Number.isSafeInteger(toParam) && toParam > 0,
  });
  useEffect(() => {
    const u = toUser.data?.user;
    if (u) setPicked(p => (p.some(x => x.id === u.id) ? p : [...p, { id: u.id, username: u.username, displayName: u.displayName }]));
  }, [toUser.data]);

  const history = useInfiniteQuery({
    queryKey: ['admin', 'announcements'],
    queryFn: ({ pageParam }) => admin.announcements(pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: last => last.nextBefore,
  });
  const historyItems = history.data?.pages.flatMap(p => p.items) ?? [];

  const trimmedLink = link.trim();
  const linkLooksWrong = !!trimmedLink && !isInternalPath(trimmedLink.split('{username}').join('someone'));
  const draft: AnnouncementDraft = {
    title, body, link: trimmedLink || null, audience,
    ...(audience === 'users' ? { userIds: picked.map(u => u.id) } : {}),
  };
  const errs = fieldErrors(error);
  const sampleName = audience === 'users' && picked[0] ? picked[0].username : 'someone';
  const livePreview = useMemo(
    () => previewNotification({ title: title.trim(), body: body.trim(), link: trimmedLink || null }, sampleName),
    [title, body, trimmedLink, sampleName],
  );
  const canReview = title.trim().length > 0 && body.trim().length > 0 && title.length <= lim.titleMax && body.length <= lim.bodyMax
    && !linkLooksWrong && (audience === 'all' || picked.length > 0) && !reviewing;

  function edited() {
    setError(null);
    setSent(null);
  }

  async function openReview() {
    setReviewing(true);
    setError(null);
    setSent(null);
    try {
      setReview(await admin.previewAnnouncement(draft));
    } catch (err) {
      setError(err);
    } finally {
      setReviewing(false);
    }
  }

  async function send(p: AnnouncementPreview) {
    const r = await admin.sendAnnouncement({ ...draft, confirmCount: p.recipientCount, requestId, allowDuplicate: !!p.duplicateOf });
    setSent(`Sent to ${r.sent} ${r.sent === 1 ? 'user' : 'users'}${r.skipped.length ? ` (${r.skipped.length} skipped)` : ''}.`);
    setTitle(''); setBody(''); setLink(''); setPicked([]); setAudience('all');
    setRequestId(newRequestId());
    await qc.invalidateQueries({ queryKey: ['admin'] });
  }

  return (
    <AdminShell>
      <SectionTitle>New announcement</SectionTitle>
      <Card className="p-4 sm:p-5 flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Plain text, signed “TiltTrack”. It lands in each player’s notifications (with a toast if the app is open). No email or push.
        </p>
        <div>
          <label className={label} htmlFor="ann-title">Title <Counter n={title.length} max={lim.titleMax} /></label>
          <input id="ann-title" value={title} onChange={e => { setTitle(e.target.value); edited(); }} maxLength={lim.titleMax + 20} className={input}
            placeholder="New: Last Resort areas" />
          {errs.title && <p className="text-xs text-red-400 mt-1">{errs.title}</p>}
        </div>
        <div>
          <label className={label} htmlFor="ann-body">Message <Counter n={body.length} max={lim.bodyMax} /></label>
          <textarea id="ann-body" value={body} onChange={e => { setBody(e.target.value); edited(); }} rows={5} maxLength={lim.bodyMax + 50} className={input}
            placeholder="What’s new, in a few sentences. Line breaks are kept." />
          {errs.body && <p className="text-xs text-red-400 mt-1">{errs.body}</p>}
        </div>
        <div>
          <label className={label} htmlFor="ann-link">Link (optional)</label>
          <input id="ann-link" value={link} onChange={e => { setLink(e.target.value); edited(); }} maxLength={lim.linkMax + 20} className={`${input} font-mono`}
            placeholder="/crew?tab=challenges" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {QUICK_LINKS.map(q => (
              <button key={q.link} type="button" onClick={() => { setLink(q.link); edited(); }}
                className={`px-2 py-1 rounded-md border text-[11px] font-bold uppercase tracking-wider transition-colors ${
                  link === q.link ? 'border-primary text-white bg-primary/20' : 'border-white/15 text-muted-foreground hover:text-white'}`}>
                {q.label}
              </button>
            ))}
            {link && (
              <button type="button" onClick={() => { setLink(''); edited(); }} className="px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white">
                No link
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            A path inside TiltTrack only, starting with {(limitsQ.data?.linkRoots ?? ['', 'users', 'venues', 'machines', 'crew', 'challenges', 'badges', 'stats', 'add', 'welcome', 'notifications']).map(r => `/${r}`).join(', ')}.
            {' '}<code className="text-white/80">{'{username}'}</code> becomes each recipient’s username.
          </p>
          {linkLooksWrong && <p className="text-xs text-amber-400 mt-1">That doesn’t look like an in-app path — it will be refused.</p>}
          {errs.link && <p className="text-xs text-red-400 mt-1">{errs.link}</p>}
        </div>
        <div>
          <p className={label}>Send to</p>
          <Segmented<AnnouncementAudience> value={audience} onChange={v => { setAudience(v); edited(); }}
            options={[{ value: 'all', label: 'All active users' }, { value: 'users', label: 'Pick users' }]} />
          {audience === 'users' && (
            <div className="mt-3">
              <UserPicker picked={picked} max={lim.maxPicked}
                onAdd={u => { setPicked(p => [...p, u]); edited(); }}
                onRemove={id => { setPicked(p => p.filter(u => u.id !== id)); edited(); }} />
            </div>
          )}
          {errs.audience && <p className="text-xs text-red-400 mt-1">{errs.audience}</p>}
        </div>
        <div>
          <p className={label}>Preview</p>
          <NotificationRow preview n={livePreview} />
        </div>
        {error && !Object.keys(errs).length ? <ErrorNote error={error} /> : null}
        {sent && <p className="text-sm text-emerald-400">{sent}</p>}
        <div>
          <button type="button" onClick={openReview} disabled={!canReview}
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-white rounded-lg px-4 py-2.5 text-sm font-bold uppercase tracking-wider disabled:opacity-50">
            <Send className="w-4 h-4" /> {reviewing ? 'Checking…' : 'Review & send'}
          </button>
        </div>
      </Card>

      <SectionTitle>Sent</SectionTitle>
      <ErrorNote error={history.error} />
      {history.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : historyItems.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-white/5">{historyItems.map(a => <HistoryRow key={a.id} a={a} />)}</ul>
        </Card>
      )}
      <LoadMore hasMore={!!history.hasNextPage} loading={history.isFetchingNextPage} onClick={() => history.fetchNextPage()} />

      {review && (
        <ConfirmDialog
          title={`Send to ${review.recipientCount} ${review.recipientCount === 1 ? 'user' : 'users'}?`}
          confirmLabel={review.duplicateOf ? 'Send again anyway' : 'Send'}
          danger={false}
          body={<ReviewBody p={review} sendsPerHour={lim.sendsPerHour} />}
          onConfirm={() => send(review)}
          onClose={() => setReview(null)}
        />
      )}
    </AdminShell>
  );
}
