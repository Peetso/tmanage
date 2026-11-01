import { createRequire } from 'node:module';

/**
 * R5 export (slice 5) — the HTML half of the document export, and the HTML → Markdown walker the
 * Markdown export uses for an `html` body.
 *
 * Pure: no database, principal or HTTP. An `html` body is already sanitised by the server on save
 * (R5-SPEC §3 allowlist), so the HTML export emits it verbatim inside a standalone page with inline
 * CSS only; a legacy `markdown` body is drawn by {@link markdownToHtmlServer}, a five-block
 * converter mirroring `apps/web/src/components/docs/DocMarkdown.tsx` (headings, paragraphs, bullets,
 * numbers, checklists; bold, italic, safe links), escaping every character of text.
 */

export type DocumentBodyFormat = 'markdown' | 'html';

/** What every export renderer needs. `bodyFormat` arrives with slice 2; absent means Markdown. */
export interface ExportSource {
  readonly title: string;
  readonly body: string;
  readonly bodyFormat?: DocumentBodyFormat;
}

/** The narrow slice of a jsdom node the walkers read (the api compiles without the DOM lib). */
export interface DomNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

interface JsdomModule {
  JSDOM: new (html: string) => {
    window: { document: { body: DomNode } };
  };
}

const require = createRequire(import.meta.url);
let jsdom: JsdomModule | undefined;

/** Parse an HTML fragment into a detached `<body>` whose children are the fragment's nodes. */
export function parseHtmlFragment(html: string): DomNode {
  jsdom ??= require('jsdom') as JsdomModule;
  return new jsdom.JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
}

export const TEXT_NODE = 3;
export const ELEMENT_NODE = 1;

export function tagOf(node: DomNode): string {
  return node.nodeName.toLowerCase();
}

export function attr(node: DomNode, name: string): string | null {
  return node.getAttribute?.(name) ?? null;
}

export function childrenOf(node: DomNode): DomNode[] {
  return Array.from(node.childNodes);
}

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/u;
const STRONG_CHAR =
  /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFCA-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/u;

