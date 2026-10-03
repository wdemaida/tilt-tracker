// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/announcements.test.ts   (from artifacts/api-server)
//
// Admin announcements — the pure rules: text normalisation, the in-app link validator (open
// redirects, javascript:, protocol-relative and friends), audience parsing, recipient selection
// (disabled users never receive) and the per-recipient payloads. No DB is dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  normalizeTitle, normalizeBody, normalizeAnnouncement, validateInternalPath, substituteLink, parseAudience,
  audienceKey, selectRecipients, buildNotificationItems, isAnnouncementId, parseRequestId,
  TITLE_MAX, BODY_MAX, LINK_MAX, MAX_PICKED, LINK_ROOTS,
} = await import('./announcements.js');

test('title: one line, NFC, whitespace collapsed, controls and bidi overrides stripped', () => {
  assert.equal(normalizeTitle('  New:\n\tLast   Resort  '), 'New: Last Resort');
  assert.equal(normalizeTitle('Café'), 'Café'); // NFC
  assert.equal(normalizeTitle('a‮b​c\u0007d'), 'abcd');
  assert.equal(normalizeTitle('  '), '');
});

test('body: CRLF → LF, 3+ newlines → 2, trailing spaces trimmed, controls stripped, newlines kept', () => {
  assert.equal(normalizeBody('Hi there  \r\n\r\n\r\n\r\nLine 2\r\nLine 3\t!'), 'Hi there\n\nLine 2\nLine 3 !');
  assert.equal(normalizeBody('x\u0000y\u001Bz⁦w⁩'), 'xyzw');
  assert.equal(normalizeBody('\n\n  hello \n\n'), 'hello');
});

test('normalizeAnnouncement: required fields, length caps, link errors reported per field', () => {
  const ok = normalizeAnnouncement({ title: ' Hi ', body: 'Body', link: '' });
  assert.deepEqual(ok, { ok: true, value: { title: 'Hi', body: 'Body', link: null } });
  const bad = normalizeAnnouncement({ title: '   ', body: 'x'.repeat(BODY_MAX + 1), link: 'https://evil.example' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.title);
    assert.ok(bad.errors.body);
    assert.ok(bad.errors.link);
  }
  assert.equal(normalizeAnnouncement({ title: 'x'.repeat(TITLE_MAX), body: 'b' }).ok, true);
  assert.equal(normalizeAnnouncement({ title: 'x'.repeat(TITLE_MAX + 1), body: 'b' }).ok, false);
  assert.equal(normalizeAnnouncement({ title: 'x'.repeat(BODY_MAX), body: 'x'.repeat(BODY_MAX) }).ok, false, 'title cap still applies');
  // Non-strings are missing, not coerced.
  assert.equal(normalizeAnnouncement({ title: 123, body: { a: 1 } }).ok, false);
  // HTML is just text — kept verbatim, rendered as text by the client.
  const html = normalizeAnnouncement({ title: '<b>Hi</b>', body: '<script>alert(1)</script>' });
  assert.ok(html.ok && html.value.body === '<script>alert(1)</script>');
});

test('link: accepted in-app paths', () => {
  for (const good of [
    '/', '/?x=1', '/#top', '/crew', '/crew?tab=challenges', '/users/{username}', '/users/will', '/venues/12',
    '/machines/Medieval%20Madness', '/challenges/new', '/badges', '/stats', '/add', '/welcome', '/notifications',
    '/challenges', '/machines', '/venues',
  ]) {
    const r = validateInternalPath(good);
    assert.deepEqual(r, { ok: true, value: good }, good);
  }
  assert.deepEqual(validateInternalPath(undefined), { ok: true, value: null });
  assert.deepEqual(validateInternalPath(null), { ok: true, value: null });
  assert.deepEqual(validateInternalPath('   '), { ok: true, value: null });
  assert.deepEqual(validateInternalPath('  /crew  '), { ok: true, value: '/crew' }, 'outer whitespace trimmed');
});

