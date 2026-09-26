import { useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, ImageOff, Lock, Maximize2, Ban } from 'lucide-react';
import { useAdminApi, type AdminScore, type AdminChallenge, type AdminFriendship, type AdminNotification } from '../../lib/adminApi';
import UsernameLink from '../UsernameLink';
import PhotoViewer from '../PhotoViewer';
import { ConfirmDialog, Pill, When, AdminUserLink } from './AdminParts';

// Rows shared by the admin user page and the Social / Scores tabs, each with its own admin actions.
// Every action confirms first and refreshes all admin queries afterwards.

function useRefreshAdmin() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['admin'] });
}

const iconBtn = 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-white/15 text-[11px] font-bold uppercase tracking-wider text-muted-foreground hover:text-white hover:border-white/30 transition-colors';
const dangerBtn = 'inline-flex items-center gap-1 px-2 py-1 rounded-md border border-red-500/30 text-[11px] font-bold uppercase tracking-wider text-red-400 hover:bg-red-500/10 transition-colors';

// ── scores ───────────────────────────────────────────────────────────────────

type ScoreAction = 'score' | 'photo' | 'thumbnail';

export function AdminScoreRow({ s, showUser = true }: { s: AdminScore; showUser?: boolean }) {
  const admin = useAdminApi();
  const refresh = useRefreshAdmin();
  const [confirm, setConfirm] = useState<ScoreAction | null>(null);
  const [viewing, setViewing] = useState(false);
  const locked = s.lockedBy.length > 0;
  const lockNote = locked ? (
    <p className="text-amber-400">
      Locked by challenge{s.lockedBy.length === 1 ? '' : 's'} {s.lockedBy.map((id, i) => <span key={id}>{i ? ', ' : ''}<Link href={`/challenges/${id}`} className="underline">#{id}</Link></span>)}.
    </p>
  ) : null;

  return (
    <li className="flex gap-3 px-3 sm:px-4 py-3">
      <button type="button" onClick={() => s.hasFullPhoto && setViewing(true)} disabled={!s.hasFullPhoto}
        className="w-16 h-16 flex-shrink-0 rounded-lg overflow-hidden bg-white/5 border border-white/10 relative" aria-label={s.hasFullPhoto ? "View full-size photo" : "Thumbnail"}>
        {s.photoThumbnail
          ? <img src={s.photoThumbnail} alt="" className="w-full h-full object-cover" />
          : <ImageOff className="w-5 h-5 text-muted-foreground absolute inset-0 m-auto" aria-hidden />}
        {s.hasFullPhoto && <Maximize2 className="w-3 h-3 text-white absolute bottom-1 right-1 drop-shadow" aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white break-words">
          <span className="font-black text-primary tabular-nums">{s.score.toLocaleString()}</span>{' '}
          on <Link href={`/machines/${encodeURIComponent(s.machine.name)}`} className="text-machine font-semibold hover:underline">{s.machine.name}</Link>
          {s.venueName && <> at {s.venueId ? <Link href={`/venues/${s.venueId}`} className="text-venue hover:underline">{s.venueName}</Link> : <span className="text-venue">{s.venueName}</span>}</>}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 gap-y-1 items-center">
          {showUser && <UsernameLink username={s.user.username} />}
          <span>#{s.id}</span>
          <span>uploaded <When at={s.createdAt} /></span>
          {s.hasFullPhoto && <Pill tone="ok">full photo{s.photoBytes ? ` · ${(s.photoBytes / 1_048_576).toFixed(1)} MB` : ''}</Pill>}
          {locked && <Pill tone="warn"><Lock className="w-3 h-3 inline -mt-0.5" /> challenge</Pill>}
        </p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {s.hasFullPhoto && <button type="button" className={iconBtn} onClick={() => setConfirm('photo')}>Delete full photo</button>}
          {s.photoThumbnail && <button type="button" className={iconBtn} onClick={() => setConfirm('thumbnail')}>Delete thumbnail</button>}
          <button type="button" className={dangerBtn} onClick={() => setConfirm('score')}><Trash2 className="w-3 h-3" /> Delete score</button>
        </div>
      </div>

      {viewing && (
        <PhotoViewer scoreId={s.id} thumbnail={s.photoThumbnail} onClose={() => setViewing(false)}
          caption={{ machineName: s.machine.name, score: s.score, playedAt: s.playedAt, username: s.user.username }} />
      )}
      {confirm === 'score' && (
        <ConfirmDialog
          title="Delete score" confirmLabel="Delete score"
          body={<>
            <p>Permanently delete <b>{s.score.toLocaleString()}</b> on {s.machine.name} by @{s.user.username}{s.hasFullPhoto ? ', including its full-size photo in R2' : ''}. This can’t be undone.</p>
            {locked && <>{lockNote}<p>The server will refuse while a challenge holds it. Void the challenge first (Social → Challenges) — that releases the lock and removes the challenge from both players’ records.</p></>}
          </>}
          onConfirm={async () => { await admin.deleteScore(s.id); await refresh(); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'photo' && (
        <ConfirmDialog
          title="Delete full-size photo" confirmLabel="Delete photo"
          body={<>
            <p>Delete the full-size photo of score #{s.id} from R2. The score and its thumbnail stay.</p>
            {locked && <p className="text-muted-foreground">Allowed on a challenge-locked score: the full-size photo isn’t part of what makes a score count.</p>}
          </>}
          onConfirm={async () => { await admin.deleteFullPhoto(s.id); await refresh(); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'thumbnail' && (
        <ConfirmDialog
          title="Delete thumbnail" confirmLabel="Delete thumbnail"
          body={<>
            <p>Remove the thumbnail from score #{s.id}. The score stays, shown without a picture.</p>
            {locked && <>{lockNote}<p>Refused while locked: the thumbnail is the photo that made it count.</p></>}
          </>}
          onConfirm={async () => { await admin.deleteThumbnail(s.id); await refresh(); }}
          onClose={() => setConfirm(null)}
        />
      )}
    </li>
  );
}

// ── challenges ───────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = { high_score: 'High score', race: 'Race', most_improved: 'Most improved', average: 'Average' };
const STATUS_TONE: Record<string, 'muted' | 'primary' | 'danger' | 'ok' | 'warn'> = {
  active: 'ok', pending: 'warn', resolved: 'primary', cancelled: 'muted', declined: 'muted', expired: 'muted',
};

export function AdminChallengeRow({ c }: { c: AdminChallenge }) {
  const admin = useAdminApi();
  const refresh = useRefreshAdmin();
  const [confirm, setConfirm] = useState(false);
  const closed = ['declined', 'cancelled', 'expired'].includes(c.status);
  return (
    <li className="px-3 sm:px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/challenges/${c.id}`} className="text-sm font-semibold text-white hover:text-primary">#{c.id} {TYPE_LABEL[c.type] ?? c.type}</Link>
        <span className="text-sm text-muted-foreground">on <span className="text-machine">{c.machine.name}</span>{c.venue && <> at <span className="text-venue">{c.venue.name}</span></>}</span>
        <Pill tone={STATUS_TONE[c.status] ?? 'muted'}>{c.status}</Pill>
        {c.adminCancelledAt && <Pill tone="danger">voided by admin</Pill>}
      </div>
      <p className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {c.participants.map(p => (
          <span key={p.user.id}>
            <UsernameLink username={p.user.username} />
            {p.response !== 'accepted' && <> ({p.response})</>}
            {p.outcome && <> — <span className="text-white/80">{p.outcome}</span></>}
          </span>
        ))}
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        created <When at={c.createdAt} /> · ends <When at={c.endsAt} />
        {c.targetScore != null && <> · target {c.targetScore.toLocaleString()}</>}
        {c.adminCancelReason && <> · reason: {c.adminCancelReason}</>}
      </p>
      {!closed && (
        <div className="mt-2">
          <button type="button" className={dangerBtn} onClick={() => setConfirm(true)}><Ban className="w-3 h-3" /> Void</button>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Void challenge #${c.id}`} confirmLabel="Void challenge" reason="Reason (kept in the activity log)"
          body={<>
            <p>The challenge becomes <b>cancelled</b>. Every participant’s result is cleared, so it drops out of W/L/T, streaks and head-to-head; its score locks are released (those scores can then be edited or deleted).</p>
            {c.status === 'resolved' && <p className="text-amber-400">It’s already resolved — voiding changes both players’ records.</p>}
            <p className="text-muted-foreground">Participants get a “voided by an admin” notification. The previous state is kept in the activity log.</p>
          </>}
          onConfirm={async reason => { await admin.voidChallenge(c.id, reason); await refresh(); }}
          onClose={() => setConfirm(false)}
        />
      )}
    </li>
  );
}

// ── friendships ──────────────────────────────────────────────────────────────

export function AdminFriendshipRow({ f }: { f: AdminFriendship }) {
  const admin = useAdminApi();
  const refresh = useRefreshAdmin();
  const [confirm, setConfirm] = useState(false);
  const tone = f.status === 'accepted' ? 'ok' : f.status === 'pending' ? 'warn' : 'muted';
  return (
    <li className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white">
          <AdminUserLink user={f.requester} /> <span className="text-muted-foreground">→</span> <AdminUserLink user={f.addressee} />
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 gap-y-1 items-center">
          <Pill tone={tone}>{f.status}</Pill>
          {f.declineCount > 0 && <span>{f.declineCount} decline{f.declineCount === 1 ? '' : 's'}{f.declineCount >= 3 ? ' (capped)' : ''}</span>}
          <span>requested <When at={f.createdAt} /></span>
          {f.respondedAt && <span>answered <When at={f.respondedAt} /></span>}
        </p>
      </div>
      <button type="button" className={dangerBtn} onClick={() => setConfirm(true)}><Trash2 className="w-3 h-3" /> Remove</button>
      {confirm && (
        <ConfirmDialog
          title="Remove friendship" confirmLabel="Remove"
          body={<>
            <p>Delete the {f.status} row between @{f.requester.username} and @{f.addressee.username}{f.declineCount ? `, including its decline history (${f.declineCount})` : ''}. Neither is notified.</p>
            <p className="text-muted-foreground">Pods and existing challenges aren’t touched; they could send a new request afterwards.</p>
          </>}
          onConfirm={async () => { await admin.removeFriendship(f.id); await refresh(); }}
          onClose={() => setConfirm(false)}
        />
      )}
    </li>
  );
}

// ── notifications ────────────────────────────────────────────────────────────

export function AdminNotificationRow({ n, showUser = true }: { n: AdminNotification; showUser?: boolean }) {
  const admin = useAdminApi();
  const refresh = useRefreshAdmin();
  const [confirm, setConfirm] = useState(false);
  const p = n.payload ?? {};
  const about = [p.username ? `@${p.username}` : null, p.machineName, p.challengeId ? `challenge #${p.challengeId}` : null, p.outcome].filter(Boolean).join(' · ');
  return (
    <li className="px-3 sm:px-4 py-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white break-words">
          {showUser && <><UsernameLink username={n.user.username} />{' '}</>}
          <span className="font-mono text-xs text-white/80">{n.kind}</span>
          {about && <span className="text-muted-foreground"> — {about}</span>}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 items-center">
          <Pill tone={n.readAt ? 'muted' : 'ok'}>{n.readAt ? 'read' : 'unread'}</Pill>
          <When at={n.createdAt} />
        </p>
      </div>
      <button type="button" className={iconBtn} onClick={() => setConfirm(true)} aria-label="Delete notification"><Trash2 className="w-3 h-3" /></button>
      {confirm && (
        <ConfirmDialog
          title="Delete notification" confirmLabel="Delete"
          body={<p>Remove this {n.kind} notification from @{n.user.username}’s inbox. The activity log keeps its record.</p>}
          onConfirm={async () => { await admin.deleteNotification(n.id); await refresh(); }}
          onClose={() => setConfirm(false)}
        />
      )}
    </li>
  );
}
