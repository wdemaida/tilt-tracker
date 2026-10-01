// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/siteContent.test.ts   (from artifacts/api-server)
//
// The site_content spec, validator, change summary and the public read's fallbacks. No DB is
// dialled: the public read's loader is swapped for a fake.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://unit-test@127.0.0.1:1/never-connected';

const {
  CONTENT_SPEC, CONTENT_KEYS, validateContent, isSafeUrl, changedFields, publicWelcomeContent,
  setPublicContentLoaderForTests, clearPublicContentCache, PUBLIC_CACHE_TTL_MS,
} = await import('./siteContent.js');

const hero = { eyebrow: 'Built by a player', headline: 'Snap your score.\n==See if you are getting better.==', subhead: 'One **photo**.' };

afterEach(() => setPublicContentLoaderForTests(null));

test('the spec covers exactly the welcome sections', () => {
  assert.deepEqual(CONTENT_KEYS, [
    'welcome.hero', 'welcome.how', 'welcome.social', 'welcome.badges', 'welcome.action',
    'welcome.founder', 'welcome.timeline', 'welcome.closing', 'welcome.socials',
  ]);
  for (const key of CONTENT_KEYS) assert.ok(Object.keys(CONTENT_SPEC[key].fields).length > 0, key);
});

test("the frontend's built-in defaults fit the spec (the twins can't drift)", async () => {
  // A variable specifier: the file is outside this package's rootDir, so tsc mustn't try to resolve it.
  const frontendDefaults = '../../../pinball-tracker/src/lib/welcomeContent.ts';
  const { WELCOME_DEFAULTS } = (await import(frontendDefaults)) as { WELCOME_DEFAULTS: Record<string, unknown> };
  assert.deepEqual(Object.keys(WELCOME_DEFAULTS), CONTENT_KEYS, 'same sections, same order');
  for (const [key, value] of Object.entries(WELCOME_DEFAULTS)) {
    const v = validateContent(key, value);
    assert.ok(v.ok, `${key}: ${JSON.stringify((v as any).errors)}`);
    assert.deepEqual((v as any).value, value, `${key} is already normalized`);
  }
});

test('a valid section passes, normalized (trim, CRLF → LF)', () => {
  const v = validateContent('welcome.hero', { ...hero, subhead: '  One **photo**.\r\n\r\nThat is it.  ' });
  assert.ok(v.ok);
  assert.equal((v as any).value.subhead, 'One **photo**.\n\nThat is it.');
  assert.equal((v as any).value.headline, hero.headline, 'inline headings keep their line break');
});

test('plain fields lose line breaks; optional fields may be empty', () => {
  const v = validateContent('welcome.hero', { ...hero, eyebrow: ' Built\n by a player ' });
  assert.ok(v.ok);
  assert.equal((v as any).value.eyebrow, 'Built by a player');
  const empty = validateContent('welcome.hero', { ...hero, eyebrow: '' });
  assert.ok(empty.ok);
  const missing = validateContent('welcome.hero', { headline: hero.headline, subhead: hero.subhead });
  assert.ok(missing.ok, 'a missing optional field is fine');
  assert.equal((missing as any).value.eyebrow, '');
});

test('unknown keys and unknown fields are rejected', () => {
  const k = validateContent('welcome.nope', hero);
  assert.equal(k.ok, false);
  assert.match((k as any).errors._, /Unknown content key/);
  const f = validateContent('welcome.hero', { ...hero, script: 'x' });
  assert.equal(f.ok, false);
  assert.match((f as any).errors.script, /Unknown field/);
  assert.equal(validateContent('welcome.hero', 'a string').ok, false);
  assert.equal(validateContent('welcome.hero', ['a']).ok, false);
});

test('required, too long and wrong type are field errors with paths', () => {
  const v = validateContent('welcome.hero', { ...hero, headline: '   ', subhead: 'x'.repeat(601) });
  assert.equal(v.ok, false);
  const e = (v as any).errors;
  assert.match(e.headline, /required/);
  assert.match(e.subhead, /too long \(601\/600\)/);
  const t = validateContent('welcome.hero', { ...hero, headline: 42 });
  assert.match((t as any).errors.headline, /must be text/);
});

test('lists: item paths, min and max', () => {
  const ok = validateContent('welcome.how', { title: 'How', steps: [{ title: 'Snap', body: 'It.' }] });
  assert.ok(ok.ok);
  const bad = validateContent('welcome.how', { title: 'How', steps: [{ title: 'Snap', body: 'It.' }, { title: 'Two', body: '' }] });
  assert.equal(bad.ok, false);
  assert.match((bad as any).errors['steps.1.body'], /required/);
  const none = validateContent('welcome.how', { title: 'How', steps: [] });
  assert.match((none as any).errors.steps, /at least 1 step$/);
  const many = validateContent('welcome.how', { title: 'How', steps: Array.from({ length: 7 }, () => ({ title: 'a', body: 'b' })) });
  assert.match((many as any).errors.steps, /at most 6/);
  const notList = validateContent('welcome.how', { title: 'How', steps: 'x' });
  assert.match((notList as any).errors.steps, /must be a list/);
  const extra = validateContent('welcome.how', { title: 'How', steps: [{ title: 'a', body: 'b', icon: 'x' }] });
  assert.match((extra as any).errors['steps.0.icon'], /Unknown field/);
  // Socials may have no links yet.
  assert.ok(validateContent('welcome.socials', { title: 'Follow', email: '', links: [] }).ok);
  // A link with no URL yet is allowed — the page shows it as "Soon".
  assert.ok(validateContent('welcome.socials', { title: 'Follow', email: '', links: [{ label: 'Discord', url: '' }] }).ok);
});

