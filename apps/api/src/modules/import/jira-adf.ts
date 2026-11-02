/**
 * R22-e (54-27) — Atlassian Document Format → Markdown, pure and bounded.
 *
 * Jira Cloud's REST API returns an issue description as an ADF tree. This turns it into the
 * Markdown a work-item description holds. No I/O, no clock, no dependency.
 *
 * - Known nodes map to their Markdown form (headings, lists, tables, code fences, quotes, cards,
 *   mentions, emoji). A `link` mark whose href is not `http(s):` / `mailto:` (a `javascript:` or
 *   `data:` href) is dropped: the text stays, as plain text.
 * - Attachments (`media*`) become `[attachment: <alt or id>]` — 54-27 does not import attachment
 *   bytes; the receipt points back at the issue.
 * - Any other node renders as its text content and its type is recorded once in `unknownNodes`
 *   (the receipt's `jira_unknown_markup` note).
 * - Bounded: past `maxNodes` visited nodes, `maxDepth` nesting or `maxChars` output the result is
 *   cut with ` …` and `truncated` is set. A hostile document cannot make this loop or blow the
 *   stack.
 * - Text is passed through unchanged — Arabic included; no bidi marks are added (direction is
 *   the renderer's job).
 */

export interface AdfLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxChars: number;
}

export interface AdfResult {
  readonly markdown: string;
  readonly unknownNodes: readonly string[];
  readonly truncated: boolean;
}

/** `work_items.description` bound the Jira importer validates against (jira-issues.ts). */
export const ADF_DEFAULT_LIMITS: AdfLimits = { maxNodes: 5000, maxDepth: 32, maxChars: 20_000 };

const ELLIPSIS = ' …';

interface AdfNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly marks: readonly { readonly type: string; readonly attrs: Record<string, unknown> }[];
  readonly content: readonly unknown[];
}

function asNode(value: unknown): AdfNode | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['type'] !== 'string') return null;
  const attrs =
    typeof raw['attrs'] === 'object' && raw['attrs'] !== null && !Array.isArray(raw['attrs'])
      ? (raw['attrs'] as Record<string, unknown>)
      : {};
  const marks = Array.isArray(raw['marks'])
    ? (raw['marks'] as unknown[]).flatMap((m) => {
        if (typeof m !== 'object' || m === null) return [];
        const mark = m as Record<string, unknown>;
        if (typeof mark['type'] !== 'string') return [];
        const markAttrs =
          typeof mark['attrs'] === 'object' && mark['attrs'] !== null
            ? (mark['attrs'] as Record<string, unknown>)
            : {};
        return [{ type: mark['type'], attrs: markAttrs }];
      })
    : [];
  return {
    type: raw['type'],
    ...(typeof raw['text'] === 'string' ? { text: raw['text'] } : {}),
    attrs,
    marks,
    content: Array.isArray(raw['content']) ? (raw['content'] as unknown[]) : [],
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Only `http:`, `https:` and `mailto:` hrefs survive as links; anything else is plain text. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000- \u007f]+/gu, '');
  if (cleaned === '') return null;
  if (!/^(https?:|mailto:)/iu.test(cleaned)) return null;
  // A paren or space in the href would break the Markdown link; encode them.
  return cleaned.replace(/\(/gu, '%28').replace(/\)/gu, '%29');
}

class Renderer {
  private nodes = 0;
  truncated = false;
  readonly unknown = new Set<string>();

  constructor(private readonly limits: AdfLimits) {}

  /** Count a visit; `false` once the node or depth budget is spent. */
  private enter(depth: number): boolean {
    if (this.truncated) return false;
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes || depth > this.limits.maxDepth) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  private noteUnknown(type: string): void {
    if (this.unknown.size < 50) this.unknown.add(type.slice(0, 60));
  }

