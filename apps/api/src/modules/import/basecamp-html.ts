/**
 * R22-f (54-28) — Basecamp archive HTML → Markdown, pure.
 *
 * Governing source: `54-FEATURE-GAPS-PLATFORM-ECOSYSTEM.md` §10.5 **54-28**, Security extras: "The
 * HTML archive is parsed with a sanitising parser (scripts, iframes, external images stripped;
 * images become links to the archive path, never re-hosted)".
 *
 * A tolerant tag walker with no parser dependency (the hand-built approach of `htmlToPlainText`
 * in inbound-mail-rules.ts). It never emits a tag from the input: text is entity-decoded and its
 * `<` / `>` re-escaped, and the only HTML in the output is the `<p dir="rtl">` wrapper this file
 * writes itself. That wrapper is the RTL choice: the Docs sanitiser (`docs/doc-html.ts`
 * `ATTRS_BY_TAG['*']`) keeps `dir` on every tag, so the renderer honours it — no U+200F prefix.
 *
 * - `p` / `div` → paragraphs, `h1`–`h6` → `#`…, `strong`/`b` → `**`, `em`/`i` → `_`,
 *   `ul`/`ol`/`li` → lists, `blockquote` → `>`, `pre` → fenced code, `code` → backticks, `br`;
 * - `a`: the href is kept only for `http(s):`; any other scheme (`javascript:`, `data:`, …) keeps
 *   the link text alone;
 * - `img`: a relative archive path becomes `[image: <alt or file name>](<path>)` — never fetched;
 *   an absolute / external / `data:` source is stripped and named;
 * - `script`, `style`, `iframe`, `object`, `embed`, `form`, `svg` (and their content) and every
 *   `on*` event-handler attribute are stripped and named in `stripped`;
 * - the output is bounded to 64 KiB (cut with a note).
 */

/** The output bound for one converted HTML body. */
export const MAX_MARKDOWN_BYTES = 64 * 1024;
/** `documents.body` is MEDIUMTEXT; the doc body bound (`doc-html.ts` MAX_BODY_LENGTH, not imported: it loads jsdom). */
const MAX_DOCUMENT_BODY = 1_000_000;

/** Tags dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg']);
/** Tags that end the current block. */
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'table',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'figure',
  'figcaption',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  middot: '·',
  copy: '©',
};

