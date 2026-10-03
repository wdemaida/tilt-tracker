// Run: npx tsx --test src/lib/areaMatch.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  AREA_FETCH_RADIUS_MILES, AREA_MATCH_CAP, AREA_MAX_RADIUS_MILES, AREA_RADIUS_CHOICES, AREA_CELL_SLACK_MILES, AREA_SPOTS_SHOWN,
  areaCell, areaMachines, cellFromKey, haversineMiles, matchAreaSides, parsePostalCode, parseRadius, roundCentroid, trimAreaLocations,
  type AreaLocation, type MatchSide, type Spot,
} from './areaMatch.js';

// The one recorded Last Resort fixture: Portland, OR — the cell 45.5,-122.7 out to 55 miles.
const FIXTURES = new URL('../../fixtures/pm/', import.meta.url);
const portlandFile = readdirSync(FIXTURES).find(f => f.includes('lat=45.5_lon=-122.7_max_distance=55_'));
const portlandRaw = portlandFile ? JSON.parse(readFileSync(new URL(portlandFile, FIXTURES), 'utf8')).body.locations as unknown[] : null;

test('ZIP: 5 digits or ZIP+4 (stored as 5); anything else is invalid', () => {
  assert.equal(parsePostalCode('02639'), '02639');
  assert.equal(parsePostalCode(' 97214 '), '97214');
  assert.equal(parsePostalCode('97214-1234'), '97214');
  for (const bad of ['2639', '026391', 'ABCDE', 'SW1A 1AA', '', null, 97214, '97214-12']) assert.equal(parsePostalCode(bad), null, String(bad));
});

test('radius: only the choices (5, 10, 15, 20, 30, 50), number or numeric string', () => {
  assert.deepEqual([...AREA_RADIUS_CHOICES], [5, 10, 15, 20, 30, 50]);
  assert.equal(parseRadius(50), 50);
  assert.equal(parseRadius('15'), 15);
  for (const bad of [0, 4, 25, 35, 51, 100, '', 'ten', null, undefined, 10.5]) assert.equal(parseRadius(bad), null, String(bad));
});

test('centroid is stored at 2 decimals, never finer', () => {
  assert.deepEqual(roundCentroid(41.6677752, -70.1237654), { lat: 41.67, lng: -70.12 });
});

test('cell: nearest 0.1° grid point, stable key, no "-0.0"', () => {
  assert.deepEqual(areaCell(45.52, -122.68), { key: '45.5,-122.7', lat: 45.5, lng: -122.7 });
  assert.deepEqual(areaCell(45.5, -122.7), { key: '45.5,-122.7', lat: 45.5, lng: -122.7 });
  assert.equal(areaCell(41.67, -70.12).key, '41.7,-70.1');
  assert.equal(areaCell(-0.04, 0.04).key, '0.0,0.0');
  assert.deepEqual(cellFromKey('45.5,-122.7'), { key: '45.5,-122.7', lat: 45.5, lng: -122.7 });
  assert.equal(cellFromKey('nope'), null);
});

test('fetch radius covers the largest choice from anywhere in the cell (US latitudes, incl. HI and AK)', () => {
  assert.equal(AREA_FETCH_RADIUS_MILES, AREA_MAX_RADIUS_MILES + AREA_CELL_SLACK_MILES);
  assert.equal(AREA_FETCH_RADIUS_MILES, 55);
  assert.ok(AREA_FETCH_RADIUS_MILES <= 800, 'Pinball Map caps no_details max_distance at 800');
  let worst = 0;
  for (const base of [19.0, 25.0, 32.0, 41.6, 45.5, 61.2, 71.2]) {
    for (const dLat of [-0.0499, 0, 0.0499]) {
      for (const dLng of [-0.0499, 0, 0.0499]) {
        const c = roundCentroid(base + dLat, -100 + dLng);
        const cell = areaCell(c.lat, c.lng);
        worst = Math.max(worst, haversineMiles(c, cell));
      }
    }
  }
  assert.ok(worst <= AREA_CELL_SLACK_MILES, `worst centroid → grid point offset ${worst.toFixed(2)} mi`);
});

