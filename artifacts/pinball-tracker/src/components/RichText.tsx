import { Fragment, type ReactNode } from 'react';
import { parseBlocks, parseInline, type Inline } from '../lib/richText';

// Renders admin-edited copy (lib/richText.ts). Everything becomes React elements and text nodes —
// there is no dangerouslySetInnerHTML anywhere on this path, so stored text can't inject markup.

function renderInline(tokens: Inline[], keyPrefix = ''): ReactNode[] {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}${i}`;
    switch (tok.t) {
      case 'text': return <Fragment key={key}>{tok.v}</Fragment>;
      case 'br': return <br key={key} />;
      case 'b': return <strong key={key} className="font-semibold text-foreground">{renderInline(tok.c, `${key}.`)}</strong>;
      case 'i': return <em key={key}>{renderInline(tok.c, `${key}.`)}</em>;
      case 'glow': return <span key={key} className="text-glow-primary">{renderInline(tok.c, `${key}.`)}</span>;
      case 'a': {
        const external = !tok.href.toLowerCase().startsWith('mailto:');
        return (
          <a
            key={key}
            href={tok.href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}
            className="underline underline-offset-2 text-white hover:text-primary transition-colors"
          >
            {renderInline(tok.c, `${key}.`)}
          </a>
        );
      }
    }
  });
}

/** Markdown-ish body copy: one <p> per paragraph. */
export function RichText({ text, className, paragraphClassName }: { text: string; className?: string; paragraphClassName?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className}>
      {blocks.map((b, i) => <p key={i} className={paragraphClassName}>{renderInline(b, `${i}.`)}</p>)}
    </div>
  );
}

/** A heading's text: line breaks, ==glow==, **bold** and *italic*; no wrapper element. */
export function InlineText({ text }: { text: string }) {
  return <>{renderInline(parseInline(text.trim(), { glow: true }))}</>;
}