test('links: only http, https and mailto — in markdown and in url fields', () => {
  assert.ok(isSafeUrl('https://instagram.com/tilttrack'));
  assert.ok(isSafeUrl('http://example.com'));
  assert.ok(isSafeUrl('mailto:tilttrack@gmail.com'));
  assert.ok(!isSafeUrl('javascript:alert(1)'));
  assert.ok(!isSafeUrl('JavaScript:alert(1)'));
  assert.ok(!isSafeUrl('data:text/html,<script>alert(1)</script>'));
  assert.ok(!isSafeUrl('/relative'));
  assert.ok(!isSafeUrl('https://x.com/"onmouseover="alert(1)'));

  const md = validateContent('welcome.badges', { title: 'Badges', body: 'See [this](javascript:alert(1)).' });
  assert.equal(md.ok, false);
  assert.match((md as any).errors.body, /links must start with/);
  assert.ok(validateContent('welcome.badges', { title: 'Badges', body: 'See [this](https://tilttrack.vercel.app).' }).ok);

  const url = validateContent('welcome.socials', { title: 'Follow', email: '', links: [{ label: 'IG', url: 'javascript:alert(1)' }] });
  assert.match((url as any).errors['links.0.url'], /must start with https/);
  const email = validateContent('welcome.socials', { title: 'Follow', email: 'not an email', links: [] });
  assert.match((email as any).errors.email, /isn't an email/);
});

test('raw HTML is stored as text (the renderer never interprets it), not rejected', () => {
  const v = validateContent('welcome.badges', { title: 'Badges', body: 'I <3 pinball <script>alert(1)</script>' });
  assert.ok(v.ok, 'text is text — the page renders it escaped');
});

test('changedFields lists top-level fields that differ', () => {
  assert.deepEqual(changedFields(null, hero), ['eyebrow', 'headline', 'subhead']);
  assert.deepEqual(changedFields(hero, { ...hero, headline: 'New' }), ['headline']);
  assert.deepEqual(changedFields(hero, hero), []);
});

test('public read: valid rows served, invalid / unknown / non-welcome rows skipped', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    setPublicContentLoaderForTests(async () => [
      { key: 'welcome.hero', value: hero },
      { key: 'welcome.badges', value: { title: '', body: 'x' } }, // invalid now
      { key: 'welcome.gone', value: { a: 1 } }, // a key the spec no longer has
      { key: 'other.thing', value: { a: 1 } },
    ]);
    const out = await publicWelcomeContent(1_000);
    assert.deepEqual(Object.keys(out), ['welcome.hero']);
    assert.equal((out['welcome.hero'] as any).headline, hero.headline);
  } finally { console.error = orig; }
});

test('public read: a DB failure (e.g. the table is missing) serves {} and never throws', async () => {
  const orig = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    setPublicContentLoaderForTests(async () => { throw Object.assign(new Error('relation "site_content" does not exist'), { code: '42P01' }); });
    assert.deepEqual(await publicWelcomeContent(1_000), {});
    assert.equal(logged.length, 1);
  } finally { console.error = orig; }
});

test('public read: cached for the TTL, and a write clears it', async () => {
  let calls = 0;
  setPublicContentLoaderForTests(async () => { calls++; return [{ key: 'welcome.hero', value: hero }]; });
  await publicWelcomeContent(1_000);
  await publicWelcomeContent(1_000 + PUBLIC_CACHE_TTL_MS - 1);
  assert.equal(calls, 1, 'second read inside the TTL is cached');
  await publicWelcomeContent(1_000 + PUBLIC_CACHE_TTL_MS + 1);
  assert.equal(calls, 2, 'expired');
  clearPublicContentCache();
  await publicWelcomeContent(1_000 + PUBLIC_CACHE_TTL_MS + 2);
  assert.equal(calls, 3, 'cleared by a write');
});

test('a failure is cached too (one query a minute, not one per page view)', async () => {
  const orig = console.error;
  console.error = () => {};
  let calls = 0;
  try {
    setPublicContentLoaderForTests(async () => { calls++; throw new Error('down'); });
    await publicWelcomeContent(5_000);
    await publicWelcomeContent(5_001);
    assert.equal(calls, 1);
  } finally { console.error = orig; }
});
