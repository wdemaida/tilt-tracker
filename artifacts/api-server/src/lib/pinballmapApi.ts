import { pmClient, PmApiError, type PmErrorKind } from './pmClient.js';

// Every request below goes through pmClient (pmClient.ts): it adds the api_token (Pinball Map has
// required one on every endpoint since 2026-07-30 — query string, per pinballmap.com/llms.txt), and
// owns the rate limiting, de-duplication, timeout, circuit breaker and dev-mode fixtures. Nothing in
// TiltTrack calls pinballmap.com any other way.
export { PmApiError, type PmErrorKind };

export function isPmConfigured(): boolean {
  return pmClient().isConfigured();
}

// Throws a typed PmApiError so the distinction between "we are not configured / Pinball Map is down"
// and "the venue genuinely has no machines" survives to the caller. Callers that want silent
// degradation wrap this in `.catch(() => fallback)`; the repair endpoints let it throw so the UI can
// say *why* nothing resolved instead of showing an empty list.
function pmFetch<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  return pmClient().get<T>(path, params);
}

export interface PmLocation {
  id: number;
  name: string;
  /**
   * Typed as a number, but the API actually sends decimal *strings* ("45.4063431") — coerce with
   * Number() before comparing or storing. (Arithmetic happens to coerce, which is why the upload
   * flow's haversine works on them as-is.)
   */
  lat: number;
  lon: number;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  /** ISO 3166 alpha-2 ("US", "GB"). Pinball Map is international — see the Salisbury "Special When Lit". */
  country?: string | null;
  machine_count?: number;
  num_machines?: number;
  distance?: number;
}

export interface PmMachine {
  id: number;
  name: string;
  manufacturer?: string;
  year?: number;
}

export interface PmLocationMachineXref {
  id: number;
  machine: PmMachine;
}

// The canonical public listing for a location — Pinball Map's CC BY-SA licence requires that data
// shown for a specific location link back to that location's own page, not just the homepage. This
// is also the URL that surfaces a location's numeric id in their UI, which is what makes manual
// linking possible when the automatic match misses.
export function pmLocationUrl(pmLocationId: number): string {
  return `https://pinballmap.com/map?by_location_id=${pmLocationId}`;
}

// max_distance is in miles and must be an integer — the API truncates decimals to 0
export async function findNearestPmLocations(lat: number, lon: number, maxDistanceMiles = 1): Promise<PmLocation[]> {
  const data = await pmFetch<{ locations?: PmLocation[] }>('/locations/closest_by_lat_lon.json', {
    lat,
    lon,
    max_distance: Math.ceil(maxDistanceMiles),
    send_all_within_distance: 'true',
    no_details: 1,
  });
  return data.locations ?? [];
}

// Name search for the manual repair flow — lets someone type "Headquarters" instead of hunting down
// a numeric id on pinballmap.com. Falls back to the fuller locations.json search when autocomplete
// comes back empty, since autocomplete only matches from the start of the name.
export async function searchPmLocationsByName(name: string): Promise<PmLocation[]> {
  const q = name.trim();
  if (q.length < 2) return [];

  const mapped = await pmAutocomplete(q);
  if (mapped.length > 0) return mapped;

  const data = await pmFetch<{ locations?: PmLocation[] }>('/locations.json', {
    by_location_name: q,
    no_details: 1,
  });
  return data.locations ?? [];
}

// Autocomplete only, normalised to PmLocation shape (id + label; no address or coordinates).
async function pmAutocomplete(q: string): Promise<PmLocation[]> {
  const auto = await pmFetch<Array<{ label?: string; value?: number | string; id?: number }> | { locations?: PmLocation[] }>(
    '/locations/autocomplete.json',
    { name: q },
  );

  // autocomplete.json returns a bare array; normalise it into PmLocation shape. As of 2026-09-24 each
  // entry is {label: "Special When Lit (King City, OR)", value: "Special When Lit", id: 23289} —
  // `value` is the *name*, not the id. Reading `value` first turned every hit into a non-numeric id
  // that the filter then discarded, so any name autocomplete matched came back as "no match".
  if (Array.isArray(auto) && auto.length > 0) {
    const mapped = auto
      .map(a => ({ id: pmAutocompleteId(a), name: a.label ?? '', lat: 0, lon: 0 }))
      .filter(l => l.id > 0);
    return mapped;
  }
  return [];
}

/** The numeric location id from one autocomplete entry — `id` when present, `value` only if numeric. */
export function pmAutocompleteId(entry: { value?: number | string; id?: number }): number {
  if (typeof entry.id === 'number' && entry.id > 0) return entry.id;
  const v = Number(entry.value);
  return Number.isInteger(v) && v > 0 ? v : 0;
}

