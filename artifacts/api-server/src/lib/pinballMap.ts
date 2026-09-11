const PM_API_TOKEN = process.env.PINBALL_MAP_API_TOKEN;

export interface PinballMachine {
  id: number;
  name: string;
  opdb_id: string | null;
  ipdb_id: number | null;
  machine_group_id: number | null;
  manufacturer: string | null;
  year: number | null;
  opdb_img: string | null;
  machine_type: string | null;
  machine_display: string | null;
}

let cache: PinballMachine[] = [];
let lastFetched = 0;
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

export async function getAllMachines(): Promise<PinballMachine[]> {
  if (cache.length && Date.now() - lastFetched < TTL_MS) return cache;
  if (!PM_API_TOKEN) {
    throw new Error('PINBALL_MAP_API_TOKEN is not set — request a key at https://pinballmap.com/api_token');
  }

  // no_details drops is_active/created_at/updated_at/ipdb_id/machine_display — none of which this
  // cache exposes. Pinball Map recommends it explicitly for the app-startup machine list.
  const url = new URL('https://pinballmap.com/api/v1/machines.json');
  url.searchParams.set('no_details', '1');
  url.searchParams.set('api_token', PM_API_TOKEN);

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Pinball Map API error: ${res.status}`);
  const data = (await res.json()) as { machines: PinballMachine[] };
  cache = data.machines;
  lastFetched = Date.now();
  return cache;
}

export async function searchMachines(query: string, limit = 10): Promise<PinballMachine[]> {
  const all = await getAllMachines();
  const q = query.toLowerCase();
  return all.filter(m => m.name.toLowerCase().includes(q)).slice(0, limit);
}
