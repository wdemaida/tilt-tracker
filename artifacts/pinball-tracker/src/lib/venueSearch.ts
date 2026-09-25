import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useApi } from './useApi';
import type { VenueSearchResult } from './api';

/**
 * Words for matching — the client twin of `searchTokens` in the api-server's venueSearch.ts (keep
 * the two in step): diacritics folded, lowercased, apostrophes removed so "Pop's" is the word
 * "pops", every other non-alphanumeric run a break.
 */
export function searchTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a venue matches what was typed: every typed word starts a word of the name (or the
 * address), so "pop" and "deep cuts" both find "Pop's Pinball - Deep Cuts". Used to filter the
 * lists the page already holds (nearby suggestions, your venues); the server does the rest.
 */
export function venueMatches(query: string, name: string, address?: string | null): boolean {
  const q = searchTokens(query);
  if (q.length === 0) return true;
  const words = [...searchTokens(name), ...(address ? searchTokens(address) : [])];
  return q.every(t => words.some(w => w.startsWith(t)));
}

export const MIN_SEARCH_CHARS = 2;
export const MIN_PLACE_SEARCH_CHARS = 3;

/**
 * `GET /api/venues/search`, debounced (350ms — the route is rate-limited and the Places half costs
 * a HERE request). `at` is the best location the page has (photo GPS, else the device's position);
 * it only biases and yields distances. Returns null until a search for the current text has landed.
 */
export function useVenueSearch(query: string, at: { lat: number; lng: number } | null) {
  const api = useApi();
  const { isSignedIn } = useAuth();
  const trimmed = query.trim();
  const [debounced, setDebounced] = useState(trimmed);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(trimmed), 350);
    return () => clearTimeout(t);
  }, [trimmed]);

  const length = searchTokens(debounced).join('').length;
  const atKey = at ? `${at.lat.toFixed(3)},${at.lng.toFixed(3)}` : '';
  const enabled = !!isSignedIn && length >= MIN_SEARCH_CHARS;
  const { data, isFetching, isError } = useQuery<VenueSearchResult>({
    queryKey: ['venues', 'search', debounced.toLowerCase(), atKey],
    queryFn: () => api.venues.search(debounced, at ?? undefined),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const current = debounced === trimmed;
  const active = searchTokens(trimmed).join('').length >= MIN_SEARCH_CHARS;
  return {
    /** Whether the text is long enough to search at all. */
    active,
    result: current && data ? data : null,
    /** Typing, or waiting on the server. */
    pending: active && (!current || isFetching),
    failed: current && isError,
  };
}
