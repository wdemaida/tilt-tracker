import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';

export function useAppUser() {
  const { isSignedIn, isLoaded } = useAuth();
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: api.users.me,
    enabled: isLoaded && !!isSignedIn,
    retry: false,
  });
  return data ?? null;
}
