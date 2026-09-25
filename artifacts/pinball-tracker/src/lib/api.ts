const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

async function request<T>(path: string, init?: RequestInit, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (init?.headers) Object.assign(headers, init.headers);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // `body` carries the whole error payload — some responses attach structured detail the caller
    // needs, e.g. the duplicate-venue 409's `candidates`. `code`/`status` stay for existing callers.
    throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status, code: err.code, body: err });
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** A private venue's owner-managed machine list, as the server returns it. */
export interface VenueInventory {
  /** True once the owner has ever added a machine — from then on the list *is* the machine count. */
  managed: boolean;
  machines: Array<{ id: number; name: string; manufacturer: string | null; year: number | null; addedAt: string }>;
  former: Array<{ id: number; name: string; manufacturer: string | null; year: number | null; addedAt: string; removedAt: string }>;
}

/** A user as the pod member picker / member list shows them — public profile fields only. */
export interface PodUser {
  id: number;
  username: string;
  displayName: string;
}

/** One of the caller's pods, as `/api/pods` returns it. Only ever the caller's own. */
export interface Pod {
  id: number;
  name: string;
  /** `#rrggbb`, lowercase — render through podColorVars / PodChip, never raw. */
  color: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  members: Array<PodUser & { addedAt: string }>;
}

