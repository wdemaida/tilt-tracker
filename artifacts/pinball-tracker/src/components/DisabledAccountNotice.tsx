import { useClerk } from '@clerk/clerk-react';
import { UserX } from 'lucide-react';

/**
 * Shown instead of the page when an admin has disabled the signed-in account (users.disabled_at —
 * /api/users/me still answers for a disabled account precisely so this can be said plainly; every
 * other signed-in request gets 403 account_disabled). The Clerk ban usually signs them out within a
 * minute anyway; this covers the gap and any tab left open.
 */
export default function DisabledAccountNotice({ reason }: { reason?: string | null }) {
  const { signOut } = useClerk();
  return (
    <div className="max-w-md mx-auto mt-10 rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
      <UserX className="w-10 h-10 text-red-400 mx-auto" aria-hidden />
      <h1 className="text-xl font-black uppercase tracking-widest text-white mt-3">Account disabled</h1>
      <p className="text-sm text-white/80 mt-3">
        This TiltTrack account has been disabled by an admin, so you can’t use the app while signed in to it.
      </p>
      {reason && <p className="text-sm text-muted-foreground mt-2">Reason: “{reason}”</p>}
      <p className="text-sm text-muted-foreground mt-2">If you think this is a mistake, contact the TiltTrack admin.</p>
      <button
        type="button"
        onClick={() => signOut({ redirectUrl: '/welcome' })}
        className="mt-5 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm font-bold uppercase tracking-wider text-white"
      >
        Sign out
      </button>
    </div>
  );
}