// Name search that returns full location records — street, city, zip, country and coordinates —
// for the address-less venue repair, where the whole point is to learn *where* the venue is.
// locations.json carries all of that in one request (autocomplete returns only a label), so it goes
// first; autocomplete is the fallback for the prefix matches locations.json can miss, and those
// hits are resolved one by one only up to a small cap to stay clear of per-record fan-out.
export async function searchPmLocationsWithAddress(name: string, maxLookups = 3): Promise<PmLocation[]> {
  const q = name.trim();
  if (q.length < 2) return [];

  const data = await pmFetch<{ locations?: PmLocation[] }>('/locations.json', {
    by_location_name: q,
    no_details: 1,
  });
  if (data.locations?.length) return data.locations;

  // Autocomplete directly, not searchPmLocationsByName — its own fallback is the locations.json
  // request that just came back empty, and repeating it doubled the calls for every miss.
  const fallback = await pmAutocomplete(q);
  const full: PmLocation[] = [];
  for (const hit of fallback.slice(0, maxLookups)) {
    const loc = await getPmLocation(hit.id);
    if (loc) full.push(loc);
  }
  return full;
}

export async function getPmLocation(pmLocationId: number): Promise<PmLocation | null> {
  let data: PmLocation & { errors?: string };
  try {
    data = await pmFetch<PmLocation & { errors?: string }>(`/locations/${pmLocationId}.json`, { metadata_only: 1 });
  } catch (err) {
    if (err instanceof PmApiError && err.kind === 'not_found') return null;
    throw err;
  }
  if (!data || (data as any).errors || !data.id) return null;
  return data;
}

// Reads name/manufacturer/year straight off the location show endpoint's embedded LMX list. Pinball
// Map's own guidance singles out per-record fan-out as the thing that gets apps blocked, and the
// show payload already carries everything the old two-call version fetched separately.
function readXrefs(locData: any): PmLocationMachineXref[] {
  const xrefs = locData?.location_machine_xrefs ?? [];
  return xrefs
    .map((x: any) => {
      const machine = x.machine ?? {};
      const name = machine.name ?? x.machine_name ?? x.name;
      if (!name) return null;
      return {
        id: x.id ?? 0,
        machine: {
          id: machine.id ?? x.machine_id ?? 0,
          name,
          manufacturer: machine.manufacturer ?? x.machine_manufacturer ?? undefined,
          year: machine.year ?? x.machine_year ?? undefined,
        },
      } as PmLocationMachineXref;
    })
    .filter(Boolean) as PmLocationMachineXref[];
}

/**
 * A location's current roster. Throws PmApiError('not_found') when the id doesn't resolve — callers
 * (pmRosterCache) must never cache an empty roster for a location that doesn't exist.
 */
export async function getPmMachinesAtLocation(pmLocationId: number): Promise<PmLocationMachineXref[]> {
  const locData = await pmFetch<any>(`/locations/${pmLocationId}.json`);
  if (!locData || locData.errors || !locData.id) {
    throw new PmApiError('not_found', `Pinball Map has no location with id ${pmLocationId}`, 404);
  }
  const rawXrefs: any[] = Array.isArray(locData.location_machine_xrefs) ? locData.location_machine_xrefs : [];
  const xrefs = readXrefs(locData);
  // An empty list is a real answer (a listing with no machines right now) — no second call.
  if (xrefs.length > 0 || rawXrefs.length === 0) return xrefs;

  // Defensive second pass, only when the show endpoint listed machines but without names: fall back
  // to the dedicated endpoint rather than silently reporting the location as having no machines.
  const details = await pmFetch<{ machines?: PmMachine[] }>(`/locations/${pmLocationId}/machine_details.json`);
  const machines = details.machines ?? [];
  if (machines.length === 0) return [];

  const xrefMap = new Map<number, number>();
  for (const x of rawXrefs) {
    if (x.machine_id != null) xrefMap.set(x.machine_id, x.id);
  }
  return machines.map(m => ({ id: xrefMap.get(m.id) ?? 0, machine: m }));
}

/**
 * Exchanges a user's Pinball Map login for their user token. null = bad credentials; anything else
 * (rate limited, breaker open, not configured) throws, so the route doesn't call a PM outage a wrong
 * password. `sensitive`: the request carries a password, so it is never de-duplicated, cached,
 * recorded or logged beyond its path.
 */
export async function getPmUserToken(email: string, password: string): Promise<{ token: string; username: string } | null> {
  try {
    const { body: data } = await pmClient().request<{ authentication_token?: string; username?: string }>({
      path: '/users/auth_details.json',
      params: { login: email, password },
      sensitive: true,
    });
    if (!data?.authentication_token) return null;
    return { token: data.authentication_token, username: data.username ?? '' };
  } catch (err) {
    if (err instanceof PmApiError && (err.kind === 'unauthorized' || err.kind === 'not_found')) return null;
    throw err;
  }
}

/**
 * Posts a score to Pinball Map. Throws PmApiError on any failure — `kind === 'unauthorized'` (401/403)
 * is the only one that means the user's token is bad; check `detail` for "api_token" to tell our own
 * token apart.
 *
 * Protocol note (flagged 2026-09-26, unchanged here): this sends `user_token` in the JSON body with no
 * `user_email`. Pinball Map's docs describe user auth as `user_email` + `user_token` query params. It
 * has not been changed without evidence of which form their API accepts today.
 */
export async function submitPmScore(userToken: string, locationMachineXrefId: number, score: number): Promise<void> {
  await pmClient().request({
    method: 'POST',
    path: '/machine_score_xrefs.json',
    body: { user_token: userToken, location_machine_xref_id: locationMachineXrefId, score },
    sensitive: true,
  });
}
