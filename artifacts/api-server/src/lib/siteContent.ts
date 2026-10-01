import { eq, like } from 'drizzle-orm';
import { db, siteContent, users } from '@workspace/db';
import type { Executor } from './activity.js';

// Admin-editable copy for public pages (`site_content`, migrate28). One JSON value per key; the
// defaults live in the frontend (artifacts/pinball-tracker/src/lib/welcomeContent.ts) and a row
// overrides its whole key. No row = the default, so an empty or missing table changes nothing.
//
// THE SHAPES LIVE HERE (CONTENT_SPEC). The admin editor builds its forms from this spec (it's sent
// with GET /api/admin/content), so adding a field means: add it here, add its default in
// welcomeContent.ts, then render it on the page.
//
// Text kinds — the page renders every string as React text, never as HTML, so nothing here can inject
// markup. `markdown` fields allow paragraphs, **bold**, *italic* and [links](https://…); `inline`
// fields (headings) allow ==glow== and line breaks; `plain` is shown as-is. Links must be http(s) or
// mailto — checked here so the editor can say so, and again by the renderer.

export type TextKind = 'plain' | 'inline' | 'markdown' | 'url' | 'email';

export interface TextSpec { type: 'text'; kind: TextKind; label: string; max: number; required: boolean; help?: string }
export interface ListSpec { type: 'list'; label: string; itemLabel: string; min: number; max: number; fields: Record<string, TextSpec> }
export type FieldSpec = TextSpec | ListSpec;
export interface SectionSpec { title: string; help?: string; fields: Record<string, FieldSpec> }

const text = (kind: TextKind, label: string, max: number, required = true, help?: string): TextSpec =>
  ({ type: 'text', kind, label, max, required, ...(help ? { help } : {}) });
const list = (label: string, itemLabel: string, min: number, max: number, fields: Record<string, TextSpec>): ListSpec =>
  ({ type: 'list', label, itemLabel, min, max, fields });

const GLOW_HELP = 'Wrap words in ==double equals== to make them glow. Enter starts a new line.';
const MD_HELP = 'Blank line = new paragraph. **bold**, *italic*, [link text](https://…).';

const EYEBROW = (help?: string) => text('plain', 'Eyebrow (small line above the title)', 60, false, help);

export const CONTENT_SPEC: Readonly<Record<string, SectionSpec>> = {
  'welcome.hero': {
    title: 'Hero',
    help: 'The top of the page.',
    fields: {
      eyebrow: text('plain', 'Eyebrow (small line above the headline)', 80, false, 'Leave empty for none.'),
      headline: text('inline', 'Headline', 120, true, GLOW_HELP),
      subhead: text('markdown', 'Subhead', 600, true, MD_HELP),
    },
  },
  'welcome.how': {
    title: 'How it works',
    fields: {
      tagline: text('plain', 'Tagline (small colored line above the section)', 60, false),
      eyebrow: EYEBROW(),
      title: text('inline', 'Title', 120, true, GLOW_HELP),
      steps: list('Steps', 'Step', 1, 6, {
        title: text('plain', 'Title', 80),
        body: text('markdown', 'Text', 600, true, MD_HELP),
      }),
    },
  },
  'welcome.social': {
    title: 'Play together',
    help: 'Friends and challenges. The two example score cards under the challenge types are illustrations, not copy.',
    fields: {
      eyebrow: EYEBROW(),
      title: text('inline', 'Title', 120, true, GLOW_HELP),
      intro: text('markdown', 'Intro', 800, false, MD_HELP),
      types: list('Challenge type cards', 'Card', 1, 4, {
        kicker: text('plain', 'Kicker (small line above the title)', 40, false),
        title: text('plain', 'Title', 60),
        body: text('markdown', 'Text', 400, true, MD_HELP),
      }),
      also: text('markdown', 'Line under the cards', 300, false, MD_HELP),
      facts: list('Facts panel', 'Fact', 1, 5, {
        title: text('plain', 'Title', 80),
        body: text('markdown', 'Text', 600, true, MD_HELP),
        chips: text('plain', 'Chips (optional)', 200, false, 'Comma-separated. Start one with * to highlight it, e.g. "3 days, *1 week".'),
      }),
    },
  },
  'welcome.badges': {
    title: 'Badges',
    fields: {
      title: text('inline', 'Title', 120, true, GLOW_HELP),
      body: text('markdown', 'Text', 600, true, MD_HELP),
      ladder: text('plain', 'Badge ladder', 200, false, 'Up to four badge names, comma-separated, drawn left to right.'),
    },
  },
  'welcome.action': {
    title: 'See it in action',
    help: 'The video and screenshots section. The video is public/welcome/score-submission.mp4.',
    fields: {
      eyebrow: EYEBROW(),
      title: text('inline', 'Title', 120, true, GLOW_HELP),
      caption: text('markdown', 'Caption', 300, false, MD_HELP),
      shots: list('Screenshots', 'Screenshot', 0, 6, {
        title: text('plain', 'Caption', 60),
        image: text('plain', 'Image file', 80, false, 'A file name in public/welcome/ (e.g. trend.png). Until it exists, an illustration shows.'),
      }),
    },
  },
  'welcome.founder': {
    title: "Founder's note",
    fields: {
      eyebrow: EYEBROW(),
      title: text('inline', 'Title', 120, true, GLOW_HELP),
      body: text('markdown', 'Note', 6000, true, MD_HELP),
      signature: text('plain', 'Signature', 80, false, 'An @handle in it is colored like a username.'),
    },
  },
  'welcome.timeline': {
    title: 'Timeline',
    help: 'Beside the founder’s note, top to bottom. Each stop shows its “When” and title; the text opens on hover or tap. The last stop glows.',
    fields: {
      title: text('plain', 'Heading above the timeline', 80, false),
      hint: text('plain', 'Hint (e.g. "Tap a stop for the story.")', 80, false),
      entries: list('Stops', 'Stop', 1, 12, {
        when: text('plain', 'When', 40),
        title: text('plain', 'Title', 80),
        body: text('markdown', 'Story', 1200, true, MD_HELP),
      }),
    },
  },
  'welcome.closing': {
    title: 'Closing',
    help: 'The sign-up block after the founder’s note.',
    fields: {
      title: text('inline', 'Title', 120, true, GLOW_HELP),
    },
  },
  'welcome.socials': {
    title: 'Socials & contact',
    help: 'The closing strip. A link with no URL yet shows as “Soon”.',
    fields: {
      title: text('inline', 'Title', 120, true, GLOW_HELP),
      intro: text('markdown', 'Text', 300, false, MD_HELP),
      email: text('email', 'Contact email', 120, false),
      links: list('Links', 'Link', 0, 10, {
        label: text('plain', 'Label (e.g. Instagram)', 40),
        url: text('url', 'URL', 300, false, 'Leave empty to show it as “Soon”.'),
      }),
    },
  },
};

