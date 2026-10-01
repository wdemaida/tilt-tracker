import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from './api';
import { mergeWelcomeContent, type WelcomeContent } from './welcomeContent';

export const WELCOME_CONTENT_QUERY_KEY = ['content', 'welcome'] as const;

/**
 * The /welcome page's copy: the built-in defaults right away, with any admin edits laid over them
 * once GET /api/content/welcome answers. A failed or slow fetch just leaves the defaults showing.
 */
export function useWelcomeContent(): WelcomeContent {
  const { data } = useQuery({
    queryKey: WELCOME_CONTENT_QUERY_KEY,
    queryFn: () => request<Record<string, unknown>>('/content/welcome'),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return useMemo(() => mergeWelcomeContent(data ?? {}), [data]);
}
