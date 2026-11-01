import type { ReactNode } from 'react';

/**
 * The read side of a document body (DOC-02 read view, Figma 77:345): the Markdown the editor's
 * toolbar and "/" menu write — headings, paragraphs, bulleted and checklist items, numbered items,
 * **bold**, _italic_ and [links](https://…) — drawn as real headings, lists and links.
 *
 * Safe by construction: the body is split into React elements (React escapes every string), no HTML
 * is ever parsed, and a link is only a link when its address is http(s), mailto or a same-site path
 * ("/acme/work/…"); anything else (javascript:, data:, "//host") stays plain text.
 */

type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  | { readonly kind: 'numbers'; readonly items: readonly string[] }
  | {
      readonly kind: 'checklist';
      readonly items: readonly { readonly done: boolean; readonly text: string }[];
    };

const HEADING = /^(#{1,3})\s+(.*)$/u;
const CHECK = /^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/u;
const BULLET = /^\s*[-*•]\s+(.*)$/u;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/u;

/** Split a body into blocks; blank lines end a paragraph or list. */
export function parseDocBlocks(body: string): readonly Block[] {
  const blocks: Block[] = [];
  for (const raw of body.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    const last = blocks[blocks.length - 1];
    if (line.trim() === '') {
      blocks.push({ kind: 'paragraph', text: '' });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: heading[2] ?? '' });
      continue;
    }
    const check = CHECK.exec(line);
    if (check) {
      const item = { done: (check[1] ?? ' ').toLowerCase() === 'x', text: check[2] ?? '' };
      if (last?.kind === 'checklist') (last.items as { done: boolean; text: string }[]).push(item);
      else blocks.push({ kind: 'checklist', items: [item] });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (last?.kind === 'bullets') (last.items as string[]).push(bullet[1] ?? '');
      else blocks.push({ kind: 'bullets', items: [bullet[1] ?? ''] });
      continue;
    }
    const number = NUMBER.exec(line);
    if (number) {
      if (last?.kind === 'numbers') (last.items as string[]).push(number[1] ?? '');
      else blocks.push({ kind: 'numbers', items: [number[1] ?? ''] });
      continue;
    }
    // Each author line is its own paragraph, as before: line breaks stay where they were typed.
    blocks.push({ kind: 'paragraph', text: line });
  }
  return blocks.filter((block) => block.kind !== 'paragraph' || block.text !== '');
}

/** The addresses a link may open. */
export function safeHref(address: string): string | null {
  const href = address.trim();
  if (/^https?:\/\/[^\s]+$/iu.test(href) && href.length > 'https://'.length) {
    // "https://" alone is the toolbar's empty template, not a link yet.
    return /^https?:\/\/$/iu.test(href) ? null : href;
  }
  if (/^mailto:[^\s]+$/iu.test(href)) return href;
  if (/^\/(?!\/)[^\s]*$/u.test(href)) return href;
  return null;
}

// [label](address) | **bold** | __bold__ | _italic_ | *italic* | bare https://… address
const INLINE =
  /\[([^\]]+)\]\(([^)\s]*)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w])_([^_]+)_(?![\w])|\*([^*\s][^*]*)\*|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gu;

/** One line of Markdown as text, <strong>, <em> and <a> elements. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(text.slice(cursor, start));
    const key = `${keyPrefix}-${index}`;
    index += 1;
    const [whole, label, address, bold, bold2, italic, italic2, bare] = match;
    if (label !== undefined) {
      const href = safeHref(address ?? '');
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            {...(href.startsWith('/') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          >
            {renderInline(label, key)}
          </a>
        ) : (
          whole
        ),
      );
    } else if (bold !== undefined || bold2 !== undefined) {
      out.push(<strong key={key}>{renderInline(bold ?? bold2 ?? '', key)}</strong>);
    } else if (italic !== undefined || italic2 !== undefined) {
      out.push(<em key={key}>{renderInline(italic ?? italic2 ?? '', key)}</em>);
    } else if (bare !== undefined) {
      const href = safeHref(bare);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {bare}
          </a>
        ) : (
          bare
        ),
      );
    }
    cursor = start + whole.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export interface DocMarkdownProps {
  readonly body: string;
  /** Aria label for a checklist item's done state. */
  readonly doneLabel?: string;
  readonly openLabel?: string;
}

/** A document body drawn as the read view shows it. */
export function DocMarkdown({
  body,
  doneLabel = 'Done',
  openLabel = 'Not done',
}: DocMarkdownProps) {
  const blocks = parseDocBlocks(body);
  return (
    <>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading': {
            // The page's h1 is the document title, so the body's "#" is an h2, "##" an h3 and so on.
            const Tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
            return (
              <Tag key={key} className="tm-dx-sheet__heading" data-level={block.level}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'bullets':
            return (
              <ul key={key} className="tm-dx-sheet__list">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case 'numbers':
            return (
              <ol key={key} className="tm-dx-sheet__list">
                {block.items.map((item, i) => (
                  <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case 'checklist':
            return (
              <ul key={key} className="tm-dx-sheet__list" data-checklist="true">
                {block.items.map((item, i) => (
                  <li key={i} data-done={item.done ? 'true' : 'false'}>
                    <span
                      className="tm-dx-sheet__check"
                      role="img"
                      aria-label={item.done ? doneLabel : openLabel}
                    >
                      {item.done ? '☑' : '☐'}
                    </span>
                    <span>{renderInline(item.text, `${key}-${i}`)}</span>
                  </li>
                ))}
              </ul>
            );
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </>
  );
}
