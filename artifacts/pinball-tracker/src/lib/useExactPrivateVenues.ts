import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useApi } from './useApi';

export interface ExactPrivateVenue { id: number; name: string; isPrivate: true }

/**
 * Private venues (someone's home) whose name exactly matches what the user typed. This is the only
 * way a private venue that isn't yours turns up in a venue search — nearby suggestions never include
 * it, because a location-based reveal would be a way to scan for where people live. The server
 * answers with names only.
 *
 * Debounced (so typing "Will's Basement" is one lookup, not fifteen — the endpoint is rate-limited)
 * and only while signed in.
 */
export function useExactPrivateVenues(query: string): ExactPrivateVenue[] {
  const api = useApi();
  const { isSignedIn } = useAuth();
  const [debounced, setDebounced] = useState(query.trim());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const { data = [] } = useQuery({
    queryKey: ['venues', 'exact', debounced.toLowerCase()],
    queryFn: () => api.venues.exact(debounced),
    enabled: !!isSignedIn && debounced.length >= 2,
    staleTime: 60_000,
    retry: false,
  });
  // Guard against a stale answer for text the user has since changed.
  return debounced.toLowerCase() === query.trim().toLowerCase() ? data : [];
}

/** Whether a venues-list row is someone else's private venue — kept out of substring search. */
export function isOthersPrivateVenue(
  v: { ownerId?: number | null; isResidence?: boolean; privacyTier?: string },
  me: { id: number; role: string } | null,
): boolean {
  const isPrivate = !!v.isResidence || (v.privacyTier != null && v.privacyTier !== 'full');
  if (!isPrivate) return false;
  if (!me) return true;
  return me.role !== 'admin' && v.ownerId !== me.id;
}
