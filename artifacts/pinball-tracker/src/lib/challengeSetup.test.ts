// Run: ../api-server/node_modules/.bin/tsx --test src/lib/challengeSetup.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { challengeSetupState, nudgeDismissKey, readDismissed, writeDismissed, shouldNudge } from './challengeSetup.ts';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    map: m,
  };
}
const throwing = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

const empty = challengeSetupState({ machines: [], venues: [] }, { area: null });

test('challengeSetupState: nothing set up', () => {
  assert.deepEqual(empty, { machines: false, venues: false, area: false, any: false, all: false });
});

test('challengeSetupState: missing data counts as empty', () => {
  assert.deepEqual(challengeSetupState(undefined, undefined), empty);
  assert.deepEqual(challengeSetupState(null, null), empty);
});

test('challengeSetupState: any one part counts', () => {
  assert.equal(challengeSetupState({ machines: [{}], venues: [] }, { area: null }).any, true);
  assert.equal(challengeSetupState({ machines: [], venues: [{}] }, { area: null }).any, true);
  const areaOnly = challengeSetupState({ machines: [], venues: [] }, { area: { postalCode: '02639' } });
  assert.deepEqual(areaOnly, { machines: false, venues: false, area: true, any: true, all: false });
});

test('challengeSetupState: all parts', () => {
  const s = challengeSetupState({ machines: [{}], venues: [{}, {}] }, { area: { postalCode: '02639' } });
  assert.deepEqual(s, { machines: true, venues: true, area: true, any: true, all: true });
});

test('nudgeDismissKey is per user', () => {
  assert.equal(nudgeDismissKey(42), 'tilttrack.challengeSetupNudge.dismissed.42');
  assert.notEqual(nudgeDismissKey(1), nudgeDismissKey(2));
});

test('readDismissed / writeDismissed round-trip, per user', () => {
  const s = memoryStore();
  assert.equal(readDismissed(7, s), false);
  writeDismissed(7, s);
  assert.equal(readDismissed(7, s), true);
  assert.equal(readDismissed(8, s), false);
  assert.equal(s.map.get('tilttrack.challengeSetupNudge.dismissed.7'), '1');
});

test('throwing or missing storage: not dismissed, write is a no-op', () => {
  assert.equal(readDismissed(7, throwing), false);
  assert.doesNotThrow(() => writeDismissed(7, throwing));
  assert.equal(readDismissed(7, null), false);
  assert.doesNotThrow(() => writeDismissed(7, null));
});

test('default store works without a localStorage global (node)', () => {
  assert.equal(readDismissed(7), false);
  assert.doesNotThrow(() => writeDismissed(7));
});

test('shouldNudge', () => {
  const me = { disabledAt: null };
  const filled = challengeSetupState({ machines: [{}], venues: [] }, { area: null });
  assert.equal(shouldNudge({ me, state: empty, dismissed: false }), true);
  assert.equal(shouldNudge({ me: null, state: empty, dismissed: false }), false, 'signed out / no profile');
  assert.equal(shouldNudge({ me: undefined, state: empty, dismissed: false }), false);
  assert.equal(shouldNudge({ me: { disabledAt: '2026-10-01T00:00:00Z' }, state: empty, dismissed: false }), false, 'disabled');
  assert.equal(shouldNudge({ me, state: filled, dismissed: false }), false, 'something set up');
  assert.equal(shouldNudge({ me, state: empty, dismissed: true }), false, 'dismissed');
});