test('haversine: a known distance', () => {
  // Wedgehead (Portland) → Poit's (Eastham MA): ~2,560 miles.
  const d = haversineMiles({ lat: 45.523, lng: -122.65 }, { lat: 41.83, lng: -69.97 });
  assert.ok(d > 2450 && d < 2650, String(d));
  assert.equal(haversineMiles({ lat: 45.5, lng: -122.7 }, { lat: 45.5, lng: -122.7 }), 0);
});

test('trimAreaLocations: numbers from PM strings, machine ids deduped, junk dropped', () => {
  const rows = trimAreaLocations([
    { id: 1, name: ' Bar ', city: 'Portland', state: 'OR', lat: '45.5', lon: '-122.6', machine_ids: [3, 3, '4', -1], zip: '97214', phone: 'x' },
    { id: 2, name: 'No coords', lat: null, lon: null, machine_ids: [1] },
    { id: 0, name: 'No id', lat: '1', lon: '1' },
    { id: 3, name: '', lat: '1', lon: '1' },
    { id: 4, name: 'No machines', lat: '45', lon: '-122' },
  ]);
  assert.deepEqual(rows, [
    { id: 1, name: 'Bar', city: 'Portland', state: 'OR', lat: 45.5, lon: -122.6, machineIds: [3, 4] },
    { id: 4, name: 'No machines', city: null, state: null, lat: 45, lon: -122, machineIds: [] },
  ]);
  assert.equal('zip' in rows[0], false, 'only the fields matching needs are kept');
});

test('areaMachines: cut by the user’s own centroid and radius, nearest spot first', () => {
  const locs: AreaLocation[] = [
    { id: 1, name: 'Near', city: 'A', state: null, lat: 45.51, lon: -122.7, machineIds: [10, 20] },
    { id: 2, name: 'Far', city: 'B', state: null, lat: 45.9, lon: -122.7, machineIds: [10] },
    { id: 3, name: 'Mid', city: 'C', state: null, lat: 45.6, lon: -122.7, machineIds: [10] },
  ];
  const by = areaMachines(locs, { lat: 45.5, lng: -122.7 }, 10);
  assert.deepEqual(by.get(10)!.map(s => s.name), ['Near', 'Mid']);
  assert.deepEqual(by.get(20)!.map(s => s.pmLocationId), [1]);
  assert.equal(by.get(10)![0].miles, 0.7);
  assert.equal(areaMachines(locs, { lat: 45.5, lng: -122.7 }, 50).get(10)!.length, 3);
});

const spots = (n: number, from = 1): Spot[] => Array.from({ length: n }, (_, i) => ({ pmLocationId: from + i, name: `Spot ${from + i}`, city: 'X', miles: from + i }));
const area = (entries: Array<[number, Spot[]]>): MatchSide => ({ kind: 'area', spots: new Map(entries) });
const reach = (entries: Array<[number, 1 | 2 | 3]>): MatchSide => ({ kind: 'reach', levels: new Map(entries) });

test('match: exact machine ids only, both areas', () => {
  const out = matchAreaSides(area([[1, spots(1)], [2, spots(2)]]), area([[2, spots(3)], [3, spots(1)]]), new Set());
  assert.deepEqual(out.map(m => m.pmMachineId), [2]);
  assert.deepEqual(out[0].mine, { kind: 'area', spotCount: 2, spots: spots(2) });
  assert.deepEqual(out[0].theirs, { kind: 'area', spotCount: 3 });
});

test('match: two reaches are not an Expand search', () => {
  assert.deepEqual(matchAreaSides(reach([[1, 1]]), reach([[1, 2]]), new Set()), []);
});

test('match: one area against the other side’s reach, either way round', () => {
  const a = matchAreaSides(reach([[5, 2], [6, 1]]), area([[5, spots(2)], [7, spots(1)]]), new Set());
  assert.deepEqual(a.map(m => [m.pmMachineId, m.mine, m.theirs]), [[5, { kind: 'reach', level: 2 }, { kind: 'area', spotCount: 2 }]]);
  const b = matchAreaSides(area([[5, spots(1)]]), reach([[5, 3]]), new Set());
  assert.deepEqual(b[0].theirs, { kind: 'reach', level: 3 });
});

