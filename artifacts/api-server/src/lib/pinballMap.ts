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

  const res = await fetch('https://pinballmap.com/api/v1/machines.json');
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
