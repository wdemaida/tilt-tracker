import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'wouter';
import { useScopeContext } from './ScopeContext';
import { useMyPods, type PodRef } from './myPods';
import { useMyFriends } from './myFriends';
import type { Pod } from './api';

/**
 * Comparison scope — whose scores a page compares the viewer against (feature/pods, step 3).
 *
 *   all  — everyone (the app's long-standing default)
 *   mine — only the viewer
 *   pod  — the viewer + one of their pods; `others` adds everyone else back in
 *   friends — the viewer + their accepted friends; `others` likewise (feature/friends)
 *
 * Source of truth, in order:
 *  1. the URL — `?scope=mine|all|friends` (friends takes `&others=1`), or `?pod=<id>[&others=1]` —
 *     so a view is bookmarkable;
 *  2. otherwise the app-wide ScopeContext Mine/All toggle (the list pages' ScopeToggle), so arriving
 *     from a list page in "Mine" lands in Mine here too.
 * Picking Mine/All here writes both the URL and ScopeContext, keeping the two toggles in step.
 * Picking a pod or Friends writes only the URL — ScopeContext is a boolean and neither can be
 * expressed in it, so the list pages simply keep whatever Mine/All they had.
 *
 * The server resolves membership from the pod id alone (the client never sends member ids) and
 * 404s pods the viewer doesn't own; see artifacts/api-server/src/lib/comparisonScope.ts. Friends
 * likewise: the client sends only `friends=1`, and the server works out who they are.
 */
export type ComparisonScope =
  | { kind: 'all' }
  | { kind: 'mine' }
  | { kind: 'pod'; podId: number; others: boolean }
  | { kind: 'friends'; others: boolean };

export const ALL_SCOPE: ComparisonScope = { kind: 'all' };

/** Query string for an API call under this scope ('' for all). Pass to the endpoint as-is. */
export function scopeQuery(scope: ComparisonScope): string {
  if (scope.kind === 'mine') return '?mine=true';
  if (scope.kind === 'pod') return `?pod=${scope.podId}${scope.others ? '&others=1' : ''}`;
  if (scope.kind === 'friends') return `?friends=1${scope.others ? '&others=1' : ''}`;
  return '';
}

/** Stable string for TanStack Query keys. */
export function scopeKey(scope: ComparisonScope): string {
  if (scope.kind === 'pod') return `pod:${scope.podId}${scope.others ? ':others' : ''}`;
  if (scope.kind === 'friends') return `friends${scope.others ? ':others' : ''}`;
  return scope.kind;
}

function parseUrlScope(params: URLSearchParams): ComparisonScope | null {
  const pod = params.get('pod');
  if (pod !== null) {
    const id = Number(pod);
    if (Number.isInteger(id) && id > 0) return { kind: 'pod', podId: id, others: params.get('others') === '1' };
    return null;
  }
  const s = params.get('scope');
  if (s === 'mine') return { kind: 'mine' };
  if (s === 'all') return { kind: 'all' };
  if (s === 'friends') return { kind: 'friends', others: params.get('others') === '1' };
  return null;
}

export interface ComparisonScopeState {
  /** The scope to query with. Falls back to All when signed out or when the URL's pod isn't one of the viewer's. */
  scope: ComparisonScope;
  setScope: (next: ComparisonScope) => void;
  /** The selected pod (only when `scope.kind === 'pod'`). */
  pod: PodRef | null;
  /** The viewer's own pods, for the picker. */
  pods: Pod[];
  /** How many accepted friends the viewer has — the picker only offers Friends when there are some. */
  friendCount: number;
  signedIn: boolean;
  /**
   * False while a URL-requested scope can't be resolved yet (Clerk loading, or the pod list still
   * in flight). Gate the page's query on it so a bookmarked pod view doesn't flash All first.
   */
  ready: boolean;
  /** The URL named a pod the viewer doesn't have (deleted, or someone else's link). Showing All instead. */
  unknownPod: boolean;
}

export function useComparisonScope(): ComparisonScopeState {
  const [params, setParams] = useSearchParams();
  const { mine, setMine } = useScopeContext();
  const { pods, signedIn, settled } = useMyPods();
  const { friends } = useMyFriends();

  const fromUrl = useMemo(() => parseUrlScope(params), [params]);

  let scope: ComparisonScope;
  let pod: PodRef | null = null;
  let unknownPod = false;
  if (!signedIn) {
    scope = ALL_SCOPE;
  } else if (fromUrl?.kind === 'pod') {
    const found = pods.find(p => p.id === fromUrl.podId);
    if (found) {
      scope = fromUrl;
      pod = { id: found.id, name: found.name, color: found.color };
    } else {
      scope = ALL_SCOPE;
      unknownPod = settled;
    }
  } else {
    scope = fromUrl ?? (mine ? { kind: 'mine' } : ALL_SCOPE);
  }

  // Only a URL scope can be unresolvable; the no-param default needs nothing to load.
  const ready = fromUrl === null || settled;

  const setScope = useCallback((next: ComparisonScope) => {
    setParams(prev => {
      const p = new URLSearchParams(prev);
      p.delete('scope'); p.delete('pod'); p.delete('others');
      if (next.kind === 'pod') {
        p.set('pod', String(next.podId));
        if (next.others) p.set('others', '1');
      } else if (next.kind === 'friends') {
        p.set('scope', 'friends');
        if (next.others) p.set('others', '1');
      } else {
        p.set('scope', next.kind);
      }
      return p;
    }, { replace: true });
    if (next.kind === 'all' || next.kind === 'mine') setMine(next.kind === 'mine');
  }, [setParams, setMine]);

  return { scope, setScope, pod, pods, friendCount: friends.length, signedIn, ready, unknownPod };
}
