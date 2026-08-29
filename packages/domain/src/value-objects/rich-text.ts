/**
 * Sanitized rich text — what a message body may contain beyond plain characters (CHAT-002).
 *
 * `04-SECURITY-PRIVACY` §6: "Strict input schemas; contextual output encoding; sanitized
 * rich-text allowlist." `27-TEST-CATALOG` SEC-08 tests stored XSS in messages. This module is
 * the allowlist, and three decisions shape it:
 *
 * ## 1. The admissible markup is a structured document, not HTML
 *
 * Rich text here is a JSON tree of typed nodes — paragraphs, code blocks, quotes, lists, and
 * text runs carrying marks — rather than an HTML string with tags removed. The difference is
 * what "sanitized" can mean. An HTML sanitizer is a parser racing an attacker's parser, and
 * every divergence between the two is a bypass; browsers have decades of them. A validator
 * over a closed grammar has no second parser to disagree with: a node whose type is not in
 * the allowlist does not survive, and there is nowhere in the structure for `<script>` to
 * hide because there is no place where markup is text. No HTML is ever stored; a renderer
 * walks the tree and encodes every text node for its own context, which is the "contextual
 * output encoding" half of §6's sentence and stays the renderer's job.
 *
 * ## 2. Inadmissible input is refused, never repaired
 *
 * The precedent is `assertSafeAuditMetadata`, which refuses a forbidden key at the write
 * boundary rather than dropping it. Silent repair means the author's message and the stored
 * message differ and nobody was told — and a stripped node is exactly where an attacker
 * probes for the case the stripper and the renderer read differently. A document is admitted
 * whole or refused with the path to the first offending node.
 *
 * ## 3. Complexity is bounded before content is judged
 *
 * §6 again: "pagination ceilings, complexity limits". Node count and nesting depth are
 * checked as hard limits so a pathological document is refused for its size before anything
 * recurses over its content.
 *
 * The grammar, complete:
 *
 *     doc         → block+
 *     block       → paragraph | code_block | blockquote | bullet_list | ordered_list
 *     paragraph   → inline*
 *     code_block  → text*                      (marks are refused: code is verbatim)
 *     blockquote  → block+
 *     bullet_list → list_item+
 *     ordered_list→ list_item+
 *     list_item   → block+
 *     inline      → text | hard_break
 *     text        → { text, marks? }           (marks: bold, italic, strike, code, link)
 *
 * A `link` mark carries exactly one attribute, `href`, and its scheme must be `http`,
 * `https` or `mailto` — `javascript:` and `data:` are the payloads SEC-08 exists for, and an
 * allowlist of three schemes refuses every spelling of them without trying to enumerate any.
 *
 * Newlines are structure, not characters: a line break inside a paragraph is a `hard_break`
 * node, and a literal `\n` in a paragraph's text is refused so that no renderer has to decide
 * what it means. A `code_block`'s text is the one place `\n` is a character, because code is
 * verbatim. `\r` and the other C0 controls are refused everywhere.
 */

/** Marks that need no attributes. */
const SIMPLE_MARK_TYPES = ['bold', 'italic', 'strike', 'code'] as const;

export type RichTextSimpleMarkType = (typeof SIMPLE_MARK_TYPES)[number];

export interface RichTextSimpleMark {
  readonly type: RichTextSimpleMarkType;
}

export interface RichTextLinkMark {
  readonly type: 'link';
  readonly href: string;
}

export type RichTextMark = RichTextSimpleMark | RichTextLinkMark;

export interface RichTextText {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly RichTextMark[];
}

export interface RichTextHardBreak {
  readonly type: 'hard_break';
}

export type RichTextInline = RichTextText | RichTextHardBreak;

export interface RichTextParagraph {
  readonly type: 'paragraph';
  readonly content: readonly RichTextInline[];
}

export interface RichTextCodeBlock {
  readonly type: 'code_block';
  readonly content: readonly RichTextText[];
}

export interface RichTextBlockquote {
  readonly type: 'blockquote';
  readonly content: readonly RichTextBlock[];
}

export interface RichTextListItem {
  readonly type: 'list_item';
  readonly content: readonly RichTextBlock[];
}

export interface RichTextList {
  readonly type: 'bullet_list' | 'ordered_list';
  readonly content: readonly RichTextListItem[];
}

export type RichTextBlock =
  RichTextParagraph | RichTextCodeBlock | RichTextBlockquote | RichTextList;

export interface RichTextDocument {
  readonly type: 'doc';
  readonly content: readonly RichTextBlock[];
}

/**
 * The total characters of text a document may carry, summed over its text nodes. The same
 * number as the plain-text ceiling in `ConversationsController`, because a rich message is
 * not entitled to say more than a plain one.
 */
export const RICH_TEXT_MAX_TEXT_LENGTH = 16_000;

/** Every node in the tree counts: blocks, inlines, and list items. Marks do not. */
export const RICH_TEXT_MAX_NODES = 1_000;

