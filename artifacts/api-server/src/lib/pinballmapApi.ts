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
//
// `lookup` resolves one id to a full record. Callers pass `getPmLocationCached` (pmRosterCache.ts),
// which reads the cached `/locations/:id.json` row before going live — this module can't import the
// cache itself (the cache imports it).
export async function searchPmLocationsWithAddress(
  name: string,
  lookup: (pmLocationId: number) => Promise<PmLocation | null>,
  maxLookups = 3,
): Promise<PmLocation[]> {
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
    const loc = await lookup(hit.id);
    if (loc) full.push(loc);
  }
  return full;
}

// There is deliberately no `?metadata_only=1` lookup any more. It was a second URL for the same
// location (three requests for one venue link: place pick, pm-link check, roster), and uncached.
// A location's name/address now come from the full `/locations/:id.json` response the roster is read
// from, stored alongside it in pm_location_cache — see getPmLocationCached() in pmRosterCache.ts.

/** The location fields of a `/locations/:id.json` body — the subset stored with the cached roster. */
export function pickPmLocation(body: any): PmLocation | null {
  if (!body || typeof body !== 'object' || !body.id) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? null : String(v));
  return {
    id: Number(body.id),
    name: typeof body.name === 'string' ? body.name : '',
    lat: body.lat,
    lon: body.lon,
    street: str(body.street),
    city: str(body.city),
    state: str(body.state),
    zip: str(body.zip),
    country: str(body.country),
    ...(typeof body.num_machines === 'number' ? { num_machines: body.num_machines } : {}),
  };
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
  return (await getPmLocationWithMachines(pmLocationId)).xrefs;
}

/**
 * One `/locations/:id.json` request → the roster plus the location's own fields (name, address,
 * coordinates). Throws PmApiError('not_found') when the id doesn't resolve, like
 * getPmMachinesAtLocation. Only pmRosterCache should call this.
 */
export async function getPmLocationWithMachines(
  pmLocationId: number,
): Promise<{ location: PmLocation; xrefs: PmLocationMachineXref[] }> {
  const locData = await pmFetch<any>(`/locations/${pmLocationId}.json`);
  const location = locData && !locData.errors ? pickPmLocation(locData) : null;
  if (!location) {
    throw new PmApiError('not_found', `Pinball Map has no location with id ${pmLocationId}`, 404);
  }
  return { location, xrefs: await readRoster(pmLocationId, locData) };
}

