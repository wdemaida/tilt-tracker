// The restricted markdown that admin-edited page copy is written in (site_content — see api-server
// src/lib/siteContent.ts, which validates it). Parsed into a small tree that RichText.tsx renders as
// React elements — never through innerHTML — so stored text can't inject markup: `<script>` is just
// text. Supported: paragraphs (blank line), line breaks, **bold**, *italic*, [links](https://…) and,
// in headings, ==glow==. A link whose target isn't http(s) or mailto is shown as its plain label.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'glow'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] };

export interface ParseOptions {
  /** Allow ==glow== (headings). */
  glow?: boolean;
  /** Internal: already inside a link's label. */
  inLink?: boolean;
}

// Twin of isSafeUrl in api-server src/lib/siteContent.ts — keep the two in step.
const SAFE_URL = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;

export function isSafeUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

type Kind = 'a' | 'b' | 'glow' | 'i';
const PATTERNS: Array<{ kind: Kind; re: RegExp }> = [
  { kind: 'a', re: /\[([^\]\n]+)\]\(([^)\s]*)\)/ },
  { kind: 'b', re: /\*\*(?=\S)([\s\S]*?\S)\*\*/ },
  { kind: 'glow', re: /==(?=\S)([\s\S]*?\S)==/ },
  { kind: 'i', re: /\*(?=[^\s*])([^*]*?[^\s*])\*/ },
];

function pushText(out: Inline[], s: string) {
  if (!s) return;
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'br' });
    if (!line) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.v += line;
    else out.push({ t: 'text', v: line });
  });
}

/** One run of inline text → tokens. Pure — unit-tested. */
export function parseInline(src: string, opts: ParseOptions = {}): Inline[] {
  const out: Inline[] = [];
  let rest = src.replace(/\r\n?/g, '\n');
  while (rest) {
    let best: { kind: Kind; m: RegExpExecArray } | null = null;
    for (const p of PATTERNS) {
      if (p.kind === 'glow' && !opts.glow) continue;
      if (p.kind === 'a' && opts.inLink) continue;
      const m = p.re.exec(rest);
      // Earliest match wins; on a tie the pattern listed first does (so ** beats *).
      if (m && (!best || m.index < best.m.index)) best = { kind: p.kind, m };
    }
    if (!best) { pushText(out, rest); break; }
    const { kind, m } = best;
    pushText(out, rest.slice(0, m.index));
    if (kind === 'a') {
      const label = parseInline(m[1], { ...opts, inLink: true });
      if (isSafeUrl(m[2])) out.push({ t: 'a', href: m[2].trim(), c: label });
      else out.push(...label);
    } else {
      out.push({ t: kind, c: parseInline(m[1], opts) });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Paragraphs (split on blank lines), each a run of inline tokens. Pure — unit-tested. */
export function parseBlocks(src: string, opts: ParseOptions = {}): Inline[][] {
  return src
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => parseInline(p, opts));
}

/** The text with all formatting removed — for alt text, titles and tests. */
export function plainText(tokens: Inline[]): string {
  return tokens.map(t => (t.t === 'text' ? t.v : t.t === 'br' ? '\n' : plainText(t.c))).join('');
}