/** The direction of a text by its first strong character (Arabic/Hebrew → rtl, else ltr). */
export function textDirection(text: string): 'rtl' | 'ltr' {
  const first = STRONG_CHAR.exec(text)?.[0];
  return first !== undefined && RTL_CHAR.test(first) ? 'rtl' : 'ltr';
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A link may open http(s), mailto or a same-site path — the same rule as the web `safeHref`. */
export function safeHref(address: string): string | null {
  const href = address.trim();
  if (/^https?:\/\/[^\s]+$/iu.test(href) && !/^https?:\/\/$/iu.test(href)) return href;
  if (/^mailto:[^\s]+$/iu.test(href)) return href;
  if (/^\/(?!\/)[^\s]*$/u.test(href)) return href;
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------------------------------------

function inlineMarkdown(node: DomNode): string {
  if (node.nodeType === TEXT_NODE) return (node.textContent ?? '').replace(/\s+/gu, ' ');
  if (node.nodeType !== ELEMENT_NODE) return '';
  const inner = () => childrenOf(node).map(inlineMarkdown).join('');
  switch (tagOf(node)) {
    case 'strong':
    case 'b':
      return `**${inner()}**`;
    case 'em':
    case 'i':
      return `_${inner()}_`;
    case 's':
      return `~~${inner()}~~`;
    case 'code':
      return `\`${node.textContent ?? ''}\``;
    case 'br':
      return '\n';
    case 'img':
      return `![${attr(node, 'alt') ?? ''}](${attr(node, 'src') ?? ''})`;
    case 'a': {
      const href = safeHref(attr(node, 'href') ?? '');
      return href ? `[${inner()}](${href})` : inner();
    }
    case 'span':
      if (attr(node, 'data-type') === 'mention') {
        return `@${attr(node, 'data-label') ?? node.textContent ?? ''}`;
      }
      return inner();
    case 'ul':
    case 'ol':
      return '';
    default:
      return inner();
  }
}

function inlineOf(node: DomNode): string {
  return childrenOf(node).map(inlineMarkdown).join('').trim();
}

/** The text of a list item: its paragraphs joined, nested lists rendered indented below. */
function listItemMarkdown(item: DomNode, depth: number): { text: string; nested: string[] } {
  const parts: string[] = [];
  const nested: string[] = [];
  for (const child of childrenOf(item)) {
    const tag = tagOf(child);
    if (tag === 'ul' || tag === 'ol') nested.push(listMarkdown(child, depth + 1));
    else if (tag === 'p' || tag === 'div' || tag === 'label') {
      const deeper = listItemMarkdown(child, depth);
      if (deeper.text !== '') parts.push(deeper.text);
      nested.push(...deeper.nested);
    } else parts.push(inlineMarkdown(child));
  }
  return { text: parts.join(' ').replace(/\s+/gu, ' ').trim(), nested };
}

function listMarkdown(list: DomNode, depth: number): string {
  const ordered = tagOf(list) === 'ol';
  const task = attr(list, 'data-type') === 'taskList';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let index = 0;
  for (const item of childrenOf(list)) {
    if (tagOf(item) !== 'li') continue;
    index += 1;
    const { text, nested } = listItemMarkdown(item, depth);
    let marker = ordered ? `${index}.` : '-';
    if (task || attr(item, 'data-type') === 'taskItem') {
      marker = `- [${attr(item, 'data-checked') === 'true' ? 'x' : ' '}]`;
    }
    lines.push(`${indent}${marker} ${text}`.trimEnd(), ...nested);
  }
  return lines.join('\n');
}

function tableMarkdown(table: DomNode): string {
  const rows: string[][] = [];
  const collect = (node: DomNode) => {
    for (const child of childrenOf(node)) {
      const tag = tagOf(child);
      if (tag === 'tr') {
        rows.push(
          childrenOf(child)
            .filter((cell) => ['td', 'th'].includes(tagOf(cell)))
            .map((cell) => blocksOf(cell).join(' ').replace(/\n/gu, ' ').replace(/\|/gu, '\\|')),
        );
      } else if (['thead', 'tbody', 'tfoot'].includes(tag)) collect(child);
    }
  };
  collect(table);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  const [head, ...rest] = rows;
  return [line(head ?? []), `| ${Array(width).fill('---').join(' | ')} |`, ...rest.map(line)].join(
    '\n',
  );
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** The Markdown blocks of a container's children. */
function blocksOf(container: DomNode): string[] {
  const blocks: string[] = [];
  let inline = '';
  const flush = () => {
    if (inline.trim() !== '') blocks.push(inline.trim());
    inline = '';
  };
  for (const node of childrenOf(container)) {
    if (node.nodeType !== ELEMENT_NODE) {
      inline += inlineMarkdown(node);
      continue;
    }
    const tag = tagOf(node);
    const block = blockMarkdown(node, tag);
    if (block === undefined) inline += inlineMarkdown(node);
    else {
      flush();
      if (block !== '') blocks.push(block);
    }
  }
  flush();
  return blocks;
}

function blockMarkdown(node: DomNode, tag: string): string | undefined {
  const heading = /^h([1-6])$/u.exec(tag);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${inlineOf(node)}`;
  switch (tag) {
    case 'p':
      return inlineOf(node);
    case 'ul':
    case 'ol':
      return listMarkdown(node, 0);
    case 'table':
      return tableMarkdown(node);
    case 'pre':
      return `\`\`\`\n${(node.textContent ?? '').replace(/\n$/u, '')}\n\`\`\``;
    case 'blockquote':
      return quote(blocksOf(node).join('\n\n'));
    case 'hr':
      return '---';
    case 'figcaption':
      return `_${inlineOf(node)}_`;
    case 'figure':
      return blocksOf(node).join('\n\n');
    case 'div': {
      const type = attr(node, 'data-type');
      if (type === 'callout') return quote(`**Note:** ${blocksOf(node).join('\n\n')}`);
      if (type === 'embed') {
        const url = safeHref(attr(node, 'data-url') ?? '');
        return url ? `[${url}](${url})` : '';
      }
      return blocksOf(node).join('\n\n');
    }
    default:
      return undefined;
  }
}

/** Convert a (server-sanitised) document HTML body to GFM Markdown. */
export function htmlToMarkdown(html: string): string {
  return blocksOf(parseHtmlFragment(html)).join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Markdown → HTML (legacy bodies), mirroring DocMarkdown.tsx
// ---------------------------------------------------------------------------------------------

const HEADING = /^(#{1,3})\s+(.*)$/u;
const CHECK = /^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/u;
const BULLET = /^\s*[-*•]\s+(.*)$/u;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/u;
const INLINE =
  /\[([^\]]+)\]\(([^)\s]*)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w])_([^_]+)_(?![\w])|\*([^*\s][^*]*)\*|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gu;

function inlineHtml(text: string): string {
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    out += escapeHtml(text.slice(cursor, start));
    const [whole, label, address, bold, bold2, italic, italic2, bare] = match;
    if (label !== undefined) {
      const href = safeHref(address ?? '');
      out += href ? `<a href="${escapeHtml(href)}">${inlineHtml(label)}</a>` : escapeHtml(whole);
    } else if (bold !== undefined || bold2 !== undefined) {
      out += `<strong>${inlineHtml(bold ?? bold2 ?? '')}</strong>`;
    } else if (italic !== undefined || italic2 !== undefined) {
      out += `<em>${inlineHtml(italic ?? italic2 ?? '')}</em>`;
    } else if (bare !== undefined) {
      const href = safeHref(bare);
      out += href ? `<a href="${escapeHtml(href)}">${escapeHtml(bare)}</a>` : escapeHtml(bare);
    }
    cursor = start + whole.length;
  }
  return out + escapeHtml(text.slice(cursor));
}