export const CONTENT_KEYS = Object.keys(CONTENT_SPEC);
export const WELCOME_PREFIX = 'welcome.';

export function isContentKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTENT_SPEC, key);
}

// ── validation (pure — unit-tested) ─────────────────────────────────────────────

const SAFE_URL = /^(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/i;
const EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
// [label](target) — the target is whatever is inside the parentheses.
const MD_LINK = /\[[^\]\n]*\]\(([^)\n]*)\)/g;

/** Whether a link target is allowed (http, https, mailto). Shared rule with the frontend renderer. */
export function isSafeUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

function checkText(spec: TextSpec, value: unknown, path: string, errors: Record<string, string>): string | undefined {
  if (value == null) value = '';
  if (typeof value !== 'string') { errors[path] = `${spec.label} must be text`; return undefined; }
  const v = value.replace(/\r\n/g, '\n');
  const trimmed = v.trim();
  if (spec.required && !trimmed) { errors[path] = `${spec.label} is required`; return undefined; }
  if (v.length > spec.max) { errors[path] = `${spec.label} is too long (${v.length}/${spec.max})`; return undefined; }
  if (trimmed && spec.kind === 'url' && !isSafeUrl(trimmed)) { errors[path] = `${spec.label} must start with https:// or http://`; return undefined; }
  if (trimmed && spec.kind === 'email' && !EMAIL.test(trimmed)) { errors[path] = `${spec.label} isn't an email address`; return undefined; }
  if (spec.kind === 'markdown') {
    for (const m of v.matchAll(MD_LINK)) {
      if (!isSafeUrl(m[1])) { errors[path] = `${spec.label}: links must start with https://, http:// or mailto: ("${m[1].slice(0, 40)}")`; return undefined; }
    }
  }
  // Single-line kinds keep no line breaks; inline headings may (Enter = new line).
  return spec.kind === 'markdown' || spec.kind === 'inline' ? v.trim() : trimmed.replace(/\s*\n\s*/g, ' ');
}

function checkObject(fields: Record<string, FieldSpec>, value: unknown, path: string, errors: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    errors[path || '_'] = 'Expected an object';
    return out;
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!Object.prototype.hasOwnProperty.call(fields, k)) errors[path ? `${path}.${k}` : k] = `Unknown field "${k}"`;
  }
  for (const [k, spec] of Object.entries(fields)) {
    const p = path ? `${path}.${k}` : k;
    if (spec.type === 'text') {
      const t = checkText(spec, obj[k], p, errors);
      if (t !== undefined) out[k] = t;
    } else {
      const arr = obj[k] ?? [];
      if (!Array.isArray(arr)) { errors[p] = `${spec.label} must be a list`; continue; }
      if (arr.length < spec.min) { errors[p] = `${spec.label} needs at least ${spec.min} ${spec.itemLabel.toLowerCase()}${spec.min === 1 ? '' : 's'}`; continue; }
      if (arr.length > spec.max) { errors[p] = `${spec.label} can have at most ${spec.max}`; continue; }
      out[k] = arr.map((item, i) => checkObject(spec.fields, item, `${p}.${i}`, errors));
    }
  }
  return out;
}