  /** The plain text of a subtree (unknown nodes, table cells, code blocks). */
  textOf(value: unknown, depth: number): string {
    const node = asNode(value);
    if (!node || !this.enter(depth)) return '';
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention') return `@${str(node.attrs['text']).replace(/^@/u, '')}`;
    if (node.type === 'emoji') return str(node.attrs['shortName']) || str(node.attrs['text']);
    if (node.content.length === 0) return str(node.attrs['text']) || node.text || '';
    const parts = node.content.map((child) => this.textOf(child, depth + 1));
    const blocky = node.content.some((child) => {
      const c = asNode(child);
      return c !== null && c.type !== 'text' && c.type !== 'hardBreak' && !isInline(c.type);
    });
    return parts.filter((p) => p !== '').join(blocky ? '\n' : '');
  }

  inline(children: readonly unknown[], depth: number): string {
    let out = '';
    for (const child of children) {
      const node = asNode(child);
      if (!node) continue;
      if (node.type === 'text') {
        if (!this.enter(depth)) break;
        out += this.marked(node.text ?? '', node.marks);
        continue;
      }
      switch (node.type) {
        case 'hardBreak':
          if (this.enter(depth)) out += '  \n';
          break;
        case 'mention':
        case 'emoji':
          out += this.textOf(node, depth);
          break;
        case 'inlineCard':
        case 'blockCard':
          if (this.enter(depth)) out += card(node);
          break;
        case 'media':
        case 'mediaInline':
          if (this.enter(depth)) out += attachment(node);
          break;
        default:
          this.noteUnknown(node.type);
          out += this.textOf(node, depth);
      }
    }
    return out;
  }

  private marked(text: string, marks: AdfNode['marks']): string {
    if (text === '') return '';
    let out = text;
    const has = (type: string) => marks.some((m) => m.type === type);
    if (has('code')) out = codeSpan(out);
    if (has('strike')) out = `~~${out}~~`;
    if (has('em')) out = `_${out}_`;
    if (has('underline')) out = `__${out}__`;
    if (has('strong')) out = `**${out}**`;
    const link = marks.find((m) => m.type === 'link');
    if (link) {
      const href = safeHref(link.attrs['href']);
      if (href !== null) out = `[${out}](${href})`;
    }
    for (const mark of marks) {
      if (!KNOWN_MARKS.has(mark.type)) this.noteUnknown(`mark:${mark.type}`);
    }
    return out;
  }

  /** Render block children separated by blank lines (`tight` lists use one newline). */
  blocks(children: readonly unknown[], depth: number, tight = false): string {
    const parts: string[] = [];
    for (const child of children) {
      if (this.truncated) break;
      const rendered = this.block(child, depth);
      if (rendered !== '') parts.push(rendered);
    }
    return parts.join(tight ? '\n' : '\n\n');
  }

