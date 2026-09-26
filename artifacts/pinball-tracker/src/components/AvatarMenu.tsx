import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link } from 'wouter';
import { useClerk, useUser } from '@clerk/clerk-react';
import { LogOut, Settings, ShieldCheck, UserRound } from 'lucide-react';
import { useAppUser } from '../lib/useAppUser';
import { CREW, STATS, badgeText, useCrewBadgeCount, type NavIcon } from './nav';

// The avatar opens the personal menu: your profile, Crew, Admin, and account/sign-out. Replaces
// Clerk's <UserButton>; "Manage account" opens the same Clerk profile modal it used to.

const itemClass =
  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold text-white/85 cursor-pointer outline-none hover:bg-white/10 focus:bg-white/10 hover:text-white focus:text-white';

function MenuLink({ href, label, Icon, badge, className = '' }: { href: string; label: string; Icon: NavIcon; badge?: number; className?: string }) {
  return (
    <DropdownMenu.Item asChild>
      <Link href={href} className={`${itemClass} ${className}`}>
        <Icon className="w-4 h-4 text-muted-foreground" aria-hidden />
        <span className="flex-1">{label}</span>
        {!!badge && (
          <span className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-friend text-zinc-950 text-[10px] font-black leading-[1.1rem] text-center">
            {badgeText(badge)}
          </span>
        )}
      </Link>
    </DropdownMenu.Item>
  );
}

export default function AvatarMenu() {
  const { user } = useUser();
  const { signOut, openUserProfile } = useClerk();
  const appUser = useAppUser();
  const crewBadge = useCrewBadgeCount();
  const isAdmin = appUser?.role === 'admin';
  const name = appUser?.displayName ?? user?.fullName ?? user?.username ?? 'Account';

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={crewBadge ? `Account menu, ${crewBadge} pending friend ${crewBadge === 1 ? 'request' : 'requests'}` : 'Account menu'}
        className="relative flex items-center justify-center w-10 h-10 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {user?.imageUrl ? (
          <img src={user.imageUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-white/15" />
        ) : (
          <span className="w-8 h-8 rounded-full bg-white/10 border border-white/15 flex items-center justify-center">
            <UserRound className="w-4 h-4 text-white" aria-hidden />
          </span>
        )}
        {crewBadge > 0 && (
          <span className="absolute top-0.5 right-0.5 w-2.5 h-2.5 rounded-full bg-friend ring-2 ring-background" aria-hidden />
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 min-w-[220px] rounded-xl border border-white/15 bg-zinc-900 p-1 shadow-xl"
        >
          <DropdownMenu.Label className="px-3 pt-2 pb-1.5">
            <span className="block text-sm font-bold text-white truncate">{name}</span>
            {appUser?.username && <span className="block text-xs text-username truncate">@{appUser.username}</span>}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 border-t border-white/10" />
          {appUser?.username && <MenuLink href={`/users/${appUser.username}`} label="Your profile" Icon={UserRound} />}
          <MenuLink {...CREW} badge={crewBadge} />
          {/* Stats has a slot in the desktop bar; on mobile the tab bar gives that slot to Crew. */}
          <MenuLink {...STATS} className="md:hidden" />
          {isAdmin && <MenuLink href="/admin" label="Admin" Icon={ShieldCheck} />}
          <DropdownMenu.Separator className="my-1 border-t border-white/10" />
          <DropdownMenu.Item className={itemClass} onSelect={() => openUserProfile()}>
            <Settings className="w-4 h-4 text-muted-foreground" aria-hidden />
            Manage account
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemClass} onSelect={() => signOut({ redirectUrl: '/' })}>
            <LogOut className="w-4 h-4 text-muted-foreground" aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
