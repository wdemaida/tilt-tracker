import { useLocation, useSearch } from 'wouter';
import { Swords, UserCheck, Users, type LucideIcon } from 'lucide-react';
import FriendsPage from './FriendsPage';
import PodsPage from './PodsPage';
import ChallengesPage from './ChallengesPage';
import { useMyFriends } from '../lib/myFriends';
import { useIncomingChallengeCount } from '../lib/challenges';

// Crew — your people: Friends, Pods and Challenges under one roof. Each tab is the
// existing page component; this page only owns the heading and the tab strip. The tab lives in the
// URL (`/crew?tab=pods`) so notifications and scope-picker links can land on the right one — the
// old `/friends` and `/pods` routes redirect here.

interface CrewTab {
  key: string;
  label: string;
  Icon: LucideIcon;
  Component: React.ComponentType;
}

/** Add a tab by adding an entry — e.g. `{ key: 'challenges', label: 'Challenges', Icon: Swords, Component: ChallengesPage }`. */
export const CREW_TABS: CrewTab[] = [
  { key: 'friends', label: 'Friends', Icon: UserCheck, Component: FriendsPage },
  { key: 'pods', label: 'Pods', Icon: Users, Component: PodsPage },
  { key: 'challenges', label: 'Challenges', Icon: Swords, Component: ChallengesPage },
];

export function crewHref(tab: string) {
  return tab === CREW_TABS[0].key ? '/crew' : `/crew?tab=${tab}`;
}

export default function CrewPage() {
  const [, navigate] = useLocation();
  const requested = new URLSearchParams(useSearch()).get('tab');
  const active = CREW_TABS.find(t => t.key === requested) ?? CREW_TABS[0];
  // Incoming friend requests, from the same query the Friends tab itself renders — no extra fetch.
  const { incoming } = useMyFriends();
  // Challenges waiting on your answer — the same pending list the Challenges tab renders.
  const incomingChallenges = useIncomingChallengeCount();
  const badges: Record<string, number> = { friends: incoming.length, challenges: incomingChallenges };

  const { Component } = active;

  return (
    <div className="max-w-3xl">
      <h1 className="text-4xl font-black uppercase tracking-widest text-white mb-4">Crew</h1>

      <div role="tablist" aria-label="Crew" className="flex gap-1 border-b border-white/10 mb-6">
        {CREW_TABS.map(({ key, label, Icon }) => {
          const selected = key === active.key;
          const badge = badges[key] ?? 0;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`crew-tab-${key}`}
              aria-selected={selected}
              aria-controls="crew-tabpanel"
              onClick={() => navigate(crewHref(key), { replace: true })}
              className={`relative -mb-px flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2.5 border-b-2 text-xs sm:text-sm font-bold uppercase tracking-wider whitespace-nowrap transition-colors ${
                selected ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4" aria-hidden />
              {label}
              {badge > 0 && (
                <span
                  className="min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-friend text-zinc-950 text-[10px] font-black leading-[1.1rem] text-center"
                  aria-label={`${badge} waiting on you`}
                >
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="crew-tabpanel" aria-labelledby={`crew-tab-${active.key}`}>
        <Component />
      </div>
    </div>
  );
}