async function readRoster(pmLocationId: number, locData: any): Promise<PmLocationMachineXref[]> {
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

// ── User account: connect + score posting ─────────────────────────────────────────────────────
//
// Protocol note — verified against Pinball Map's own source (github.com/pinballmap/pbm @ 1b527c0),
// not their docs, on 2026-09-26. Almost every failure is an HTTP 200, so status alone proves nothing:
//
// • GET /users/auth_details.json?login=&password=   (api/v1/users_controller.rb#auth_details)
//   `login` is the username OR email, case-insensitive. Success is NESTED:
//     200 {"user":{"username","email","authentication_token"}}
//   Failures are 200 {"errors":"<msg>"}: "login and password are required fields", "Unknown user",
//   "Incorrect password", "User is not yet confirmed. Please follow emailed confirmation
//   instructions." A disabled account is 403 {"error":"account_disabled"}. Our own api_token
//   missing/rejected is 401 {"error":"A valid api_token is required ..."}. Rate limit: 10/min per
//   api_token owner — i.e. shared by every TiltTrack user — then 429.
//
// • POST /machine_score_xrefs.json   (api/v1/machine_score_xrefs_controller.rb#create)
//   Authenticated by authenticate_from_token (application_controller.rb): needs BOTH user_email and
//   user_token, as params (query or JSON body) or X-User-Email/X-User-Token headers, and looks the
//   user up with User.find_by(email:) — exact case, so we send the email auth_details returned, not
//   what the user typed. Without a valid pair it answers 200 {"errors":"Authentication is required
//   for this action. ..."} (no 401). `score` must be a STRING: the controller calls score.gsub!, so a
//   JSON number is a 500. Success is 201 {"machine_score_xref":{..., "username"}}. Other failures:
//   200 {"errors": "<msg>" | ["<msg>", ...]} (e.g. "Failed to find machine"). Rate limit 80 / 2 min
//   per api_token owner.
//
// The user pair goes in the JSON body rather than headers: pmClient already JSON-encodes POST
// bodies and keeps only our api_token on the query string, Rails merges the body into `params`
// (which authenticate_from_token reads first), and nothing credential-bearing lands in a URL that
// could end up in PM's access logs or ours. Both requests are `sensitive`, so pmClient never
// caches, records, de-duplicates or logs them beyond their path.

/** PM's `errors` field is a string, or an array of strings for model validation failures. */
function pmErrorsText(errors: unknown): string | null {
  if (typeof errors === 'string') return errors.trim() || null;
  if (Array.isArray(errors)) {
    const joined = errors.filter(e => typeof e === 'string').join('; ').trim();
    return joined || null;
  }
  return null;
}

/** True when a 401/403 body is about OUR api_token (a config problem), not the user's account. */
export function isApiTokenRejection(err: unknown): boolean {
  return err instanceof PmApiError && err.kind === 'unauthorized' && /api_token/i.test(err.detail ?? '');
}

function isAccountDisabled(err: unknown): boolean {
  return err instanceof PmApiError && err.kind === 'unauthorized' && err.status === 403
    && /account_disabled/i.test(err.detail ?? '');
}

export type PmAuthResult =
  | { ok: true; token: string; username: string; email: string }
  | {
    ok: false;
    reason: 'invalid_credentials' | 'unconfirmed' | 'missing_fields' | 'account_disabled' | 'rejected';
    /** Pinball Map's own message (or "account_disabled"). */
    message: string;
  };

/**
 * Exchanges a user's Pinball Map login (username or email) for their user token + canonical email.
 * Returns `ok: false` for anything that is the *user's* problem (wrong password, unconfirmed,
 * disabled). Throws PmApiError for everything else — rate limited, breaker open, network, our
 * api_token rejected (`isApiTokenRejection`), or a response shaped unlike PM's source — so the route
 * never calls a Pinball Map outage a wrong password.
 */
export async function getPmUserToken(login: string, password: string, client = pmClient()): Promise<PmAuthResult> {
  let body: any;
  try {
    ({ body } = await client.request<any>({
      path: '/users/auth_details.json',
      params: { login, password },
      sensitive: true,
    }));
  } catch (err) {
    if (isAccountDisabled(err)) return { ok: false, reason: 'account_disabled', message: 'account_disabled' };
    throw err;
  }

  const errors = pmErrorsText(body?.errors);
  if (errors) {
    if (/unknown user|incorrect password/i.test(errors)) return { ok: false, reason: 'invalid_credentials', message: errors };
    if (/not yet confirmed/i.test(errors)) return { ok: false, reason: 'unconfirmed', message: errors };
    if (/required/i.test(errors)) return { ok: false, reason: 'missing_fields', message: errors };
    return { ok: false, reason: 'rejected', message: errors };
  }

  const user = body?.user;
  const token = typeof user?.authentication_token === 'string' ? user.authentication_token : '';
  const email = typeof user?.email === 'string' ? user.email : '';
  if (!token || !email) {
    // Not an answer PM's source can give — don't guess, and don't store half a credential.
    throw new PmApiError('http', 'Pinball Map returned an unexpected sign-in response');
  }
  return { ok: true, token, email, username: typeof user.username === 'string' ? user.username : '' };
}

export interface PmUserAuth {
  /** The email auth_details returned (exact case — PM looks it up with find_by). */
  email: string;
  token: string;
}

export type PmSubmitResult =
  | { ok: true; username: string | null; scoreId: number | null }
  | {
    ok: false;
    /** auth_required: PM didn't accept the email+token pair — the stored credential is dead. */
    reason: 'auth_required' | 'account_disabled' | 'rejected';
    message: string;
  };

/**
 * Posts one score to Pinball Map. Success is ONLY a 201 carrying `machine_score_xref` — a bare 2xx
 * proves nothing (PM reports most failures as 200 {"errors"}). Returns `ok: false` for answers about
 * this user or this score; throws PmApiError for rate limits, outages, our api_token being rejected
 * (`isApiTokenRejection`) or any response shaped unlike PM's source.
 */
export async function submitPmScore(
  auth: PmUserAuth,
  locationMachineXrefId: number,
  score: number,
  client = pmClient(),
): Promise<PmSubmitResult> {
  let res: { status: number; body: any };
  try {
    res = await client.request<any>({
      method: 'POST',
      path: '/machine_score_xrefs.json',
      body: {
        user_email: auth.email,
        user_token: auth.token,
        location_machine_xref_id: locationMachineXrefId,
        score: String(score), // PM calls score.gsub! on it — a JSON number is a 500
      },
      sensitive: true,
    });
  } catch (err) {
    if (isAccountDisabled(err)) return { ok: false, reason: 'account_disabled', message: 'account_disabled' };
    throw err;
  }

  const { status, body } = res;
  if (status === 201 && body?.machine_score_xref && typeof body.machine_score_xref === 'object') {
    const x = body.machine_score_xref;
    return {
      ok: true,
      username: typeof x.username === 'string' ? x.username : null,
      scoreId: typeof x.id === 'number' ? x.id : null,
    };
  }
  const errors = pmErrorsText(body?.errors);
  if (errors) {
    if (/authentication is required/i.test(errors)) return { ok: false, reason: 'auth_required', message: errors };
    return { ok: false, reason: 'rejected', message: errors };
  }
  throw new PmApiError('http', `Pinball Map returned an unexpected response to the score post (${status})`, status);
}
