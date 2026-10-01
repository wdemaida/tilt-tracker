import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  useAdminApi, type ContentFieldSpec, type ContentListSpec, type ContentSection, type ContentTextSpec,
} from '../../lib/adminApi';
import { WELCOME_DEFAULTS, mergeWelcomeContent, type WelcomeKey } from '../../lib/welcomeContent';
import { WELCOME_CONTENT_QUERY_KEY } from '../../lib/useWelcomeContent';
import { InlineText, RichText } from '../RichText';
import { ConfirmDialog, ErrorNote, Pill, When, Who } from './AdminParts';
import IconPicker from './IconPicker';
import { WELCOME_ICONS, WELCOME_ICON_NAMES } from '../welcome/welcomeIcons';

// Admin > Config > Welcome page: edit the /welcome page's copy, one section at a time. The form is
// built from the server's spec (CONTENT_SPEC in api-server src/lib/siteContent.ts); the defaults are
// lib/welcomeContent.ts. Saving stores an override for that section (site_content) and the page picks
// it up within a minute; "Reset to default" deletes the override.

type Draft = Record<string, unknown>;
type Errors = Record<string, string>;

const inputCls = 'w-full border rounded-lg px-3 py-2 text-sm text-white bg-white/5 focus:outline-none focus:ring-2 focus:ring-primary';
const iconBtn = 'p-1.5 rounded-md text-muted-foreground hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors';

/** What the page shows for a section right now: the stored override laid over the default. */
function effectiveValue(section: ContentSection): Draft {
  const key = section.key as WelcomeKey;
  const merged = mergeWelcomeContent(section.value ? { [key]: section.value } : {});
  return structuredClone(merged[key] ?? {}) as Draft;
}

function defaultValue(key: string): Draft {
  return structuredClone((WELCOME_DEFAULTS as unknown as Record<string, unknown>)[key] ?? {}) as Draft;
}

function blankItem(spec: ContentListSpec): Draft {
  return Object.fromEntries(Object.keys(spec.fields).map(k => [k, '']));
}

/** Quick client-side checks (required, length) so the obvious mistakes show before a round trip. */
function localErrors(fields: Record<string, ContentFieldSpec>, value: Draft, path = ''): Errors {
  const out: Errors = {};
  for (const [k, spec] of Object.entries(fields)) {
    const p = path ? `${path}.${k}` : k;
    if (spec.type === 'text') {
      const v = typeof value[k] === 'string' ? (value[k] as string) : '';
      if (spec.required && !v.trim()) out[p] = `${spec.label} is required`;
      else if (v.length > spec.max) out[p] = `${spec.label} is too long (${v.length}/${spec.max})`;
    } else {
      const items = Array.isArray(value[k]) ? (value[k] as Draft[]) : [];
      if (items.length < spec.min) out[p] = `${spec.label} needs at least ${spec.min}`;
      items.forEach((item, i) => Object.assign(out, localErrors(spec.fields, item, `${p}.${i}`)));
    }
  }
  return out;
}

function IconField({ spec, value, onChange, error }: {
  spec: ContentTextSpec; value: string; onChange: (v: string) => void; error?: string;
}) {
  // A div, not a label: the picker is a button plus a popover, and a label would forward clicks to it.
  return (
    <div>
      <span className="text-xs font-bold text-white">
        {spec.label}{spec.required ? '' : <span className="font-normal text-muted-foreground"> (optional)</span>}
      </span>
      <div className="mt-1">
        <IconPicker
          value={value} onChange={onChange} color="hsl(var(--primary))"
          icons={WELCOME_ICONS} names={WELCOME_ICON_NAMES} fallback={WELCOME_ICONS['circle-dot']}
          emptyLabel="Default for this position" footnote="pinball is the app's flipper icon."
        />
      </div>
      {error ? <p className="text-[11px] text-red-400 mt-1">{error}</p>
        : spec.help ? <p className="text-[11px] text-muted-foreground mt-1">{spec.help}</p> : null}
    </div>
  );
}

function TextField({ spec, value, onChange, error }: {
  spec: ContentTextSpec; value: string; onChange: (v: string) => void; error?: string;
}) {
  if (spec.kind === 'icon') return <IconField spec={spec} value={value} onChange={onChange} error={error} />;
  const multiline = spec.kind === 'markdown' || spec.kind === 'inline';
  const rows = spec.kind === 'inline' ? 2 : Math.min(12, Math.max(3, Math.ceil(spec.max / 150)));
  const over = value.length > spec.max;
  const cls = `${inputCls} ${error ? 'border-red-500/60' : 'border-white/20'}`;
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-bold text-white">
          {spec.label}{spec.required ? '' : <span className="font-normal text-muted-foreground"> (optional)</span>}
        </span>
        <span className={`text-[11px] tabular-nums ${over ? 'text-red-400' : 'text-muted-foreground'}`}>{value.length}/{spec.max}</span>
      </span>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows} aria-invalid={!!error} className={`${cls} mt-1 resize-y leading-relaxed`} />
      ) : (
        <input
          type={spec.kind === 'email' ? 'email' : spec.kind === 'url' ? 'url' : 'text'}
          value={value} onChange={e => onChange(e.target.value)} aria-invalid={!!error} className={`${cls} mt-1`}
        />
      )}
      {error ? <p className="text-[11px] text-red-400 mt-1">{error}</p>
        : spec.help ? <p className="text-[11px] text-muted-foreground mt-1">{spec.help}</p> : null}
    </label>
  );
}