test('match ranking: familiar first, then most spots on the scarcer side, then my nearest, then id; capped', () => {
  const mine = area([[1, spots(1, 9)], [2, spots(5)], [3, spots(2, 4)], [4, spots(2, 1)], [5, spots(1)]]);
  const theirs = area([[1, spots(1)], [2, spots(1)], [3, spots(4)], [4, spots(9)], [5, spots(2)]]);
  const out = matchAreaSides(mine, theirs, new Set([1]));
  // 1 familiar; then min counts: 3→2, 4→2, 2→1, 5→1; ties by my nearest (4 at 1 mi < 3 at 4 mi; 5 at 1 < 2 at 1 → id)
  assert.deepEqual(out.map(m => m.pmMachineId), [1, 4, 3, 2, 5]);
  assert.equal(out[0].familiar, true);
  const many = area(Array.from({ length: 30 }, (_, i) => [100 + i, spots(1)] as [number, Spot[]]));
  assert.equal(matchAreaSides(many, many, new Set()).length, AREA_MATCH_CAP);
  assert.equal(AREA_MATCH_CAP, 10);
});

test('match: the viewer’s own spots are capped at 3 nearest; the count is the full count', () => {
  const out = matchAreaSides(area([[1, spots(6)]]), area([[1, spots(1)]]), new Set());
  assert.equal(out[0].mine.kind === 'area' && out[0].mine.spots.length, AREA_SPOTS_SHOWN);
  assert.equal(out[0].mine.kind === 'area' && out[0].mine.spotCount, 6);
});

test('PRIVACY: the friend’s half never carries a name, city, distance or location id', () => {
  const theirSpots = [{ pmLocationId: 4242, name: 'Secret Basement Bar', city: 'Hometown', miles: 1.3 }];
  const out = matchAreaSides(area([[1, spots(1)]]), area([[1, theirSpots]]), new Set());
  assert.deepEqual(Object.keys(out[0].theirs).sort(), ['kind', 'spotCount']);
  const json = JSON.stringify(out.map(m => m.theirs));
  for (const leak of ['Secret Basement Bar', 'Hometown', '4242', '1.3']) assert.ok(!json.includes(leak), leak);
});

test('the Solar City case (Portland fixture): collasta’s 10-mile area has it at one spot; Will reaches it on Cape Cod', { skip: !portlandRaw }, () => {
  const locs = trimAreaLocations(portlandRaw!);
  assert.equal(locs.length, 342);
  const SOLAR_CITY = 757, TRANSFORMERS_TMTE_PRO = 4625;
  const collasta = areaMachines(locs, roundCentroid(45.5231, -122.6765), 10);
  assert.equal(collasta.get(SOLAR_CITY)?.length, 1);
  assert.ok((collasta.get(TRANSFORMERS_TMTE_PRO)?.length ?? 0) >= 5);
  // Will (no area, or a Cape Cod one that can't reach Portland): his reach has Solar City (Poit's) at level 2.
  const out = matchAreaSides(reach([[SOLAR_CITY, 2]]), { kind: 'area', spots: collasta }, new Set([SOLAR_CITY]));
  assert.deepEqual(out, [{ pmMachineId: SOLAR_CITY, mine: { kind: 'reach', level: 2 }, theirs: { kind: 'area', spotCount: 1 }, familiar: true }]);
  assert.ok(!JSON.stringify(out).includes('My-O-My'), 'the spot near collasta is never named');
  // Every fixture location is inside the fetch radius of the cell point it was fetched from.
  const far = Math.max(...locs.map(l => haversineMiles({ lat: 45.5, lng: -122.7 }, { lat: l.lat, lng: l.lon })));
  assert.ok(far <= AREA_FETCH_RADIUS_MILES + 0.5, String(far));
});
