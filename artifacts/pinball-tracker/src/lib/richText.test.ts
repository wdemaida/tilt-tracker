// Run: npx tsx --tsconfig tsconfig.app.json --test src/lib/richText.test.ts   (from artifacts/pinball-tracker)
// (--tsconfig: the root tsconfig.json only holds project references, so without it tsx compiles the
// component's JSX for the classic runtime and React isn't in scope.)
//
// The restricted markdown for admin-edited copy: parsing, and — through the real React renderer —
// that stored text can never become markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseBlocks, parseInline, plainText, isSafeUrl } from './richText.ts';
import { RichText, InlineText } from '../components/RichText.tsx';

const html = (text: string) => renderToStaticMarkup(createElement(RichText, { text }));
const inline = (text: string) => renderToStaticMarkup(createElement(InlineText, { text }));

test('plain text is one text token', () => {
  assert.deepEqual(parseInline('Just text.'), [{ t: 'text', v: 'Just text.' }]);
});

test('bold, italic and links', () => {
  assert.deepEqual(parseInline('a **b** c'), [{ t: 'text', v: 'a ' }, { t: 'b', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }]);
  assert.deepEqual(parseInline('*it*'), [{ t: 'i', c: [{ t: 'text', v: 'it' }] }]);
  assert.deepEqual(parseInline('**bold *and it*!**'), [
    { t: 'b', c: [{ t: 'text', v: 'bold ' }, { t: 'i', c: [{ t: 'text', v: 'and it' }] }, { t: 'text', v: '!' }] },
  ]);
  assert.deepEqual(parseInline('see [Pinball Map](https://pinballmap.com).'), [
    { t: 'text', v: 'see ' },
    { t: 'a', href: 'https://pinballmap.com', c: [{ t: 'text', v: 'Pinball Map' }] },
    { t: 'text', v: '.' },
  ]);
  assert.deepEqual(parseInline('[mail](mailto:tilttrack@gmail.com)')[0], { t: 'a', href: 'mailto:tilttrack@gmail.com', c: [{ t: 'text', v: 'mail' }] });
});

test('unmatched markers stay literal', () => {
  assert.equal(plainText(parseInline('2 * 3 = 6, and ** alone')), '2 * 3 = 6, and ** alone');
  assert.equal(plainText(parseInline('a == b')), 'a == b');
});

test('glow only where allowed (headings)', () => {
  assert.deepEqual(parseInline('It started in a ==barn.==', { glow: true })[1], { t: 'glow', c: [{ t: 'text', v: 'barn.' }] });
  assert.equal(plainText(parseInline('==x==')), '==x==', 'body text has no glow');
});

test('line breaks and paragraphs', () => {
  assert.deepEqual(parseInline('one\ntwo'), [{ t: 'text', v: 'one' }, { t: 'br' }, { t: 'text', v: 'two' }]);
  const blocks = parseBlocks('First.\r\n\r\n  Second **para**.\n\n\n');
  assert.equal(blocks.length, 2);
  assert.equal(plainText(blocks[1]), 'Second para.');
  assert.deepEqual(parseBlocks('   \n\n  '), []);
});

test('unsafe link targets become plain labels', () => {
  for (const href of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hi', 'vbscript:x', '/relative', '']) {
    const toks = parseInline(`[click](${href})`);
    assert.ok(!toks.some(t => t.t === 'a'), href);
    const text = plainText(toks);
    assert.ok(text.startsWith('click'), `${href} → ${text}`);
    assert.ok(!/javascript|data:|vbscript/i.test(text), `the target is dropped: ${text}`);
  }
  assert.ok(isSafeUrl('https://x.com'));
  assert.ok(!isSafeUrl('https://x.com/"onmouseover="alert(1)'));
});

test('rendered: raw HTML and <script> are escaped text, never elements', () => {
  const out = html('Hi <script>alert(1)</script> <img src=x onerror=alert(1)> <b>not bold</b>');
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(!out.includes('<b>'), out);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), out);
  assert.ok(out.includes('&lt;b&gt;not bold&lt;/b&gt;'), out);
});

test('rendered: a javascript: link never becomes an href', () => {
  const out = html('[x](javascript:alert(1)) and [y](https://ok.example)');
  assert.ok(!/href="javascript/i.test(out), out);
  assert.ok(out.includes('href="https://ok.example"'), out);
  assert.ok(out.includes('rel="noopener noreferrer nofollow"'), out);
  assert.ok(out.includes('target="_blank"'), out);
});

test('rendered: a quote in a link label or text cannot break out of an attribute', () => {
  const out = html('[a" onclick="alert(1)](https://ok.example) "quoted"');
  assert.ok(!out.includes('onclick="alert'), out);
});

test('rendered: paragraphs, bold and glow', () => {
  assert.equal(html('One.\n\nTwo **b**.'), '<div><p>One.</p><p>Two <strong class="font-semibold text-foreground">b</strong>.</p></div>');
  assert.equal(inline('Snap.\n==Get better.=='), 'Snap.<br/><span class="text-glow-primary">Get better.</span>');
});