export type ContentValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> };

/** Validates (and normalizes: trims, CRLF → LF) one section's value. Unknown keys and fields fail. */
export function validateContent(key: string, value: unknown): ContentValidation {
  if (!isContentKey(key)) return { ok: false, errors: { _: `Unknown content key "${key}"` } };
  const errors: Record<string, string> = {};
  const out = checkObject(CONTENT_SPEC[key].fields, value, '', errors);
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Top-level fields whose value differs between two stored values (null = the default). Pure. */
export function changedFields(before: unknown, after: unknown): string[] {
  const a = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const b = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort();
}

// ── storage ─────────────────────────────────────────────────────────────────────

export interface StoredContent {
  key: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: { id: number; username: string; displayName: string } | null;
}

/** Every stored row (any key), with who last edited it. Throws on DB errors. */
export async function listStoredContent(ex: Executor = db): Promise<StoredContent[]> {
  const rows = await ex
    .select({
      key: siteContent.key, value: siteContent.value, updatedAt: siteContent.updatedAt,
      byId: users.id, byUsername: users.username, byDisplayName: users.displayName,
    })
    .from(siteContent)
    .leftJoin(users, eq(users.id, siteContent.updatedById));
  return rows.map(r => ({
    key: r.key, value: r.value, updatedAt: r.updatedAt,
    updatedBy: r.byId == null ? null : { id: r.byId, username: r.byUsername!, displayName: r.byDisplayName! },
  }));
}

export async function getStoredContent(key: string, ex: Executor = db): Promise<unknown | null> {
  const [row] = await ex.select({ value: siteContent.value }).from(siteContent).where(eq(siteContent.key, key)).limit(1);
  return row ? row.value : null;
}

export async function saveContent(key: string, value: unknown, byUserId: number, ex: Executor = db): Promise<void> {
  const now = new Date();
  await ex.insert(siteContent)
    .values({ key, value, updatedById: byUserId, updatedAt: now })
    .onConflictDoUpdate({ target: siteContent.key, set: { value, updatedById: byUserId, updatedAt: now } });
}

/** Removes a key's override (back to the default). True when there was one. */
export async function resetContent(key: string, ex: Executor = db): Promise<boolean> {
  const rows = await ex.delete(siteContent).where(eq(siteContent.key, key)).returning({ key: siteContent.key });
  return rows.length > 0;
}

// ── public read (cached) ────────────────────────────────────────────────────────

export const PUBLIC_CACHE_TTL_MS = 60_000;

type PublicLoader = () => Promise<Array<{ key: string; value: unknown }>>;
const defaultLoader: PublicLoader = () =>
  db.select({ key: siteContent.key, value: siteContent.value }).from(siteContent)
    .where(like(siteContent.key, `${WELCOME_PREFIX}%`));
let loader: PublicLoader = defaultLoader;
let cache: { at: number; value: Record<string, unknown> } | null = null;

export function setPublicContentLoaderForTests(fn: PublicLoader | null): void {
  loader = fn ?? defaultLoader;
  cache = null;
}

/** Drop the public cache — called after every write, so this instance serves the edit at once. */
export function clearPublicContentCache(): void {
  cache = null;
}

/**
 * The welcome.* overrides the public page merges over its defaults. NEVER throws: a missing table, a
 * DB error or a malformed row means "no override" for that key (the page just shows its defaults).
 * A row that no longer passes validation (say, the spec tightened) is skipped rather than served.
 */
export async function publicWelcomeContent(now = Date.now()): Promise<Record<string, unknown>> {
  if (cache && now - cache.at < PUBLIC_CACHE_TTL_MS) return cache.value;
  let value: Record<string, unknown> = {};
  try {
    const rows = await loader();
    for (const r of rows) {
      if (!r.key.startsWith(WELCOME_PREFIX)) continue;
      const v = validateContent(r.key, r.value);
      if (v.ok) value[r.key] = v.value;
      else console.error(`[content] skipping stored ${r.key}: no longer valid`, v.errors);
    }
  } catch (err: any) {
    console.error('[content] could not read site_content — serving defaults:', err?.message ?? err);
    value = {};
    // Cache the failure too, so a missing table costs one query a minute, not one per page view.
  }
  cache = { at: now, value };
  return value;
}