/**
 * How deep blocks may nest. A quote of a list of quotes is depth 6 and legitimate; depth 8
 * has never been written by a person.
 */
export const RICH_TEXT_MAX_DEPTH = 8;

export const RICH_TEXT_MAX_HREF_LENGTH = 2_000;

/** The scheme allowlist. Everything else — `javascript:`, `data:`, `vbscript:` — is refused by absence. */
export const RICH_TEXT_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const;

/**
 * A document that is not admissible, with the path to the first offending node —
 * `doc.content[2].content[0].marks[1]` — so an editor can point at what it produced.
 */
export class InadmissibleRichTextError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = 'InadmissibleRichTextError';
  }
}

/** C0 controls except `\n` and `\t`, and `\r` unconditionally. `\n` is judged per context. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

interface Budget {
  nodes: number;
  textLength: number;
}

function refuse(path: string, reason: string): never {
  throw new InadmissibleRichTextError(path, reason);
}

/** An own-keys check: an allowlist admits exactly the keys it names, so extras are refused. */
function requireExactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      refuse(path, `unknown key "${key}"`);
    }
  }
  for (const key of required) {
    if (!(key in value)) refuse(path, `missing key "${key}"`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) refuse(path, 'must be an array');
  return value;
}

function spend(budget: Budget, path: string): void {
  budget.nodes -= 1;
  if (budget.nodes < 0) {
    refuse(path, `the document has more than ${RICH_TEXT_MAX_NODES} nodes`);
  }
}