export function createApi(getToken: () => Promise<string | null>) {
  const tok = () => getToken();

  return {
    // Every read sends the viewer's token when there is one (null when signed out), not only the
    // `mine` variants: what a listing contains depends on who's asking — a home venue's owner (and
    // each score's author) sees scores there that others don't. See venueActivity.ts on the server.
    scores: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/scores?mine=true' : '/scores', undefined, await tok()),
      create: async (body: Record<string, unknown>) =>
        request<any>('/scores', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      // `venueId` attaches a venue to a score that was logged without one — see ScoreVenuePicker.
      patch: async (id: number, body: { score?: number; type?: string; playedAt?: string; machineId?: number; venueId?: number | null }) =>
        request(`/scores/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request(`/scores/${id}`, { method: 'DELETE' }, await tok()),

      // Per-score repair — venue linkage state plus ranked machine candidates for this one score.
      repair: {
        status: async (id: number) =>
          request<any>(`/scores/${id}/repair`, undefined, await tok()),
        machine: async (id: number, body: { pmName: string; pmManufacturer?: string | null; pmYear?: number | null }) =>
          request<any>(`/scores/${id}/repair/machine`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
      },
    },
    machines: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/machines?mine=true' : '/machines', undefined, await tok()),
      get: async (name: string) => request<any>(`/machines/${encodeURIComponent(name)}`, undefined, await tok()),
      search: (q: string) => request<any[]>(`/machines/search?q=${encodeURIComponent(q)}`),
      // Count + median of recorded scores — drives the "may be missing digits" check on AddScorePage.
      scoreStats: (name: string) =>
        request<{ machineId: number | null; machineName: string | null; count: number; median: number | null }>(
          `/machines/score-stats?name=${encodeURIComponent(name)}`),
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
      get: async (username: string) => request<any>(`/users/${username}`, undefined, await tok()),
    },
    // Pods — the caller's own private groupings. Signed-in only; every call is scoped to pods the
    // caller owns, and a pod they don't own is a 404. Always use through useApi() — the static `api`
    // export has no token and every pods call would 401.
    pods: {
      list: async () => request<Pod[]>('/pods', undefined, await tok()),
      create: async (body: { name: string; color?: string }) =>
        request<Pod>('/pods', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      update: async (id: number, body: { name?: string; color?: string }) =>
        request<Pod>(`/pods/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      delete: async (id: number) =>
        request<void>(`/pods/${id}`, { method: 'DELETE' }, await tok()),
      addMember: async (id: number, userId: number) =>
        request<Pod>(`/pods/${id}/members`, { method: 'POST', body: JSON.stringify({ userId }) }, await tok()),
      removeMember: async (id: number, userId: number) =>
        request<Pod>(`/pods/${id}/members/${userId}`, { method: 'DELETE' }, await tok()),
      searchUsers: async (q: string) =>
        request<PodUser[]>(`/pods/user-search?q=${encodeURIComponent(q)}`, undefined, await tok()),
    },
    stats: {
      get: async (mine = true) => request<any>(`/stats?mine=${mine}`, undefined, await tok()),
      history: async (key: string, days = 90) =>
        request<{ label: string; description: string | null; points: { periodDate: string; value: number }[] }>(
          `/stats/history/${key}?days=${days}`, undefined, await tok()
        ),
    },
    venues: {
      list: async (mine = false) =>
        request<any[]>(mine ? '/venues?mine=true' : '/venues', undefined, await tok()),
      machines: async (id: number) => request<any>(`/venues/${id}/machines`, undefined, await tok()),
      pmMachines: (pmId: number) => request<any>(`/venues/pm-machines/${pmId}`),
      // Private venues (homes) whose name matches exactly — name only, never a location. How a
      // friend finds someone's home venue to log a score there.
      exact: async (name: string) =>
        request<Array<{ id: number; name: string; isPrivate: true }>>(
          `/venues/exact?name=${encodeURIComponent(name)}`, undefined, await tok(),
        ),
      // Same suggestion list a photo's GPS produces, for the device's current position — the Add
      // Score fallback when no photo had location. Lookup only: the server stores nothing. POSTed
      // (not a query string, which lands in access logs) and rounded to 4 decimals (~11m) first —
      // plenty to find the venue you're standing in, and no more precise than that needs.
      nearby: async (lat: number, lng: number) =>
        request<{ venues: any[] }>('/upload/nearby-venues', {
          method: 'POST',
          body: JSON.stringify({ lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 }),
        }, await tok()),
      addressAutocomplete: (q: string, at?: { lat: number; lng: number }) =>
        request<Array<{ id: string; label: string; lat: number | null; lng: number | null }>>(
          `/venues/address-autocomplete?q=${encodeURIComponent(q)}${at ? `&lat=${at.lat}&lng=${at.lng}` : ''}`
        ),
      scores: async (id: number, mine = false) =>
        request<any>(mine ? `/venues/${id}/scores?mine=true` : `/venues/${id}/scores`, undefined, await tok()),
      // Rejects with a 409 (`code: 'duplicate_venue'`, plus `candidates`) when a venue of the same
      // name already exists within 250m. Re-send with `allowDuplicate: true` once the user confirms
      // it really is a different place.
      create: async (body: { name: string; address: string; isResidence?: boolean; privacyTier?: 'full' | 'city_state' | 'hidden'; allowDuplicate?: boolean }) =>
        request<any>('/venues', { method: 'POST', body: JSON.stringify(body) }, await tok()),
      patch: async (id: number, body: { name?: string; address?: string | null; isResidence?: boolean; privacyTier?: 'full' | 'city_state' | 'hidden'; showMachinesAndScores?: boolean }) =>
        request(`/venues/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      // Owner-managed machines at a private (home) venue — owner or admin only. `name` is a machine
      // from the catalog search (`machines.search`); anything not in the catalog is refused.
      inventory: {
        add: async (id: number, body: { name: string } | { machineId: number }) =>
          request<{ added: boolean; inventory: VenueInventory }>(`/venues/${id}/inventory`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
        remove: async (id: number, machineId: number) =>
          request<{ removed: boolean; inventory: VenueInventory }>(`/venues/${id}/inventory/${machineId}`, { method: 'DELETE' }, await tok()),
      },
      delete: async (id: number) =>
        request(`/venues/${id}`, { method: 'DELETE' }, await tok()),

      // Venue repair — for venues that never resolved to a HERE place or a Pinball Map location on
      // upload. All of these require auth: the backend allows an admin, the venue's owner, or
      // whoever added the venue.
      repair: {
        status: async (id: number) =>
          request<any>(`/venues/${id}/repair`, undefined, await tok()),
        resolveHere: async (id: number) =>
          request<any>(`/venues/${id}/repair/here`, { method: 'POST', body: '{}' }, await tok()),
        attachHere: async (id: number, body: { hereId: string; latitude?: number | null; longitude?: number | null }) =>
          request<any>(`/venues/${id}/repair/here/attach`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
        // For a venue with no address at all (typed in by name with location services off): search
        // Pinball Map and HERE by name, optionally near a city, then write the chosen place.
        placeSearch: async (id: number, q: string, near?: string) =>
          request<any>(
            `/venues/${id}/repair/place-search?q=${encodeURIComponent(q)}${near ? `&near=${encodeURIComponent(near)}` : ''}`,
            undefined, await tok(),
          ),
        resolvePlace: async (id: number, body:
          | { source: 'pm'; pinballMapId: number }
          | { source: 'here'; hereId: string }
          | { source: 'manual'; street: string; city: string; state?: string; postalCode?: string; country?: string; confirm?: boolean; acceptImprecise?: boolean }) =>
          request<any>(`/venues/${id}/repair/place`, { method: 'POST', body: JSON.stringify(body) }, await tok()),
        pmCandidates: async (id: number, q?: string) =>
          request<any>(`/venues/${id}/repair/pm-candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`, undefined, await tok()),
        pmLink: async (id: number, pinballMapId: number) =>
          request<any>(`/venues/${id}/repair/pm-link`, { method: 'POST', body: JSON.stringify({ pinballMapId }) }, await tok()),
        resyncPreview: async (id: number) =>
          request<any>(`/venues/${id}/repair/resync-preview`, undefined, await tok()),
        resyncApply: async (id: number, merges: Array<Record<string, unknown>>) =>
          request<any>(`/venues/${id}/repair/resync-apply`, { method: 'POST', body: JSON.stringify({ merges }) }, await tok()),
      },
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
      stats: async () => request<any[]>('/admin/stats', undefined, await tok()),
      statHistory: async (days = 60) => request<any[]>(`/admin/stats/history?days=${days}`, undefined, await tok()),
      updateStat: async (id: number, body: { label?: string; description?: string }) =>
        request<any>(`/admin/stats/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, await tok()),
      deleteStat: async (id: number) =>
        request(`/admin/stats/${id}`, { method: 'DELETE' }, await tok()),
      runStatSnapshot: async () =>
        request<{ periodDate: string; values: Record<string, number> }>('/admin/stats/snapshot', { method: 'POST' }, await tok()),
      // Always targets the local loopback API directly (not BASE) — Drizzle Studio can only ever
      // run on the machine driving this browser, whether the page itself is served from
      // localhost:5174 or the deployed tilttrack.vercel.app.
      startDrizzleStudio: async () => {
        const token = await tok();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        let res: Response;
        try {
          res = await fetch('http://localhost:3001/api/admin/drizzle-studio/start', { method: 'POST', headers });
        } catch {
          throw new Error('Could not reach your local API server on port 3001 — start it with "npx tsx watch src/index.ts" from artifacts/api-server first.');
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw Object.assign(new Error(err.error ?? 'Request failed'), { status: res.status });
        }
        return res.json() as Promise<{ status: 'starting' | 'already-running' }>;
      },
    },
    // One request for every photo of a score (1–3). Each photo's client-extracted GPS/timestamp goes
    // in the JSON `meta` field, index-aligned with `photos` (see prepareUploadImage.ts) — HEIC
    // conversion and the client-side downscale both strip EXIF, so that data can't be recovered
    // server-side from the uploaded files. When absent the server tries its own extraction.
    upload: async (images: Array<{ file: Blob; filename?: string; latitude?: number | null; longitude?: number | null; exifDatetime?: string | null; heicFailed?: boolean }>) => {
      const token = await tok();
      const form = new FormData();
      // A lone HEIC the browser couldn't convert is the camera original — too big for the set path's
      // per-image limit, so it goes up the legacy single-`photo` way to the server's own HEIC decode.
      const legacy = images.length === 1 && !!images[0].heicFailed;
      images.forEach((img, i) => form.append(legacy ? 'photo' : 'photos', img.file, img.filename ?? `photo-${i + 1}.jpg`));
      form.append('meta', JSON.stringify(images.map(img => ({
        latitude: img.latitude ?? null,
        longitude: img.longitude ?? null,
        exifDatetime: img.exifDatetime ?? null,
      }))));

      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${BASE}/upload${legacy ? '' : '?set=1'}`, { method: 'POST', body: form, headers });
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
