const PM_BASE = 'https://pinballmap.com/api/v1';

// Pinball Map began requiring an api_token on *every* endpoint — including read-only GETs — on
// 2026-07-30. It goes on the query string, not in a header (confirmed against pinballmap.com/llms.txt).
// Request one at https://pinballmap.com/api_token; approval is manual.
const PM_API_TOKEN = process.env.PINBALL_MAP_API_TOKEN;

export type PmErrorKind = 'no_token' | 'unauthorized' | 'rate_limited' | 'http' | 'network';

export class PmApiError extends Error {
  constructor(public kind: PmErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'PmApiError';
  }
}

export function isPmConfigured(): boolean {
  return !!PM_API_TOKEN;
}

// Single choke point for every Pinball Map call so the token, and the distinction between "we are
// not configured" and "the venue genuinely has no machines", exist in exactly one place. Callers
// that want the old silent-degradation behaviour wrap this in `.catch(() => fallback)`; the repair
// endpoints let it throw so the UI can say *why* nothing resolved instead of showing an empty list.
async function pmFetch<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!PM_API_TOKEN) {
    throw new PmApiError('no_token', 'PINBALL_MAP_API_TOKEN is not set — request a key at https://pinballmap.com/api_token');
  }

  const url = new URL(`${PM_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('api_token', PM_API_TOKEN);

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new PmApiError('network', `Could not reach Pinball Map: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new PmApiError('unauthorized', 'Pinball Map rejected the API token — check PINBALL_MAP_API_TOKEN', res.status);
  }
  if (res.status === 429) {
    throw new PmApiError('rate_limited', 'Pinball Map rate limit hit — try again in a few minutes', 429);
  }
  if (!res.ok) {
    throw new PmApiError('http', `Pinball Map returned ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
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
    if (mapped.length > 0) return mapped;
  }

  const data = await pmFetch<{ locations?: PmLocation[] }>('/locations.json', {
    by_location_name: q,
    no_details: 1,
  });
  return data.locations ?? [];
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

  const fallback = await searchPmLocationsByName(q);
  const full: PmLocation[] = [];
  for (const hit of fallback.slice(0, maxLookups)) {
    const loc = await getPmLocation(hit.id);
    if (loc) full.push(loc);
  }
  return full;
}

export async function getPmLocation(pmLocationId: number): Promise<PmLocation | null> {
  const data = await pmFetch<PmLocation & { errors?: string }>(`/locations/${pmLocationId}.json`, { metadata_only: 1 });
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

export async function getPmMachinesAtLocation(pmLocationId: number): Promise<PmLocationMachineXref[]> {
  const locData = await pmFetch<any>(`/locations/${pmLocationId}.json`);
  const xrefs = readXrefs(locData);
  if (xrefs.length > 0) return xrefs;

  // Defensive second pass: if the show endpoint ever stops embedding machine names, fall back to the
  // dedicated endpoint rather than silently reporting the location as having no machines.
  const details = await pmFetch<{ machines?: PmMachine[] }>(`/locations/${pmLocationId}/machine_details.json`);
  const machines = details.machines ?? [];
  if (machines.length === 0) return [];

  const xrefMap = new Map<number, number>();
  for (const x of locData?.location_machine_xrefs ?? []) {
    if (x.machine_id != null) xrefMap.set(x.machine_id, x.id);
  }
  return machines.map(m => ({ id: xrefMap.get(m.id) ?? 0, machine: m }));
}

export async function getPmUserToken(email: string, password: string): Promise<{ token: string; username: string } | null> {
  try {
    const data = await pmFetch<{ authentication_token?: string; username?: string }>('/users/auth_details.json', {
      login: email,
      password,
    });
    if (!data.authentication_token) return null;
    return { token: data.authentication_token, username: data.username ?? '' };
  } catch {
    return null;
  }
}

export async function submitPmScore(userToken: string, locationMachineXrefId: number, score: number): Promise<boolean> {
  if (!PM_API_TOKEN) return false;
  try {
    const url = new URL(`${PM_BASE}/machine_score_xrefs.json`);
    url.searchParams.set('api_token', PM_API_TOKEN);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_token: userToken, location_machine_xref_id: locationMachineXrefId, score }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
