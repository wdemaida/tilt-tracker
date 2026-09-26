// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/photoStore.test.ts   (from artifacts/api-server)
// No network: presigning is pure computation, and head/delete go through a fake store or a stubbed
// S3Client.send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readR2Config, missingR2Vars, newPhotoKey, scoreIdFromKey, keyBelongsToScore, checkUploadedHead,
  sanitizeDimension, verifyUpload, findOrphans, publicScoreRow, createPhotoStore, createR2Client,
  deletePhotoBestEffort, PHOTO_MAX_BYTES, type PhotoStore, type HeadResult,
} from './photoStore.js';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const FULL_ENV = { R2_ACCOUNT_ID: 'acct123', R2_ACCESS_KEY_ID: 'AKIDTEST', R2_SECRET_ACCESS_KEY: 'secretTEST', R2_BUCKET: 'tilttrack-photos-dev' };

test('config: all four vars required; blanks count as missing', () => {
  assert.deepEqual(readR2Config(FULL_ENV), { accountId: 'acct123', accessKeyId: 'AKIDTEST', secretAccessKey: 'secretTEST', bucket: 'tilttrack-photos-dev' });
  assert.equal(readR2Config({ ...FULL_ENV, R2_BUCKET: '' }), null);
  assert.equal(readR2Config({ ...FULL_ENV, R2_SECRET_ACCESS_KEY: '  ' }), null);
  assert.equal(readR2Config({}), null);
  assert.deepEqual(missingR2Vars({ R2_ACCOUNT_ID: 'x' }), ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']);
  assert.deepEqual(missingR2Vars(FULL_ENV), []);
});

test('keys: minted per score, and only our own format maps back to a score', () => {
  const key = newPhotoKey(42, UUID);
  assert.equal(key, `scores/42/${UUID}.jpg`);
  assert.match(newPhotoKey(7), /^scores\/7\/[0-9a-f-]{36}\.jpg$/);
  assert.notEqual(newPhotoKey(7), newPhotoKey(7));
  assert.throws(() => newPhotoKey(0));
  assert.throws(() => newPhotoKey(1.5));

  assert.equal(scoreIdFromKey(key), 42);
  assert.equal(keyBelongsToScore(key, 42), true);
  assert.equal(keyBelongsToScore(key, 43), false);
  for (const bad of [
    `scores/42/${UUID}.png`, `scores/042/${UUID}.jpg`, `scores/42/../43/${UUID}.jpg`, `scores/42/${UUID}.jpg/x`,
    `other/42/${UUID}.jpg`, `scores/42/not-a-uuid.jpg`, `/scores/42/${UUID}.jpg`, `scores/42/${UUID.toUpperCase()}.jpg`,
    '', null, undefined, 42, { key },
  ]) {
    assert.equal(scoreIdFromKey(bad), null, String(bad));
  }
});

test('head check: size bounds and JPEG content type', () => {
  assert.deepEqual(checkUploadedHead({ contentLength: 1234, contentType: 'image/jpeg' }), { ok: true, bytes: 1234 });
  assert.equal(checkUploadedHead({ contentLength: PHOTO_MAX_BYTES, contentType: 'image/jpeg' }).ok, true);
  assert.equal(checkUploadedHead({ contentLength: 1, contentType: 'IMAGE/JPEG; charset=binary' }).ok, true);
  const big = checkUploadedHead({ contentLength: PHOTO_MAX_BYTES + 1, contentType: 'image/jpeg' });
  assert.equal(big.ok, false);
  assert.equal(!big.ok && big.code, 'photo_too_large');
  const empty = checkUploadedHead({ contentLength: 0, contentType: 'image/jpeg' });
  assert.equal(!empty.ok && empty.code, 'photo_empty');
  assert.equal(!checkUploadedHead({ contentLength: null, contentType: 'image/jpeg' }).ok, true);
  const png = checkUploadedHead({ contentLength: 10, contentType: 'image/png' });
  assert.equal(!png.ok && png.code, 'photo_wrong_type');
  assert.equal(checkUploadedHead({ contentLength: 10, contentType: null }).ok, false);
});

test('dimensions: positive integers up to the 4096 cap', () => {
  assert.equal(sanitizeDimension(3024), 3024);
  assert.equal(sanitizeDimension('4096'), 4096);
  assert.equal(sanitizeDimension(4097), null);
  assert.equal(sanitizeDimension(0), null);
  assert.equal(sanitizeDimension(-5), null);
  assert.equal(sanitizeDimension(12.5), null);
  assert.equal(sanitizeDimension('abc'), null);
  assert.equal(sanitizeDimension(undefined), null);
});

function fakeStore(objects: Record<string, HeadResult>, opts: { failDelete?: boolean } = {}) {
  const deleted: string[] = [];
  const store: PhotoStore = {
    bucket: 'fake',
    presignPut: async k => `https://put/${k}`,
    presignGet: async k => `https://get/${k}`,
    head: async k => objects[k] ?? null,
    delete: async k => {
      if (opts.failDelete) throw new Error('boom');
      deleted.push(k);
      delete objects[k];
    },
    list: async () => ({ objects: [] }),
  };
  return { store, deleted };
}

test('verifyUpload: happy path returns the size and deletes nothing', async () => {
  const key = newPhotoKey(5, UUID);
  const { store, deleted } = fakeStore({ [key]: { contentLength: 2_000_000, contentType: 'image/jpeg' } });
  assert.deepEqual(await verifyUpload(store, 5, key), { ok: true, bytes: 2_000_000 });
  assert.deepEqual(deleted, []);
});

test("verifyUpload: another score's key is refused without touching the bucket", async () => {
  const key = newPhotoKey(6, UUID);
  const { store, deleted } = fakeStore({ [key]: { contentLength: 10, contentType: 'image/jpeg' } });
  const r = await verifyUpload(store, 5, key);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 400);
  assert.equal(!r.ok && r.code, 'photo_key_invalid');
  assert.deepEqual(deleted, [], "must never delete someone else's object");
  const junk = await verifyUpload(store, 5, '../../etc');
  assert.equal(!junk.ok && junk.code, 'photo_key_invalid');
});