function sanitizeMark(value: unknown, path: string, seen: Set<string>): RichTextMark {
  const record = asRecord(value, path);
  const type = record['type'];
  if (typeof type !== 'string') refuse(path, 'mark type must be a string');
  if (seen.has(type)) refuse(path, `duplicate mark "${type}"`);
  seen.add(type);

  if ((SIMPLE_MARK_TYPES as readonly string[]).includes(type)) {
    requireExactKeys(record, path, ['type']);
    return { type: type as RichTextSimpleMarkType };
  }

  if (type === 'link') {
    requireExactKeys(record, path, ['type', 'href']);
    const href = record['href'];
    if (typeof href !== 'string') refuse(`${path}.href`, 'must be a string');
    const trimmed = href.trim();
    if (trimmed === '') refuse(`${path}.href`, 'must not be empty');
    if (trimmed.length > RICH_TEXT_MAX_HREF_LENGTH) {
      refuse(`${path}.href`, `must be ${RICH_TEXT_MAX_HREF_LENGTH} characters or fewer`);
    }
    if (FORBIDDEN_CONTROLS.test(trimmed) || /[\n\t]/.test(trimmed)) {
      refuse(`${path}.href`, 'must not contain control characters');
    }
    let parsed: URL;
    try {
      // WHATWG parsing, so `jAvAsCrIpT:`, leading whitespace and `\t` smuggling are all
      // normalised before the scheme is compared rather than each being a case to remember.
      parsed = new URL(trimmed);
    } catch {
      refuse(`${path}.href`, 'must be an absolute URL');
    }
    if (!(RICH_TEXT_LINK_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
      refuse(`${path}.href`, 'must use the http, https or mailto scheme');
    }
    return { type: 'link', href: trimmed };
  }

  refuse(path, `unknown mark "${type}"`);
}

function sanitizeText(
  value: Record<string, unknown>,
  path: string,
  budget: Budget,
  options: { readonly allowNewlines: boolean; readonly allowMarks: boolean },
): RichTextText {
  requireExactKeys(value, path, ['type', 'text'], options.allowMarks ? ['marks'] : []);

  const text = value['text'];
  if (typeof text !== 'string') refuse(`${path}.text`, 'must be a string');
  if (text === '') refuse(`${path}.text`, 'must not be empty');
  if (FORBIDDEN_CONTROLS.test(text)) refuse(`${path}.text`, 'must not contain control characters');
  if (!options.allowNewlines && text.includes('\n')) {
    refuse(`${path}.text`, 'line breaks in a paragraph are hard_break nodes, not characters');
  }

  budget.textLength -= text.length;
  if (budget.textLength < 0) {
    refuse(path, `the document holds more than ${RICH_TEXT_MAX_TEXT_LENGTH} characters of text`);
  }

  if (value['marks'] === undefined) return { type: 'text', text };

  const rawMarks = asArray(value['marks'], `${path}.marks`);
  if (rawMarks.length === 0) refuse(`${path}.marks`, 'must not be an empty array');
  const seen = new Set<string>();
  const marks = rawMarks.map((mark, index) => sanitizeMark(mark, `${path}.marks[${index}]`, seen));
  return { type: 'text', text, marks };
}

function sanitizeInline(value: unknown, path: string, budget: Budget): RichTextInline {
  spend(budget, path);
  const record = asRecord(value, path);
  const type = record['type'];
  if (type === 'text') {
    return sanitizeText(record, path, budget, { allowNewlines: false, allowMarks: true });
  }
  if (type === 'hard_break') {
    requireExactKeys(record, path, ['type']);
    return { type: 'hard_break' };
  }
  refuse(path, `unknown inline node "${String(type)}"`);
}

function sanitizeBlock(value: unknown, path: string, budget: Budget, depth: number): RichTextBlock {
  if (depth > RICH_TEXT_MAX_DEPTH) {
    refuse(path, `blocks may nest at most ${RICH_TEXT_MAX_DEPTH} levels deep`);
  }
  spend(budget, path);
  const record = asRecord(value, path);
  const type = record['type'];
  if (typeof type !== 'string') refuse(path, 'node type must be a string');
  requireExactKeys(record, path, ['type', 'content']);
  const content = asArray(record['content'], `${path}.content`);

  switch (type) {
    case 'paragraph':
      // An empty paragraph is admissible — it is a blank line, and the document-level
      // "contains no text" check below is what refuses a message of nothing but blank lines.
      return {
        type: 'paragraph',
        content: content.map((inline, index) =>
          sanitizeInline(inline, `${path}.content[${index}]`, budget),
        ),
      };
    case 'code_block':
      return {
        type: 'code_block',
        content: content.map((node, index) => {
          const childPath = `${path}.content[${index}]`;
          spend(budget, childPath);
          const child = asRecord(node, childPath);
          if (child['type'] !== 'text') refuse(childPath, 'a code_block holds only text nodes');
          return sanitizeText(child, childPath, budget, { allowNewlines: true, allowMarks: false });
        }),
      };
    case 'blockquote': {
      if (content.length === 0) refuse(`${path}.content`, 'must not be empty');
      return {
        type: 'blockquote',
        content: content.map((block, index) =>
          sanitizeBlock(block, `${path}.content[${index}]`, budget, depth + 1),
        ),
      };
    }
    case 'bullet_list':
    case 'ordered_list': {
      if (content.length === 0) refuse(`${path}.content`, 'must not be empty');
      return {
        type,
        content: content.map((item, index) => {
          const itemPath = `${path}.content[${index}]`;
          spend(budget, itemPath);
          const record2 = asRecord(item, itemPath);
          if (record2['type'] !== 'list_item')
            refuse(itemPath, 'a list holds only list_item nodes');
          requireExactKeys(record2, itemPath, ['type', 'content']);
          const itemContent = asArray(record2['content'], `${itemPath}.content`);
          if (itemContent.length === 0) refuse(`${itemPath}.content`, 'must not be empty');
          return {
            type: 'list_item',
            content: itemContent.map((block, index2) =>
              sanitizeBlock(block, `${itemPath}.content[${index2}]`, budget, depth + 1),
            ),
          } satisfies RichTextListItem;
        }),
      };
    }
    default:
      refuse(path, `unknown block "${type}"`);
  }
}

/**
 * Admit a rich-text document whole, or refuse it with the path to the first offence.
 *
 * The returned value is rebuilt from the input rather than the input blessed by assertion, so
 * nothing outside the grammar — an extra property, a prototype, a getter — survives into what
 * gets stored.
 */
export function sanitizeRichText(input: unknown): RichTextDocument {
  const record = asRecord(input, 'doc');
  if (record['type'] !== 'doc') refuse('doc', 'the root node must have type "doc"');
  requireExactKeys(record, 'doc', ['type', 'content']);
  const content = asArray(record['content'], 'doc.content');
  if (content.length === 0) refuse('doc.content', 'must not be empty');

  const budget: Budget = { nodes: RICH_TEXT_MAX_NODES, textLength: RICH_TEXT_MAX_TEXT_LENGTH };
  const document: RichTextDocument = {
    type: 'doc',
    content: content.map((block, index) =>
      sanitizeBlock(block, `doc.content[${index}]`, budget, 1),
    ),
  };

  if (richTextToPlainText(document).length === 0) {
    refuse('doc', 'the document contains no text');
  }

  return document;
}

function inlineToPlainText(nodes: readonly RichTextInline[]): string {
  return nodes.map((node) => (node.type === 'text' ? node.text : '\n')).join('');
}

function blockToPlainText(block: RichTextBlock): string {
  switch (block.type) {
    case 'paragraph':
      return inlineToPlainText(block.content);
    case 'code_block':
      return block.content.map((node) => node.text).join('');
    case 'blockquote':
      return block.content.map(blockToPlainText).join('\n');
    case 'bullet_list':
      return block.content
        .map((item) => `- ${item.content.map(blockToPlainText).join('\n')}`)
        .join('\n');
    case 'ordered_list':
      return block.content
        .map((item, index) => `${index + 1}. ${item.content.map(blockToPlainText).join('\n')}`)
        .join('\n');
  }
}

/**
 * The plain text a rich document says — what goes into `messages.body`, what a search will
 * one day index, and what any surface that cannot render marks falls back to. Derived, so the
 * two columns cannot disagree about what was said.
 */
export function richTextToPlainText(document: RichTextDocument): string {
  return document.content.map(blockToPlainText).join('\n').trim();
}
