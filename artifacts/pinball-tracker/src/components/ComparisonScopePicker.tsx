import { Link } from 'wouter';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Plus, Users, UserCheck } from 'lucide-react';
import PodChip from './PodChip';
import { podColorVars } from '../lib/podColor';
import type { ComparisonScopeState } from '../lib/comparisonScope';

/**
 * All | Mine | Friends | <pod ▾>, plus an "All others" switch while a pod or Friends is selected.
 *
 * Presentational only — hand it the state from `useComparisonScope()`, so the page that owns the
 * query and the picker read the same scope. Renders nothing when signed out (there is no "mine"
 * and no pods). With no pods, the last segment is a link to /pods instead of a menu. Friends only
 * appears once the viewer has at least one friend (or when a Friends link was opened) — an empty
 * "you + nobody" view isn't worth a permanent button; /friends is where you get some.
 *
 * Reusable as-is on any page whose endpoint accepts `scopeQuery(scope)`.
 */
export default function ComparisonScopePicker({ state, className = '' }: {
  state: ComparisonScopeState;
  className?: string;
}) {
  const { scope, setScope, pod, pods, friendCount, signedIn } = state;
  if (!signedIn) return null;
  const showFriends = friendCount > 0 || scope.kind === 'friends';
  // Both "circle" scopes share the All-others switch; it survives switching between them.
  const others = (scope.kind === 'pod' || scope.kind === 'friends') && scope.others;

  const segment = (active: boolean) =>
    `px-3 py-1.5 rounded-md transition-colors ${active ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'}`;

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div
        role="group"
        aria-label="Compare with"
        className="flex items-center bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs font-bold uppercase tracking-wider"
      >
        <button type="button" aria-pressed={scope.kind === 'all'} onClick={() => setScope({ kind: 'all' })} className={segment(scope.kind === 'all')}>
          All
        </button>
        <button type="button" aria-pressed={scope.kind === 'mine'} onClick={() => setScope({ kind: 'mine' })} className={segment(scope.kind === 'mine')}>
          Mine
        </button>
        {showFriends && (
          <button
            type="button"
            aria-pressed={scope.kind === 'friends'}
            onClick={() => setScope({ kind: 'friends', others })}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors ${
              scope.kind === 'friends' ? 'bg-friend text-zinc-950' : 'text-muted-foreground hover:text-white'
            }`}
          >
            <UserCheck className="w-3 h-3" aria-hidden /> Friends
          </button>
        )}

        {pods.length === 0 ? (
          <Link href="/pods" className="flex items-center gap-1 px-3 py-1.5 rounded-md text-muted-foreground hover:text-white transition-colors normal-case tracking-normal font-semibold">
            <Plus className="w-3 h-3" /> Create a pod
          </Link>
        ) : (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              aria-label={pod ? `Pod: ${pod.name}. Change pod` : 'Compare with a pod'}
              style={pod ? podColorVars(pod.color) : undefined}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors outline-none max-w-[12rem] ${
                pod ? 'bg-pod text-pod-on' : 'text-muted-foreground hover:text-white'
              }`}
            >
              <Users className="w-3 h-3 flex-shrink-0" />
              <span className="truncate normal-case tracking-normal">{pod ? pod.name : 'Pod'}</span>
              <ChevronDown className="w-3 h-3 flex-shrink-0" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="z-50 min-w-[200px] max-h-[60vh] overflow-y-auto rounded-xl border border-white/15 bg-zinc-900 p-1 shadow-xl"
                sideOffset={6}
                align="end"
              >
                <DropdownMenu.Label className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Compare with one pod
                </DropdownMenu.Label>
                {pods.map(p => (
                  <DropdownMenu.Item
                    key={p.id}
                    onSelect={() => setScope({ kind: 'pod', podId: p.id, others })}
                    className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-lg text-xs cursor-pointer outline-none hover:bg-white/10 focus:bg-white/10"
                  >
                    <PodChip color={p.color} solid={pod?.id === p.id} className="max-w-[10rem]">
                      <span className="truncate">{p.name}</span>
                    </PodChip>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      {p.memberCount}
                      {pod?.id === p.id ? <Check className="w-3.5 h-3.5 text-white" /> : <span className="w-3.5" />}
                    </span>
                  </DropdownMenu.Item>
                ))}
                <DropdownMenu.Separator className="my-1 border-t border-white/10" />
                <DropdownMenu.Item asChild>
                  <Link href="/pods" className="block px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-white hover:bg-white/10 outline-none focus:bg-white/10">
                    Manage pods…
                  </Link>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>

      {(scope.kind === 'pod' || scope.kind === 'friends') && (
        <button
          type="button"
          role="switch"
          aria-checked={scope.others}
          onClick={() => setScope({ ...scope, others: !scope.others })}
          title={scope.kind === 'pod' ? "Also show every player who isn't in this pod" : "Also show every player who isn't your friend"}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold uppercase tracking-wider transition-colors ${
            scope.others ? 'border-field text-field bg-field/10' : 'border-white/20 text-muted-foreground hover:text-white hover:border-white/40'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${scope.others ? 'bg-field' : 'border border-current'}`} />
          All others
        </button>
      )}
    </div>
  );
}