test('verifyUpload: missing object is a 404, nothing deleted', async () => {
  const { store, deleted } = fakeStore({});
  const r = await verifyUpload(store, 5, newPhotoKey(5, UUID));
  assert.equal(!r.ok && r.status, 404);
  assert.equal(!r.ok && r.code, 'photo_not_uploaded');
  assert.deepEqual(deleted, []);
});

test('verifyUpload: oversized or wrong-type object is deleted and refused', async () => {
  const big = newPhotoKey(5, UUID);
  const png = newPhotoKey(5);
  const { store, deleted } = fakeStore({
    [big]: { contentLength: PHOTO_MAX_BYTES + 1, contentType: 'image/jpeg' },
    [png]: { contentLength: 100, contentType: 'image/png' },
  });
  const r1 = await verifyUpload(store, 5, big);
  assert.equal(!r1.ok && r1.code, 'photo_too_large');
  const r2 = await verifyUpload(store, 5, png);
  assert.equal(!r2.ok && r2.code, 'photo_wrong_type');
  assert.deepEqual(deleted.sort(), [big, png].sort());
});

test('deletePhotoBestEffort never throws', async () => {
  const { store } = fakeStore({}, { failDelete: true });
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    await deletePhotoBestEffort(newPhotoKey(1, UUID), 'test', store);
    await deletePhotoBestEffort(null, 'test', store);
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
});

test('findOrphans: unreferenced and older than 24h only', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const h = 60 * 60 * 1000;
  const objs = [
    { key: 'scores/1/a.jpg', lastModified: new Date(now - 48 * h) }, // referenced
    { key: 'scores/2/b.jpg', lastModified: new Date(now - 48 * h) }, // orphan
    { key: 'scores/3/c.jpg', lastModified: new Date(now - 2 * h) },  // too new (mid-upload)
    { key: 'scores/4/d.jpg', lastModified: null },                   // unknown age — keep
  ];
  assert.deepEqual(findOrphans(objs, new Set(['scores/1/a.jpg']), now), ['scores/2/b.jpg']);
  assert.deepEqual(findOrphans(objs, new Set(), now, h), ['scores/1/a.jpg', 'scores/2/b.jpg', 'scores/3/c.jpg']);
});

test('publicScoreRow strips the key and size and adds hasFullPhoto', () => {
  const row = { id: 1, score: 5, photoKey: `scores/1/${UUID}.jpg`, photoBytes: 99, photoWidth: 10, photoHeight: 20 };
  const out = publicScoreRow(row);
  assert.equal('photoKey' in out, false);
  assert.equal('photoBytes' in out, false);
  assert.equal(out.hasFullPhoto, true);
  assert.equal(publicScoreRow({ id: 2, photoKey: null, photoBytes: null }).hasFullPhoto, false);
  assert.equal(JSON.stringify(out).includes('scores/'), false);
});

test('presigned URLs: R2 endpoint, bucket/key path, expiry, signed content type, no checksum params', async () => {
  const config = readR2Config(FULL_ENV)!;
  const store = createPhotoStore(config);
  const key = newPhotoKey(9, UUID);

  const put = new URL(await store.presignPut(key));
  assert.equal(put.host, 'acct123.r2.cloudflarestorage.com');
  assert.equal(put.pathname, `/tilttrack-photos-dev/${key}`);
  assert.equal(put.searchParams.get('X-Amz-Expires'), '300');
  assert.match(put.searchParams.get('X-Amz-SignedHeaders') ?? '', /content-type/);
  assert.equal([...put.searchParams.keys()].some(k => /checksum/i.test(k)), false, 'a checksum param would break browser PUTs');
  assert.equal(put.toString().includes('secretTEST'), false);

  const get = new URL(await store.presignGet(key));
  assert.equal(get.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(get.searchParams.get('response-content-type'), 'image/jpeg');
});

test('store head/delete via a stubbed client: 404 → null, other errors propagate', async () => {
  const config = readR2Config(FULL_ENV)!;
  const client = createR2Client(config);
  const sent: string[] = [];
  let mode: 'ok' | '404' | '500' = 'ok';
  (client as any).send = async (cmd: any) => {
    sent.push(cmd.constructor.name);
    if (mode === '404') throw Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    if (mode === '500') throw Object.assign(new Error('boom'), { name: 'InternalError', $metadata: { httpStatusCode: 500 } });
    return { ContentLength: 321, ContentType: 'image/jpeg' };
  };
  const store = createPhotoStore(config, client);
  assert.deepEqual(await store.head('k'), { contentLength: 321, contentType: 'image/jpeg' });
  mode = '404';
  assert.equal(await store.head('k'), null);
  mode = '500';
  await assert.rejects(store.head('k'), /boom/);
  mode = 'ok';
  await store.delete('k');
  assert.deepEqual(sent, ['HeadObjectCommand', 'HeadObjectCommand', 'HeadObjectCommand', 'DeleteObjectCommand']);
});
