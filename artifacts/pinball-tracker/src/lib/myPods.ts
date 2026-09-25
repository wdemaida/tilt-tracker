import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';
import type { Pod } from './api';

/** Same key PodsPage uses, so its edits invalidate every picker and membership icon too. */
export const MY_PODS_KEY = ['pods'];

/** A pod as the comparison UI needs it — never more than the owner already has from /api/pods. */
export interface PodRef { id: number; name: string; color: string }

/**
 * The signed-in viewer's own pods (members included). Empty and never fetched when signed out —
 * `/api/pods` only ever returns the caller's pods, so nobody else's pods can reach the client.
 */
export function useMyPods() {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const enabled = isLoaded && !!isSignedIn;
  const query = useQuery({ queryKey: MY_PODS_KEY, queryFn: api.pods.list, enabled, staleTime: 60_000 });
  const pods = useMemo<Pod[]>(() => (enabled ? query.data ?? [] : []), [enabled, query.data]);
  return {
    pods,
    signedIn: enabled,
    /** Clerk resolved and, when signed in, the pod list has arrived (or failed). */
    settled: isLoaded && (!isSignedIn || query.isFetched),
  };
}

/**
 * username → the viewer's pods that user is in, for PodMemberIcons. Keyed by username because
 * score listings carry usernames, not user ids (usernames are unique). The viewer never appears —
 * the server refuses adding yourself to your own pod.
 */
export function usePodMembership(): Map<string, PodRef[]> {
  const { pods } = useMyPods();
  return useMemo(() => {
    const map = new Map<string, PodRef[]>();
    for (const p of pods) {
      for (const m of p.members) {
        const list = map.get(m.username) ?? [];
        list.push({ id: p.id, name: p.name, color: p.color });
        map.set(m.username, list);
      }
    }
    return map;
  }, [pods]);
}