function ListField({ spec, items, onChange, errors, path }: {
  spec: ContentListSpec; items: Draft[]; onChange: (items: Draft[]) => void; errors: Errors; path: string;
}) {
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-xs font-bold text-white">{spec.label}</span>
        <span className="text-[11px] text-muted-foreground">{items.length} of up to {spec.max}</span>
      </div>
      {errors[path] && <p className="text-[11px] text-red-400 mb-2">{errors[path]}</p>}
      <ol className="space-y-3">
        {items.map((item, i) => (
          <li key={i} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{spec.itemLabel} {i + 1}</span>
              <span className="flex items-center gap-0.5">
                <button type="button" className={iconBtn} onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${spec.itemLabel.toLowerCase()} ${i + 1} up`}>
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button type="button" className={iconBtn} onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={`Move ${spec.itemLabel.toLowerCase()} ${i + 1} down`}>
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <button type="button" className={iconBtn} onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={items.length <= spec.min} aria-label={`Remove ${spec.itemLabel.toLowerCase()} ${i + 1}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </span>
            </div>
            <div className="space-y-3">
              {Object.entries(spec.fields).map(([k, f]) => (
                <TextField
                  key={k} spec={f}
                  value={typeof item[k] === 'string' ? (item[k] as string) : ''}
                  onChange={v => onChange(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)))}
                  error={errors[`${path}.${i}.${k}`]}
                />
              ))}
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => onChange([...items, blankItem(spec)])}
        disabled={items.length >= spec.max}
        className="mt-3 flex items-center gap-1.5 text-xs font-bold text-primary hover:text-white disabled:opacity-40 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" /> Add {spec.itemLabel.toLowerCase()}
      </button>
    </div>
  );
}

