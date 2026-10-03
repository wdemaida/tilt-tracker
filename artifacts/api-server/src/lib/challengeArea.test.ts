// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/challengeArea.test.ts
// (from artifacts/api-server). Validation and the HERE ZIP geocode only — everything here fails or
// answers before the database; the DB paths are covered by test-challenges.ts on the dev branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HERE_API_KEY ||= 'zz-test-stub';
const realFetch = globalThis.fetch;
let answer: unknown = { items: [] };
let status = 200;
const urls: URL[] = [];
globalThis.fetch = (async (input: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  urls.push(url);
  if (!url.hostname.endsWith('hereapi.com')) throw new Error(`unexpected request to ${url.hostname}`);
  return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { setChallengeArea } = await import('./challengeArea.js');
const { ChallengeError } = await import('./challenges.js');
const { geocodePostalCode } = await import('./hereApi.js');

test('PUT validation: bad ZIP / bad radius are 400s, before any lookup', async () => {
  const geocode = async () => { throw new Error('must not geocode'); };
  const code = async (body: Record<string, unknown>) => {
    try { await setChallengeArea(1, body, { geocode: geocode as any }); return 'ok'; } catch (e) {
      assert.ok(e instanceof ChallengeError); return `${(e as any).status} ${(e as any).code}`;
    }
  };
  assert.equal(await code({ postalCode: '0263', radiusMiles: 10 }), '400 invalid_postal_code');
  assert.equal(await code({ postalCode: 'SW1A 1AA', radiusMiles: 10 }), '400 invalid_postal_code');
  assert.equal(await code({ radiusMiles: 10 }), '400 invalid_postal_code');
  assert.equal(await code({ postalCode: '02639', radiusMiles: 35 }), '400 invalid_radius');
  assert.equal(await code({ postalCode: '02639' }), '400 invalid_radius');
});

test('geocodePostalCode: one qualified HERE request; only a postalCodePoint for that ZIP counts', async () => {
  urls.length = 0;
  answer = { items: [{ resultType: 'postalCodePoint', position: { lat: 41.6721, lng: -70.1302 }, address: { city: 'Dennis', stateCode: 'MA', postalCode: '02639', countryCode: 'USA' } }] };
  const ok = await geocodePostalCode('02639');
  assert.deepEqual(ok, { status: 'ok', point: { lat: 41.6721, lng: -70.1302, city: 'Dennis', state: 'MA' } });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].hostname, 'geocode.search.hereapi.com');
  assert.equal(urls[0].searchParams.get('qq'), 'postalCode=02639;country=USA');

  answer = { items: [{ resultType: 'administrativeArea', position: { lat: 40, lng: -100 }, address: { countryCode: 'USA' } }] };
  assert.deepEqual(await geocodePostalCode('00000'), { status: 'not_found' });
  answer = { items: [{ resultType: 'postalCodePoint', position: { lat: 1, lng: 1 }, address: { postalCode: '99999', countryCode: 'USA' } }] };
  assert.deepEqual(await geocodePostalCode('02639'), { status: 'not_found' }, 'another ZIP is not this ZIP');
  answer = { items: [] };
  assert.deepEqual(await geocodePostalCode('02639'), { status: 'not_found' });
  status = 503;
  assert.deepEqual(await geocodePostalCode('02639'), { status: 'unavailable' });
  status = 200;
});

test.after(() => { globalThis.fetch = realFetch; });
