const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

async function request<T>(path: string, init?: RequestInit, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (init?.headers) Object.assign(headers, init.headers);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status, code: err.code });
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function createApi(getToken: () => Promise<string | null>) {
  const tok = () => getToken();

  return {
    scores: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/scores?mine=true' : '/scores', undefined, mine ? await tok() : undefined),
      create: async (body: Record<string, unknown>) =>
        request<any>('/scores', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      patch: async (id: number, body: { score?: number; type?: string; playedAt?: string }) =>
        request(`/scores/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/scores/${id}`, { method: 'DELETE' }, await tok()),
    },
    machines: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/machines?mine=true' : '/machines', undefined, mine ? await tok() : undefined),
      get: (name: string) => request<any>(`/machines/${encodeURIComponent(name)}`),
      search: (q: string) => request<any[]>(`/machines/search?q=${encodeURIComponent(q)}`),
      upsert: async (body: Record<string, unknown>) =>
        request<any>('/machines', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      patch: async (id: number, body: { name?: string; manufacturer?: string; year?: number | null }) =>
        request(`/machines/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/machines/${id}`, { method: 'DELETE' }, await tok()),
    },
    users: {
      me: async () => request<any | null>('/users/me', undefined, await tok()),
      setup: async (body: { username: string; displayName: string }) =>
        request('/users/setup', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      get: (username: string) => request<any>(`/users/${username}`),
    },
    stats: {
      get: async (mine = true) => request<any>(`/stats?mine=${mine}`, undefined, await tok()),
    },
    venues: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/venues?mine=true' : '/venues', undefined, mine ? await tok() : undefined),
      machines: (id: number) => request<any>(`/venues/${id}/machines`),
      patch: async (id: number, body: { name?: string; address?: string | null }) =>
        request(`/venues/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/venues/${id}`, { method: 'DELETE' }, await tok()),
    },
    pinballmap: {
      getToken: async () =>
        request<{ hasToken: boolean; pmUsername: string | null }>('/pinballmap/token', undefined, await tok()),
      auth: async (email: string, password: string) =>
        request<{ token: string; username: string }>(
          '/pinballmap/auth',
          { method: 'POST', body: JSON.stringify({ email, password }) },
          await tok()
        ),
      submitScore: async (body: { venueId: number; machineName: string; score: number; userToken?: string }) =>
        request('/pinballmap/submit-score', { method: 'POST', body: JSON.stringify(body) }, await tok()),
    },
    admin: {
      users: async () => request<any[]>('/admin/users', undefined, await tok()),
      health: async () => request<any>('/admin/health', undefined, await tok()),
      updateUser: async (id: number, data: { role?: string; displayName?: string; username?: string }) =>
        request<any>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }, await tok()),
    },
    upload: async (file: File) => {
      const token = await tok();
      const form = new FormData();
      form.append('photo', file);
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form, headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw Object.assign(new Error(err.error ?? 'Upload failed'), { status: res.status });
      }
      return res.json();
    },
  };
}

// Unauthenticated singleton for public-only queries (no token needed)
export const api = createApi(async () => null);