/** Decode the named and numeric character references a Basecamp export uses. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Text as Markdown-safe: no raw `<` / `>`, and an `&` that would read as a reference escaped. */
function escapeText(value: string): string {
  return value
    .replace(/&(?=#?[a-z0-9]+;)/giu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

/** The first strong-directional character decides a paragraph's direction. */
export function isRtlText(value: string): boolean {
  const first = /[\p{L}]/u.exec(value);
  return first !== null && /[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(first[0]);
}

interface Attributes {
  readonly [name: string]: string;
}

function parseAttributes(source: string, stripped: Set<string>): Attributes {
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  const pattern = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu;
  for (const match of source.matchAll(pattern)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name.startsWith('on')) {
      stripped.add(name);
      continue;
    }
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** An `http(s):` URL safe to put in `[text](url)`; anything else is `null`. */
function safeHref(href: string | undefined): string | null {
  const value = (href ?? '').trim();
  if (!/^https?:\/\/[^\s]+$/iu.test(value)) return null;
  return value.replace(/[()<>]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A relative archive path for an image, or `null` when the source is external / not a path. */
function archivePath(src: string | undefined): string | null {
  const value = (src ?? '').trim();
  if (value === '' || value.startsWith('//') || value.startsWith('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  if (value.split(/[\\/]/u).includes('..')) return null;
  return value.replace(/[\s()<>]/gu, (c) => encodeURIComponent(c));
}

interface ListFrame {
  readonly ordered: boolean;
  count: number;
}

interface LinkFrame {
  readonly href: string | null;
  readonly start: number;
}

export interface BasecampMarkdown {
  readonly markdown: string;
  /** What was removed: tag names (`script`, `iframe`, `img` for an external image) and `on*` attributes. */
  readonly stripped: readonly string[];
  readonly truncated: boolean;
}

/** Convert one Basecamp archive HTML body. Never throws; malformed HTML degrades to text. */
export function basecampHtmlToMarkdown(html: string): BasecampMarkdown {
  const stripped = new Set<string>();
  const blocks: string[] = [];
  const lists: ListFrame[] = [];
  const links: LinkFrame[] = [];
  let inline = '';
  let heading = 0;
  let quote = 0;
  let pre: string | null = null;
  let listItem = false;

  const flush = (): void => {
    const textValue = inline.replace(/\s+/gu, ' ').trim();
    inline = '';
    if (textValue === '') return;
    const quotePrefix = '> '.repeat(quote);
    if (heading > 0) {
      blocks.push(`${quotePrefix}${'#'.repeat(heading)} ${textValue}`);
    } else if (listItem && lists.length > 0) {
      const frame = lists[lists.length - 1] as ListFrame;
      const indent = '  '.repeat(lists.length - 1);
      const marker = frame.ordered ? `${frame.count}.` : '-';
      blocks.push(`${quotePrefix}${indent}${marker} ${textValue}`);
      listItem = false;
    } else if (isRtlText(textValue)) {
      blocks.push(`<p dir="rtl">\n\n${quotePrefix}${textValue}\n\n</p>`);
    } else {
      blocks.push(`${quotePrefix}${textValue}`);
    }
  };

  const token = /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html)) !== null) {
    const textChunk = html.slice(cursor, match.index);
    cursor = token.lastIndex;
    if (textChunk !== '') {
      const decoded = escapeText(decodeEntities(textChunk));
      if (pre !== null) pre += decoded;
      else inline += decoded;
    }
    const name = (match[1] ?? '').toLowerCase();
    if (name === '') continue; // a comment
    const closing = match[0].startsWith('</');
    if (DROP_WITH_CONTENT.has(name)) {
      stripped.add(name);
      if (closing) continue;
      const end = new RegExp(`</${name}\\s*>`, 'iu');
      const rest = html.slice(cursor);
      const found = end.exec(rest);
      // `embed` has no closing tag; an unclosed `script` drops the rest of the body.
      if (found) cursor += found.index + found[0].length;
      else if (name !== 'embed') cursor = html.length;
      token.lastIndex = cursor;
      continue;
    }
    const attributes = closing ? {} : parseAttributes(match[2] ?? '', stripped);

    if (pre !== null) {
      if (name === 'pre' && closing) {
        const body = pre.replace(/```/gu, '`​``').replace(/^\n+|\n+$/gu, '');
        blocks.push(`${'> '.repeat(quote)}\`\`\`\n${body}\n\`\`\``);
        pre = null;
      } else if (name === 'br') pre += '\n';
      continue;
    }

    switch (name) {
      case 'br':
        inline += '\n';
        if (listItem || heading > 0) inline += ' ';
        else flush();
        break;
      case 'strong':
      case 'b':
        inline += '**';
        break;
      case 'em':
      case 'i':
        inline += '_';
        break;
      case 'code':
        inline += '`';
        break;
      case 'a':
        if (!closing) links.push({ href: safeHref(attributes['href']), start: inline.length });
        else {
          const frame = links.pop();
          if (frame?.href) {
            const label = inline.slice(frame.start).trim() || frame.href;
            inline = `${inline.slice(0, frame.start)}[${label}](${frame.href})`;
          }
        }
        break;
      case 'img': {
        const path = archivePath(attributes['src']);
        if (path === null) {
          stripped.add('img');
          break;
        }
        const file = path.split('/').pop() ?? path;
        const alt = escapeText((attributes['alt'] ?? '').trim()).replace(/[[\]]/gu, '');
        inline += ` [image: ${alt || decodeURIComponent(file)}](${path}) `;
        break;
      }
      case 'ul':
      case 'ol':
        flush();
        if (!closing) lists.push({ ordered: name === 'ol', count: 0 });
        else lists.pop();
        break;
      case 'li':
        flush();
        if (!closing && lists.length > 0) {
          (lists[lists.length - 1] as ListFrame).count += 1;
          listItem = true;
        } else listItem = false;
        break;
      case 'blockquote':
        flush();
        quote = Math.max(0, quote + (closing ? -1 : 1));
        break;
      case 'pre':
        flush();
        if (!closing) pre = '';
        break;
      default:
        if (/^h[1-6]$/u.test(name)) {
          flush();
          heading = closing ? 0 : Number(name.slice(1));
        } else if (BLOCK_TAGS.has(name)) {
          flush();
        }
      // Any other tag (span, font, u, …) is unwrapped: its text stays, the tag does not.
    }
  }
  const tail = html.slice(cursor);
  if (tail !== '') {
    const decoded = escapeText(decodeEntities(tail.replace(/<[^>]*$/u, '')));
    if (pre !== null) pre += decoded;
    else inline += decoded;
  }
  if (pre !== null) blocks.push(`\`\`\`\n${pre.replace(/```/gu, '`​``')}\n\`\`\``);
  flush();

  const { text: markdown, truncated } = bound(blocks.join('\n\n'), MAX_MARKDOWN_BYTES);
  return { markdown, stripped: [...stripped], truncated };
}

const TRUNCATION_NOTE = '\n\n_[Cut here: the original is longer than this import keeps.]_';

/** Cut `value` to at most `maxBytes` UTF-8 bytes (note included) on a character boundary. */
function bound(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_NOTE, 'utf8');
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    end += char.length;
  }
  return { text: value.slice(0, end) + TRUNCATION_NOTE, truncated: true };
}

export interface BasecampComment {
  readonly author?: string;
  readonly postedAt?: string;
  readonly html?: string;
}

export interface BasecampMessageInput {
  readonly path: string;
  readonly title: string;
  readonly author?: string;
  readonly postedAt?: string;
  readonly html?: string;
  readonly comments?: readonly BasecampComment[];
}

/** A name or time as plain inline text (Privacy: the author is text, never linked to an account). */
function plain(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, 190);
  return trimmed === '' ? fallback : escapeText(trimmed).replace(/[*_`[\]]/gu, '');
}

/**
 * A Basecamp message (+ its comments) as a project document. The body's first line names the
 * archive path (`documents` has no source column), then the author / time line, the converted
 * body, and `## Comments` with one `**author · time**` block per comment.
 */
export function basecampMessageToDocument(message: BasecampMessageInput): {
  readonly title: string;
  readonly body: string;
  readonly stripped: readonly string[];
} {
  const stripped = new Set<string>();
  const parts = [
    `Imported from Basecamp: ${plain(message.path, '(unknown path)')}`,
    `**${plain(message.author, 'Unknown author')} · ${plain(message.postedAt, 'unknown time')}**`,
  ];
  const converted = basecampHtmlToMarkdown(message.html ?? '');
  converted.stripped.forEach((name) => stripped.add(name));
  if (converted.markdown !== '') parts.push(converted.markdown);
  const comments = message.comments ?? [];
  if (comments.length > 0) {
    parts.push('## Comments');
    for (const comment of comments) {
      const body = basecampHtmlToMarkdown(comment.html ?? '');
      body.stripped.forEach((name) => stripped.add(name));
      parts.push(
        `**${plain(comment.author, 'Unknown author')} · ${plain(comment.postedAt, 'unknown time')}**`,
      );
      if (body.markdown !== '') parts.push(body.markdown);
    }
  }
  const title = message.title.replace(/\s+/gu, ' ').trim().slice(0, 255);
  return {
    title,
    body: bound(parts.join('\n\n'), MAX_DOCUMENT_BODY).text,
    stripped: [...stripped],
  };
}

/**
 * The Basecamp row kinds. The API has no ZIP reader (`jszip` is a **web** dependency), so the
 * import web unzips the archive in the browser and posts one row per message / to-do / list;
 * the `mapping` is unused for this kind. `message` → a project document, `todo` → a work item,
 * `todolist` → a project phase; the rest are counted into the receipt's `basecamp_skipped`
 * (Campfire is not imported, Hill Charts are skipped, schedule and files have no target yet).
 */
export const BASECAMP_ROW_KINDS = [
  'message',
  'todo',
  'todolist',
  'campfire',
  'hillchart',
  'schedule',
  'file',
] as const;
export type BasecampRowKind = (typeof BASECAMP_ROW_KINDS)[number];
export const BASECAMP_SKIPPED_KINDS: ReadonlySet<BasecampRowKind> = new Set([
  'campfire',
  'hillchart',
  'schedule',
  'file',
]);

/** One Basecamp HTML body (message or comment) as posted; bounded before conversion. */
export const MAX_BASECAMP_HTML = 256 * 1024;
export const MAX_BASECAMP_COMMENTS = 200;

interface RowFieldError {
  readonly field: string;
  readonly message: string;
}

function optionalString(
  row: Readonly<Record<string, unknown>>,
  field: string,
  max: number,
  errors: RowFieldError[],
): void {
  const value = row[field];
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') errors.push({ field, message: 'must be a string' });
  else if (value.length > max)
    errors.push({ field, message: `must be ${max} characters or fewer` });
}

/**
 * Validate one `basecamp_messages` row: `{ kind, path, title, author, postedAt, html,
 * comments: [{ author, postedAt, html }], dueAt?, assignee?, list? }`.
 */
export function validateBasecampRow(
  _mapping: Readonly<Record<string, string>>,
  row: Readonly<Record<string, unknown>>,
): readonly RowFieldError[] {
  const errors: RowFieldError[] = [];
  const kind = row['kind'];
  if (typeof kind !== 'string' || !(BASECAMP_ROW_KINDS as readonly string[]).includes(kind)) {
    errors.push({ field: 'kind', message: `must be one of ${BASECAMP_ROW_KINDS.join(', ')}` });
    return errors;
  }
  if (BASECAMP_SKIPPED_KINDS.has(kind as BasecampRowKind)) return errors;
  const title = row['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    errors.push({ field: 'title', message: 'must be a non-empty string' });
  } else if (title.trim().length > (kind === 'todolist' ? 120 : 255)) {
    errors.push({ field: 'title', message: 'is too long' });
  }
  optionalString(row, 'path', 1024, errors);
  optionalString(row, 'author', 190, errors);
  optionalString(row, 'postedAt', 64, errors);
  optionalString(row, 'html', MAX_BASECAMP_HTML, errors);
  optionalString(row, 'assignee', 190, errors);
  optionalString(row, 'list', 120, errors);
  const dueAt = row['dueAt'];
  if (dueAt !== undefined && dueAt !== null && dueAt !== '') {
    const valid =
      typeof dueAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(dueAt) &&
      !Number.isNaN(Date.parse(`${dueAt}T00:00:00.000Z`)) &&
      new Date(`${dueAt}T00:00:00.000Z`).toISOString().slice(0, 10) === dueAt;
    if (!valid) errors.push({ field: 'dueAt', message: 'must be a date in YYYY-MM-DD form' });
  }
  const comments = row['comments'];
  if (comments !== undefined && comments !== null) {
    if (!Array.isArray(comments)) {
      errors.push({ field: 'comments', message: 'must be an array' });
    } else if (comments.length > MAX_BASECAMP_COMMENTS) {
      errors.push({
        field: 'comments',
        message: `must be ${MAX_BASECAMP_COMMENTS} comments or fewer`,
      });
    } else {
      comments.forEach((comment: unknown, index) => {
        if (typeof comment !== 'object' || comment === null || Array.isArray(comment)) {
          errors.push({ field: `comments[${index}]`, message: 'must be an object' });
          return;
        }
        const entry = comment as Record<string, unknown>;
        const before = errors.length;
        optionalString(entry, 'author', 190, errors);
        optionalString(entry, 'postedAt', 64, errors);
        optionalString(entry, 'html', MAX_BASECAMP_HTML, errors);
        for (let i = before; i < errors.length; i += 1) {
          const e = errors[i] as RowFieldError;
          errors[i] = { field: `comments[${index}].${e.field}`, message: e.message };
        }
      });
    }
  }
  return errors;
}