/** Convert a legacy Markdown body (the five DocMarkdown block kinds) to escaped HTML. */
export function markdownToHtmlServer(markdown: string): string {
  const out: string[] = [];
  let list: { tag: string; task: boolean; items: string[] } | null = null;
  const close = () => {
    if (list) {
      const type = list.task ? ' data-type="taskList"' : '';
      out.push(`<${list.tag}${type}>${list.items.join('')}</${list.tag}>`);
    }
    list = null;
  };
  const push = (tag: string, task: boolean, item: string) => {
    if (!list || list.tag !== tag || list.task !== task) {
      close();
      list = { tag, task, items: [] };
    }
    list.items.push(item);
  };
  for (const raw of markdown.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    const check = CHECK.exec(line);
    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    if (line.trim() === '') close();
    else if (heading) {
      close();
      const level = (heading[1] ?? '#').length + 1;
      out.push(`<h${level}>${inlineHtml(heading[2] ?? '')}</h${level}>`);
    } else if (check) {
      const done = (check[1] ?? ' ').toLowerCase() === 'x';
      push(
        'ul',
        true,
        `<li data-type="taskItem" data-checked="${done}">${inlineHtml(check[2] ?? '')}</li>`,
      );
    } else if (bullet) push('ul', false, `<li>${inlineHtml(bullet[1] ?? '')}</li>`);
    else if (number) push('ol', false, `<li>${inlineHtml(number[1] ?? '')}</li>`);
    else {
      close();
      out.push(`<p>${inlineHtml(line)}</p>`);
    }
  }
  close();
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The standalone HTML page
// ---------------------------------------------------------------------------------------------

const PAGE_CSS = [
  'body{margin:0;background:#fff;color:#111;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}',
  'main{max-width:760px;margin:0 auto;padding:48px 24px}',
  'h1{font-size:2.2em;line-height:1.2;margin:0 0 24px}',
  'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px;text-align:start}',
  'pre{background:#f4f4f4;padding:12px;overflow:auto}code{font-family:ui-monospace,Consolas,monospace}',
  'blockquote,div[data-type=callout]{margin:0;padding:8px 16px;border-inline-start:4px solid #ccc}',
  'ul[data-type=taskList]{list-style:none;padding-inline-start:0}img{max-width:100%}',
  'li[data-type=taskItem]::before{content:"\\2610  "}li[data-checked=true]::before{content:"\\2611  "}',
].join('\n');

/** The plain text of an HTML or Markdown body (for the direction heuristic). */
function bodyText(source: ExportSource): string {
  if ((source.bodyFormat ?? 'markdown') === 'markdown') return source.body;
  return parseHtmlFragment(source.body).textContent ?? '';
}

/** A standalone, self-contained HTML page of the document: `<h1>` title, then the body. */
export function renderDocumentHtml(source: ExportSource): string {
  const html =
    (source.bodyFormat ?? 'markdown') === 'html' ? source.body : markdownToHtmlServer(source.body);
  const dir = textDirection(`${source.title} ${bodyText(source)}`);
  const title = escapeHtml(source.title);
  return [
    '<!doctype html>',
    `<html lang="${dir === 'rtl' ? 'ar' : 'en'}" dir="${dir}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>\n${PAGE_CSS}\n</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${title}</h1>`,
    html,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