test('link: open redirects, schemes and protocol-relative URLs are impossible', () => {
  const evil = [
    'https://evil.example', 'http://evil.example/crew', 'javascript:alert(1)', 'JavaScript:alert(1)',
    ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'mailto:a@b.c',
    '//evil.example', '//evil.example/crew', '///evil.example', '/\\evil.example', '\\\\evil.example',
    '/crew\\..\\..\\evil', '\\/evil.example', '/\t/evil.example', '/\n/evil.example', '/\r/evil.example',
    '/ /evil.example', '/%2F%2Fevil.example', '/%2f/evil.example', '/%5Cevil.example', '/%09/evil.example',
    '/crew%0a', '/users/%2e%2e/%2e%2e/evil', '/users/../../evil', '/./evil', 'crew', 'evil.example',
    '/api/admin/users', '/api', '/API/x', '/admin', '/admin/users', '/sign-in', '/setup', '/unknown',
    '/users/{username', '/users/{id}', '/users/}{', '/crew​', '/crew‮', '/\u0000',
    '/users/%zz', 'x'.repeat(LINK_MAX + 1), '/' + 'a'.repeat(LINK_MAX),
  ];
  for (const link of evil) {
    const r = validateInternalPath(link);
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(link)}`);
  }
  assert.equal(validateInternalPath(42 as unknown).ok, false);
  assert.equal(validateInternalPath({ href: '/' } as unknown).ok, false);
});

test('link: every accepted link stays on the origin once substituted, whatever the username', () => {
  for (const name of ['will', 'a/b', '..', '//evil.example', 'a?b#c', 'x y', '\\evil']) {
    const url = new URL(substituteLink('/users/{username}', name), 'https://tilttrack.invalid');
    assert.equal(url.origin, 'https://tilttrack.invalid', name);
    // ("..": the path collapses to "/", still on the origin. Usernames are [a-z0-9_] anyway.)
    if (name !== '..') assert.ok(url.pathname.startsWith('/users/'), name);
  }
  assert.equal(substituteLink('/users/{username}?x={username}', 'a b'), '/users/a%20b?x=a%20b');
});

test('the link roots are the app routes (no admin, api, setup or sign-in)', () => {
  assert.deepEqual([...LINK_ROOTS].sort(), ['', 'add', 'badges', 'challenges', 'crew', 'machines', 'notifications', 'stats', 'users', 'venues', 'welcome']);
});

test('audience: all, picked ids deduped, junk refused, capped at MAX_PICKED', () => {
  assert.deepEqual(parseAudience({ audience: 'all', userIds: [1] }), { ok: true, value: { audience: 'all' } });
  assert.deepEqual(parseAudience({ audience: 'users', userIds: [3, '2', 3, 1] }), { ok: true, value: { audience: 'users', userIds: [3, 2, 1] } });
  for (const bad of [
    {}, { audience: 'everyone' }, { audience: 'users' }, { audience: 'users', userIds: [] },
    { audience: 'users', userIds: [0] }, { audience: 'users', userIds: [-1] }, { audience: 'users', userIds: [1.5] },
    { audience: 'users', userIds: ['1; drop'] }, { audience: 'users', userIds: [null] }, { audience: 'users', userIds: '1,2' },
  ]) assert.equal(parseAudience(bad as any).ok, false, JSON.stringify(bad));
  const many = Array.from({ length: MAX_PICKED + 1 }, (_, i) => i + 1);
  const r = parseAudience({ audience: 'users', userIds: many });
  assert.ok(!r.ok && r.code === 'too_many_recipients');
  assert.equal(parseAudience({ audience: 'users', userIds: many.slice(0, MAX_PICKED) }).ok, true);
});

test('audienceKey: order-insensitive for picked users, distinct from all', () => {
  assert.equal(audienceKey({ audience: 'all' }), 'all');
  assert.equal(audienceKey({ audience: 'users', userIds: [3, 1, 2] }), audienceKey({ audience: 'users', userIds: [1, 2, 3] }));
  assert.notEqual(audienceKey({ audience: 'users', userIds: [1, 2] }), audienceKey({ audience: 'users', userIds: [1, 2, 3] }));
});

const ROWS = [
  { id: 1, username: 'will', displayName: 'Will', disabledAt: null },
  { id: 2, username: 'gone', displayName: 'Gone', disabledAt: new Date() },
  { id: 3, username: 'stars', displayName: 'Stars', disabledAt: null },
  { id: 4, username: 'banned', displayName: 'Banned', disabledAt: '2026-10-01T00:00:00Z' },
];

test('recipients: disabled users never receive — all audience', () => {
  const { recipients, skipped } = selectRecipients({ audience: 'all' }, ROWS);
  assert.deepEqual(recipients.map(r => r.id), [1, 3]);
  assert.deepEqual(skipped, []);
  assert.ok(!recipients.some(r => 'disabledAt' in r), 'refs carry no disabled flag or other columns');
});

test('recipients: picked disabled and unknown users are skipped and reported', () => {
  const { recipients, skipped } = selectRecipients({ audience: 'users', userIds: [3, 2, 99, 1, 4] }, ROWS);
  assert.deepEqual(recipients.map(r => r.id), [3, 1]);
  assert.deepEqual(skipped, [
    { id: 2, username: 'gone', reason: 'disabled' },
    { id: 99, username: null, reason: 'unknown' },
    { id: 4, username: 'banned', reason: 'disabled' },
  ]);
});

test('payloads: one per recipient, signed TiltTrack, {username} substituted, no sender identity', () => {
  const items = buildNotificationItems('11111111-2222-4333-8444-555555555555', { title: 'T', body: 'B', link: '/users/{username}' }, [
    { id: 1, username: 'will', displayName: 'Will' }, { id: 3, username: 'stars', displayName: 'Stars' },
  ]);
  assert.deepEqual(items, [
    { userId: 1, payload: { announcementId: '11111111-2222-4333-8444-555555555555', title: 'T', body: 'B', link: '/users/will', from: 'TiltTrack' } },
    { userId: 3, payload: { announcementId: '11111111-2222-4333-8444-555555555555', title: 'T', body: 'B', link: '/users/stars', from: 'TiltTrack' } },
  ]);
  const noLink = buildNotificationItems('x', { title: 'T', body: 'B', link: null }, [{ id: 1, username: 'will', displayName: 'Will' }]);
  assert.equal(noLink[0].payload.link, null);
});

test('ids: announcement uuid and request id formats', () => {
  assert.ok(isAnnouncementId('11111111-2222-4333-8444-555555555555'));
  assert.ok(!isAnnouncementId('1'));
  assert.ok(!isAnnouncementId("11111111-2222-4333-8444-555555555555' OR 1=1"));
  assert.equal(parseRequestId('abcDEF12-_'), 'abcDEF12-_');
  assert.equal(parseRequestId('short'), null);
  assert.equal(parseRequestId('has space here'), null);
  assert.equal(parseRequestId(12345678), null);
});