/** The section rendered with the page's own renderer — a rough preview, not the page layout. */
function Preview({ fields, value }: { fields: Record<string, ContentFieldSpec>; value: Draft }) {
  const text = (spec: ContentTextSpec, v: string, key: string) => {
    if (!v.trim()) return null;
    if (spec.kind === 'inline') return <h3 key={key} className="font-display uppercase font-black tracking-tight text-2xl leading-tight"><InlineText text={v} /></h3>;
    if (spec.kind === 'markdown') return <RichText key={key} text={v} className="space-y-2.5 text-sm leading-relaxed text-muted-foreground" />;
    if (spec.kind === 'url') return <p key={key} className="text-xs text-primary break-all">{v}</p>;
    return <p key={key} className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{v}</p>;
  };
  return (
    <div className="space-y-3">
      {Object.entries(fields).map(([k, spec]) => {
        if (spec.type === 'text') return text(spec, typeof value[k] === 'string' ? (value[k] as string) : '', k);
        const items = Array.isArray(value[k]) ? (value[k] as Draft[]) : [];
        return (
          <div key={k} className="grid gap-2.5">
            {items.map((item, i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-background/60 p-3.5 space-y-1.5">
                {Object.entries(spec.fields).map(([fk, fs]) => {
                  const v = typeof item[fk] === 'string' ? (item[fk] as string) : '';
                  if (!v.trim()) return null;
                  if (fs.kind === 'icon') {
                    const Icon = WELCOME_ICONS[v];
                    return Icon ? (
                      <span key={fk} className="inline-flex w-9 h-9 rounded-lg border border-primary/45 bg-primary/15 items-center justify-center">
                        <Icon className="w-4 h-4 text-primary" />
                      </span>
                    ) : null;
                  }
                  if (fs.kind === 'markdown') return <RichText key={fk} text={v} className="space-y-2 text-sm leading-relaxed text-muted-foreground" />;
                  if (fk === 'title' || fk === 'label') return <p key={fk} className="font-bold text-white text-sm">{v}</p>;
                  return <p key={fk} className={`text-xs ${fs.kind === 'url' ? 'text-primary break-all' : 'font-extrabold uppercase tracking-[0.14em] text-machine'}`}>{v}</p>;
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SectionEditor({ section }: { section: ContentSection }) {
  const admin = useAdminApi();
  const qc = useQueryClient();
  const saved = useMemo(() => effectiveValue(section), [section]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => { setDraft(saved); setServerErrors({}); }, [saved]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const errors = { ...localErrors(section.spec.fields, draft), ...serverErrors };
  const valid = Object.keys(localErrors(section.spec.fields, draft)).length === 0;

  const applySaved = (patch: Partial<ContentSection>) => {
    qc.setQueryData<{ sections: ContentSection[] }>(['admin', 'content'], old =>
      old ? { sections: old.sections.map(s => (s.key === section.key ? { ...s, ...patch } : s)) } : old);
    qc.invalidateQueries({ queryKey: WELCOME_CONTENT_QUERY_KEY });
  };

  const save = useMutation({
    mutationFn: () => admin.saveSiteContent(section.key, draft),
    onMutate: () => setServerErrors({}),
    onSuccess: res => applySaved({ value: res.value, updatedAt: res.updatedAt, updatedBy: res.updatedBy }),
    onError: (err: any) => { if (err?.body?.errors) setServerErrors(err.body.errors); },
  });

  const set = (k: string, v: unknown) => { setDraft(d => ({ ...d, [k]: v })); setServerErrors({}); };

  return (
    <div className="rounded-xl border border-white/10 bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <div>
          <h3 className="text-base font-black uppercase tracking-wider text-white">{section.spec.title}</h3>
          {section.spec.help && <p className="text-xs text-muted-foreground mt-0.5">{section.spec.help}</p>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {section.value
            ? <><Pill tone="primary">Edited</Pill><span>by <Who user={section.updatedBy} fallback="someone" />, <When at={section.updatedAt} /></span></>
            : <Pill>Showing the default</Pill>}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4 min-w-0">
          {Object.entries(section.spec.fields).map(([k, spec]) =>
            spec.type === 'text' ? (
              <TextField key={k} spec={spec} value={typeof draft[k] === 'string' ? (draft[k] as string) : ''} onChange={v => set(k, v)} error={errors[k]} />
            ) : (
              <ListField key={k} spec={spec} path={k} errors={errors} items={Array.isArray(draft[k]) ? (draft[k] as Draft[]) : []} onChange={items => set(k, items)} />
            ))}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Preview</p>
          <div className="rounded-xl border border-white/10 bg-background p-4 sm:p-5">
            <Preview fields={section.spec.fields} value={draft} />
          </div>
        </div>
      </div>

      {save.error && !(save.error as any)?.body?.errors && <div className="mt-4"><ErrorNote error={save.error} /></div>}
      {Object.keys(serverErrors).length > 0 && (
        <p className="mt-4 text-sm text-red-400">Not saved — fix the highlighted field{Object.keys(serverErrors).length === 1 ? '' : 's'}.</p>
      )}

      <div className="mt-5 pt-4 border-t border-white/10 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!dirty || !valid || save.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-bold disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
        </button>
        {dirty && (
          <button type="button" onClick={() => { setDraft(saved); setServerErrors({}); }} className="text-sm text-muted-foreground hover:text-white transition-colors">
            Discard changes
          </button>
        )}
        <span className="flex-1" />
        {section.value ? (
          <button type="button" onClick={() => setConfirmReset(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white transition-colors">
            <RotateCcw className="w-3 h-3" /> Reset to default
          </button>
        ) : dirty ? null : (
          <span className="text-[11px] text-muted-foreground">Edit and save to override the default.</span>
        )}
      </div>

      {confirmReset && (
        <ConfirmDialog
          title={`Reset “${section.spec.title}” to the default?`}
          body={<p>The saved edit is deleted and the page goes back to the built-in copy. This can’t be undone (the activity log records that it happened, not the text).</p>}
          confirmLabel="Reset to default"
          onConfirm={async () => {
            const res = await admin.resetSiteContent(section.key);
            applySaved({ value: null, updatedAt: res.updatedAt, updatedBy: res.updatedBy });
            setDraft(defaultValue(section.key));
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}

export function WelcomeContentCard() {
  const admin = useAdminApi();
  const { data, error, isLoading } = useQuery({ queryKey: ['admin', 'content'], queryFn: admin.siteContent });
  const [active, setActive] = useState<string | null>(null);

  if (isLoading || !data) {
    const unavailable = (error as any)?.code === 'content_unavailable';
    return (
      <div className="rounded-xl border border-white/10 bg-card p-4 sm:p-6">
        <h3 className="text-base font-black uppercase tracking-wider text-white">Welcome page</h3>
        {unavailable
          ? <p className="text-sm text-amber-300 mt-2">The editor needs the site_content table (migrate28). The page still shows its built-in copy.</p>
          : <ErrorNote error={error} />}
        {!error && <p className="text-sm text-muted-foreground mt-2">Loading…</p>}
      </div>
    );
  }

  const section = data.sections.find(s => s.key === active) ?? data.sections[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground max-w-[70ch]">
          The copy on the public <span className="text-white">/welcome</span> page. Each section starts with its built-in text;
          saving stores your version, and the live page picks it up within a minute.
        </p>
        <a href="/welcome" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:text-white transition-colors">
          Open /welcome <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Welcome page sections">
        {data.sections.map(s => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={s.key === section.key}
            onClick={() => setActive(s.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
              s.key === section.key ? 'bg-primary text-white border-primary' : 'border-white/15 text-muted-foreground hover:text-white hover:border-white/40'
            }`}
          >
            {s.spec.title}{s.value ? <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-current align-middle" aria-label="edited" /> : null}
          </button>
        ))}
      </div>
      <SectionEditor key={section.key} section={section} />
    </div>
  );
}