  block(value: unknown, depth: number): string {
    const node = asNode(value);
    if (!node) return '';
    if (node.type === 'text' || isInline(node.type)) return this.inline([value], depth);
    if (!this.enter(depth)) return '';
    const next = depth + 1;
    switch (node.type) {
      case 'doc':
        return this.blocks(node.content, next);
      case 'paragraph':
        return this.inline(node.content, next);
      case 'heading': {
        const level = Math.min(6, Math.max(1, Math.trunc(Number(node.attrs['level']) || 1)));
        return `${'#'.repeat(level)} ${this.inline(node.content, next)}`;
      }
      case 'bulletList':
      case 'orderedList':
        return this.list(node, next);
      case 'listItem':
        return this.blocks(node.content, next, true);
      case 'codeBlock': {
        const body = node.content.map((c) => this.textOf(c, next)).join('');
        const fence = body.includes('```') ? '~~~~' : '```';
        const lang = str(node.attrs['language']).replace(/[^\w+#.-]/gu, '');
        return `${fence}${lang}\n${body}\n${fence}`;
      }
      case 'blockquote':
        return quote(this.blocks(node.content, next));
      case 'panel': {
        const kind = str(node.attrs['panelType']).replace(/[^\w-]/gu, '') || 'info';
        const body = this.blocks(node.content, next);
        return quote(body === '' ? `**${kind}**` : `**${kind}:** ${body}`);
      }
      case 'rule':
        return '---';
      case 'table':
        return this.table(node, next);
      case 'mediaSingle':
      case 'mediaGroup':
        return node.content
          .map((c) => {
            const media = asNode(c);
            return media && this.enter(next) ? attachment(media) : '';
          })
          .filter((s) => s !== '')
          .join(' ');
      case 'blockCard':
      case 'embedCard':
        return card(node);
      default: {
        this.noteUnknown(node.type);
        return node.content
          .map((c) => this.textOf(c, next))
          .filter((s) => s !== '')
          .join('\n')
          .concat(node.content.length === 0 ? str(node.attrs['text']) : '');
      }
    }
  }

  private list(node: AdfNode, depth: number): string {
    const ordered = node.type === 'orderedList';
    let number = Math.max(1, Math.trunc(Number(node.attrs['order']) || 1));
    const lines: string[] = [];
    for (const child of node.content) {
      if (this.truncated) break;
      const item = asNode(child);
      if (!item) continue;
      const marker = ordered ? `${number}. ` : '- ';
      number += 1;
      const body = this.block(child, depth);
      const indent = ' '.repeat(ordered ? marker.length : 2);
      const bodyLines = body.split('\n');
      lines.push(
        `${marker}${bodyLines[0] ?? ''}`,
        ...bodyLines.slice(1).map((l) => (l === '' ? '' : indent + l)),
      );
    }
    return lines.join('\n');
  }

  private table(node: AdfNode, depth: number): string {
    const rows: string[][] = [];
    for (const rowValue of node.content) {
      const row = asNode(rowValue);
      if (!row || this.truncated || !this.enter(depth)) continue;
      rows.push(
        row.content.map((cell) =>
          this.textOf(cell, depth + 1)
            .replace(/\s*\n\s*/gu, ' ')
            .replace(/\|/gu, '\\|')
            .trim(),
        ),
      );
    }
    if (rows.length === 0) return '';
    const width = Math.max(1, ...rows.map((r) => r.length));
    const line = (cells: string[]) =>
      `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    const [head = [], ...body] = rows;
    return [line(head), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
  }
}

const KNOWN_MARKS = new Set([
  'strong',
  'em',
  'code',
  'strike',
  'underline',
  'link',
  'textColor',
  'subsup',
]);

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'inlineCard',
  'mediaInline',
  'date',
  'status',
  'inlineExtension',
  'placeholder',
]);

function isInline(type: string): boolean {
  return INLINE_TYPES.has(type);
}

function codeSpan(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  const pad = fence === '``' ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function quote(body: string): string {
  return body
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');
}

function card(node: AdfNode): string {
  const url = str(node.attrs['url']);
  const href = safeHref(url);
  return href === null ? url : `[${url}](${href})`;
}

function attachment(node: AdfNode): string {
  const label = (str(node.attrs['alt']) || str(node.attrs['id']) || 'file').replace(
    /[[\]\n]/gu,
    ' ',
  );
  return `[attachment: ${label.trim().slice(0, 200)}]`;
}

/** Cut `text` to `maxChars` (code points, not UTF-16 units), ending in ` …`. */
export function cutTo(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(0, maxChars - ELLIPSIS.length)).join('') + ELLIPSIS;
}

/** ADF (a parsed `{ type: 'doc', … }` value) → Markdown. Never throws. */
export function adfToMarkdown(doc: unknown, limits: AdfLimits = ADF_DEFAULT_LIMITS): AdfResult {
  const renderer = new Renderer(limits);
  let markdown = renderer
    .block(doc, 0)
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  let truncated = renderer.truncated;
  if (truncated) markdown = `${markdown}${ELLIPSIS}`;
  if (Array.from(markdown).length > limits.maxChars) {
    markdown = cutTo(markdown, limits.maxChars);
    truncated = true;
  }
  return { markdown, unknownNodes: [...renderer.unknown], truncated };
}
