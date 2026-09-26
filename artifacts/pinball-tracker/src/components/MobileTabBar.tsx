import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '@clerk/clerk-react';
import { Plus } from 'lucide-react';
import { SCORES, MACHINES, VENUES, STATS, CREW, isActivePath, badgeText, useCrewBadgeCount, type NavItem } from './nav';

// Phone navigation (below `md`): Scores · Machines · [+ Add] · Venues · Crew. Guests get Stats in
// the Crew slot, since Crew is signed-in only; signed-in users reach Stats from the avatar menu.
// Layout reserves the bar's height (plus the iPhone home-indicator inset) as bottom padding on
// <main>, so page-bottom buttons are never covered. z-40 sits under the sticky header and every
// modal (z-50), so dialogs cover the bar rather than the other way round.

/** Routes where the bar stays out of the way: the auth forms, whose submit buttons ride the keyboard. */
export function hidesTabBar(location: string) {
  return location.startsWith('/sign-in') || location.startsWith('/sign-up') || location === '/setup' || location === '/welcome';
}

/**
 * True while a text field has focus. A fixed bottom bar either floats above the on-screen keyboard
 * (Android resizes the viewport) or lands on top of the field being typed into (iOS) — both eat the
 * little room left, so the bar steps aside until the keyboard goes away.
 */
function useTextFieldFocused() {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes((el as HTMLInputElement).type)));
    const onIn = (e: FocusEvent) => setFocused(isField(e.target));
    const onOut = (e: FocusEvent) => { if (!isField(e.relatedTarget)) setFocused(false); };
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
    };
  }, []);
  return focused;
}

function Tab({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  const { href, label, Icon } = item;
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      aria-label={badge ? `${label}, ${badge} pending friend ${badge === 1 ? 'request' : 'requests'}` : undefined}
      className={`relative flex flex-1 flex-col items-center justify-center gap-1 min-w-0 h-full text-[10px] font-bold uppercase tracking-wider transition-colors ${
        active ? 'text-primary' : 'text-muted-foreground active:text-white'
      }`}
    >
      {/* PinballIcon is an <img> forced white by a filter — text color can't dim it, opacity can. */}
      <Icon className={`w-5 h-5 ${active ? '' : 'opacity-60'}`} aria-hidden />
      <span className="truncate max-w-full">{label}</span>
      {active && <span className="absolute top-0 inset-x-3 h-0.5 rounded-b bg-primary" aria-hidden />}
      {!!badge && (
        <span className="absolute top-1.5 left-1/2 ml-1.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-friend text-zinc-950 text-[10px] font-black leading-[1.1rem] text-center normal-case tracking-normal" aria-hidden>
          {badgeText(badge)}
        </span>
      )}
    </Link>
  );
}

export default function MobileTabBar() {
  const [location] = useLocation();
  const { isSignedIn } = useAuth();
  const crewBadge = useCrewBadgeCount();
  const typing = useTextFieldFocused();

  if (hidesTabBar(location) || typing) return null;

  const fifth = isSignedIn ? CREW : STATS;
  const addActive = location === '/add';

  return (
    <nav
      aria-label="Main"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-background/90 backdrop-blur-xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch h-16 max-w-lg mx-auto px-1">
        <Tab item={SCORES} active={isActivePath(location, SCORES.href)} />
        <Tab item={MACHINES} active={isActivePath(location, MACHINES.href)} />
        <Link
          href="/add"
          aria-label="Add score"
          aria-current={addActive ? 'page' : undefined}
          className="group flex flex-1 flex-col items-center justify-end gap-1 pb-2 min-w-0 text-[10px] font-bold uppercase tracking-wider text-white"
        >
          <span className="flex items-center justify-center w-12 h-12 -mt-5 rounded-full bg-primary shadow-lg shadow-primary/30 ring-4 ring-background transition-transform group-active:scale-95">
            <Plus className="w-7 h-7" strokeWidth={2.75} aria-hidden />
          </span>
          <span className={addActive ? 'text-primary' : ''}>Add</span>
        </Link>
        <Tab item={VENUES} active={isActivePath(location, VENUES.href)} />
        <Tab item={fifth} active={isActivePath(location, fifth.href)} badge={fifth === CREW ? crewBadge : undefined} />
      </div>
    </nav>
  );
}
