import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';
import { queryClient } from './queryClient';
import { useTheme, hslToHex } from './theme';
import { podColorTokens, podColorVars } from './podColor';
import type { FriendsList } from './api';

/** The friends list query key — FriendsPage, the scope picker and the profile button share it. */
export const MY_FRIENDS_KEY = ['friends'];
/** Prefix for the per-profile relationship query (`['friend-with', username]`). */
export const FRIEND_WITH_KEY = ['friend-with'];
export const UNREAD_COUNT_KEY = ['notifications', 'unread-count'];
export const NOTIFICATIONS_KEY = ['notifications', 'list'];

const EMPTY: FriendsList = { friends: [], incoming: [], outgoing: [] };

/**
 * The signed-in viewer's friends and pending requests. Empty and never fetched when signed out —
 * `/api/friends` only ever answers about the caller's own relationships.
 */
export function useMyFriends() {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const enabled = isLoaded && !!isSignedIn;
  const query = useQuery({ queryKey: MY_FRIENDS_KEY, queryFn: api.friends.list, enabled, staleTime: 60_000 });
  const data = useMemo<FriendsList>(() => (enabled ? query.data ?? EMPTY : EMPTY), [enabled, query.data]);
  return { ...data, signedIn: enabled, isLoading: enabled && query.isLoading };
}

/** After any friend action: the list, search results, profile buttons, the bell and the inbox may have changed. */
export function invalidateFriendQueries() {
  queryClient.invalidateQueries({ queryKey: MY_FRIENDS_KEY });
  queryClient.invalidateQueries({ queryKey: FRIEND_WITH_KEY });
  queryClient.invalidateQueries({ queryKey: ['friend-search'] });
  queryClient.invalidateQueries({ queryKey: ['notifications'] });
}

/**
 * The global `friend` theme color (Admin > Config can change it per browser) as the same token set
 * pods use: `graphic` for chart strokes/dots, `text` for labels, and a scoped `style` that makes
 * `bg-pod` / `text-pod-text` resolve to it — so any "circle" UI written for pods renders friends too.
 */
export function useFriendColor() {
  const { colors } = useTheme();
  return useMemo(() => {
    const hex = hslToHex(colors.friend);
    return { hex, tokens: podColorTokens(hex), style: podColorVars(hex) };
  }, [colors.friend]);
}
