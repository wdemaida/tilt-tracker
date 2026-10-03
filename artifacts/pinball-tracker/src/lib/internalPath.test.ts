// Run: npx tsx --test src/lib/internalPath.test.ts   (from artifacts/pinball-tracker)
//
// The announcement link check: in-app paths pass; anything that could navigate off the app —
// schemes, protocol-relative URLs, backslashes, smuggled whitespace, encoded slashes — fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalPath, LINK_ROOTS } from './internalPath';

test('in-app paths pass', () => {
  for (const ok of ['/', '/?x=1', '/#top', '/crew', '/crew?tab=challenges', '/users/will', '/venues/12', '/machines/Medieval%20Madness', '/challenges/new', '/badges', '/stats', '/add', '/welcome', '/notifications']) {
    assert.equal(isInternalPath(ok), true, ok);
  }
});

test('anything that could leave the app fails', () => {
  for (const bad of [
    '', 'https://evil.example', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.example',
    '///evil.example', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', '/\n/evil.example', ' /crew',
    '/%2F%2Fevil.example', '/%5Cevil', '/%09/x', '/users/%2e%2e/x', '/users/../x', '/api/admin', '/admin', '/sign-in',
    '/users/{username}', '/crew‮', 'crew', '/users/%zz', `/${'a'.repeat(250)}`,
  ]) {
    assert.equal(isInternalPath(bad), false, JSON.stringify(bad));
  }
  assert.equal(isInternalPath(null), false);
  assert.equal(isInternalPath(42), false);
  assert.equal(isInternalPath({}), false);
});

test("the roots match the server's (LINK_ROOTS in api-server announcements.ts)", async () => {
  // A variable specifier: the file is outside this package, so tsc mustn't try to resolve it.
  const server = '../../../api-server/src/lib/announcements.ts';
  process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';
  try {
    const mod = (await import(server)) as { LINK_ROOTS: readonly string[]; validateInternalPath: (l: unknown) => { ok: boolean } };
    assert.deepEqual([...LINK_ROOTS].sort(), [...mod.LINK_ROOTS].sort());
    for (const l of ['/crew', '/', '//evil.example', '/\\x', 'javascript:x', '/api/x', '/users/%2e%2e', '/admin']) {
      assert.equal(isInternalPath(l), mod.validateInternalPath(l).ok, l);
    }
  } catch (err: any) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return; // api-server deps not installed — the local cases above still ran
    throw err;
  }
});
