const PM_BASE = 'https://pinballmap.com/api/v1';

export interface PmLocation {
  id: number;
  name: string;
  lat: number;
  lon: number;
  street?: string;
  city?: string;
  state?: string;
  machine_count: number;
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

// max_distance is in miles and must be an integer — the API truncates decimals to 0
export async function findNearestPmLocations(lat: number, lon: number, maxDistanceMiles = 1): Promise<PmLocation[]> {
  try {
    const url = `${PM_BASE}/locations/closest_by_lat_lon.json?lat=${lat}&lon=${lon}&max_distance=${Math.ceil(maxDistanceMiles)}&send_all_within_distance=true`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.locations ?? [];
  } catch {
    return [];
  }
}

// Returns machines for display (name, manufacturer, year). Response: { machines: [...] }
export async function getPmMachinesAtLocation(pmLocationId: number): Promise<PmLocationMachineXref[]> {
  try {
    // Fetch machine names from machine_details
    const detailsRes = await fetch(`${PM_BASE}/locations/${pmLocationId}/machine_details.json`, { headers: { Accept: 'application/json' } });
    if (!detailsRes.ok) return [];
    const details = await detailsRes.json();
    const machines: PmMachine[] = details.machines ?? [];

    // Fetch xref IDs from location detail (needed for score cross-posting)
    const locRes = await fetch(`${PM_BASE}/locations/${pmLocationId}.json`, { headers: { Accept: 'application/json' } });
    const xrefMap = new Map<number, number>(); // machine_id → xref_id
    if (locRes.ok) {
      const locData = await locRes.json();
      for (const x of locData.location_machine_xrefs ?? []) {
        xrefMap.set(x.machine_id, x.id);
      }
    }

    return machines.map(m => ({
      id: xrefMap.get(m.id) ?? 0,
      machine: m,
    }));
  } catch {
    return [];
  }
}

export async function getPmUserToken(email: string, password: string): Promise<{ token: string; username: string } | null> {
  try {
    const url = `${PM_BASE}/users/auth_details.json?login=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.authentication_token) return null;
    return { token: data.authentication_token, username: data.username ?? '' };
  } catch {
    return null;
  }
}

export async function submitPmScore(userToken: string, locationMachineXrefId: number, score: number): Promise<boolean> {
  try {
    const res = await fetch(`${PM_BASE}/machine_score_xrefs.json`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_token: userToken, location_machine_xref_id: locationMachineXrefId, score }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
