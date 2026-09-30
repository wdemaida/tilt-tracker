// Run: npx tsx --test src/lib/captureTime.test.ts   (from artifacts/pinball-tracker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickVideoCaptureTime, playedTimeLockFor } from './captureTime.ts';

test('a video time: creationdate, then mvhd, then the file time', () => {
  assert.deepEqual(
    pickVideoCaptureTime({ creationdate: '2026-09-10T22:01:00', mvhd: '2026-09-11T03:01:00.000Z', lastModified: 1 }),
    { exifDatetime: '2026-09-10T22:01:00', capturedAt: null, capturedAtSource: null },
  );
  assert.deepEqual(
    pickVideoCaptureTime({ creationdate: null, mvhd: '2026-09-11T03:01:00.000Z', lastModified: 1 }),
    { exifDatetime: null, capturedAt: '2026-09-11T03:01:00.000Z', capturedAtSource: 'container' },
  );
  assert.deepEqual(
    pickVideoCaptureTime({ creationdate: null, mvhd: null, lastModified: Date.UTC(2026, 8, 30, 12) }),
    { exifDatetime: null, capturedAt: '2026-09-30T12:00:00.000Z', capturedAtSource: 'file' },
  );
  assert.deepEqual(
    pickVideoCaptureTime({ creationdate: null, mvhd: null, lastModified: 0 }),
    { exifDatetime: null, capturedAt: null, capturedAtSource: null },
  );
});

test('the wizard lock', () => {
  // Camera time with a token: locked, of the server's kind.
  assert.deepEqual(playedTimeLockFor({ serverSource: 'photo', serverToken: 't', instantSource: null }), { kind: 'photo', token: 't' });
  assert.deepEqual(playedTimeLockFor({ serverSource: 'video', serverToken: 't', instantSource: null }), { kind: 'video', token: 't' });
  // Camera time the server couldn't sign: editable (it would save as manual).
  assert.equal(playedTimeLockFor({ serverSource: 'photo', serverToken: null, instantSource: null }), null);
  // A video's mvhd instant: locked as video, no token.
  assert.deepEqual(playedTimeLockFor({ serverSource: null, serverToken: null, instantSource: 'container' }), { kind: 'video', token: null });
  // A video's file-modified time: not the recording time — editable, flagged.
  assert.deepEqual(playedTimeLockFor({ serverSource: null, serverToken: null, instantSource: 'file' }), { kind: 'unverified' });
  // No camera time at all (AI-read or none).
  assert.equal(playedTimeLockFor({ serverSource: null, serverToken: null, instantSource: null }), null);
});
