// Run: npx tsx --test src/lib/cameraReturn.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markCameraPending, clearCameraPending, takeFreshCameraPending, CAMERA_PENDING_MAX_AGE_MS } from './cameraReturn.ts';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    size: () => m.size,
  };
}

const throwing = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};

test('no record means no hint', () => {
  assert.equal(takeFreshCameraPending(1000, memoryStore()), false);
});

test('a fresh record shows the hint once, then is consumed', () => {
  const s = memoryStore();
  markCameraPending(1000, s);
  assert.equal(takeFreshCameraPending(1000 + 60_000, s), true);
  assert.equal(s.size(), 0);
  assert.equal(takeFreshCameraPending(1000 + 61_000, s), false);
});

test('the age limit is inclusive; past it the record is stale and still cleared', () => {
  const s = memoryStore();
  markCameraPending(0, s);
  assert.equal(takeFreshCameraPending(CAMERA_PENDING_MAX_AGE_MS, s), true);
  markCameraPending(0, s);
  assert.equal(takeFreshCameraPending(CAMERA_PENDING_MAX_AGE_MS + 1, s), false);
  assert.equal(s.size(), 0);
});

test('a photo arriving clears the record', () => {
  const s = memoryStore();
  markCameraPending(1000, s);
  clearCameraPending(s);
  assert.equal(takeFreshCameraPending(2000, s), false);
});

test('garbage or future timestamps are not fresh', () => {
  const s = memoryStore();
  s.setItem('tilttrack-camera-pending', 'nope');
  assert.equal(takeFreshCameraPending(1000, s), false);
  markCameraPending(5000, s);
  assert.equal(takeFreshCameraPending(1000, s), false);
});

test('storage that throws never throws out', () => {
  assert.doesNotThrow(() => markCameraPending(1000, throwing));
  assert.doesNotThrow(() => clearCameraPending(throwing));
  assert.equal(takeFreshCameraPending(1000, throwing), false);
  assert.equal(takeFreshCameraPending(1000, null), false);
});
