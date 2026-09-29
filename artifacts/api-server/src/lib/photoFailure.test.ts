import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhotoFailure } from './photoFailure.js';

test('parsePhotoFailure: keeps whitelisted fields, capped', () => {
  const p = parsePhotoFailure({
    stage: 'put', reason: 'HTTP 403', detail: 'x'.repeat(1000), fileType: 'image/heif', fileSize: 12_345_678.4,
    originalWidth: 8160, originalHeight: 6120, heicFailed: false, userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    photoKey: 'scores/1/secret.jpg', extra: { nested: true },
  });
  assert.deepEqual(p, {
    stage: 'put', reason: 'http403', detail: 'x'.repeat(300), fileType: 'image/heif', fileSize: 12_345_678,
    originalWidth: 8160, originalHeight: 6120, heicFailed: false, clientUserAgent: 'Mozilla/5.0 (Linux; Android 14)',
  });
});

test('parsePhotoFailure: unknown stage is refused; junk values become null', () => {
  assert.equal(parsePhotoFailure({ stage: 'launch', reason: 'decode' }), null);
  assert.equal(parsePhotoFailure(null), null);
  assert.deepEqual(parsePhotoFailure({ stage: 'encode', fileSize: -1, originalWidth: Infinity, detail: '  ', heicFailed: 'yes' }), {
    stage: 'encode', reason: 'unknown', detail: null, fileType: null, fileSize: null,
    originalWidth: null, originalHeight: null, heicFailed: null, clientUserAgent: null,
  });
});
