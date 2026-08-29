import type {
  RichTextBlock,
  RichTextDocument,
  RichTextInline,
  RichTextListItem,
  RichTextMark,
  RichTextText,
} from '@tmanage/domain';

/**
 * The composer's notation, and its one-way conversion into CHAT-002's closed grammar —
 * WEB-003's second half.
 *
 * The API accepts `bodyRich` — a JSON tree validated against a closed grammar — and never
 * HTML (`rich-text.ts` in `packages/domain` says why at length). A composer therefore
 * cannot be a `contenteditable` surface that harvests markup: whatever the person writes
 * has to become grammar nodes *here*, deterministically, before anything is sent. So the
 * composer keeps the plain `<textarea>` and defines a small notation over it; the toolbar
 * inserts the notation, this module converts it, the preview renders the converted
 * document through the same `RichTextBody` the transcript uses, and the API receives the
 * grammar. **The notation itself never leaves the browser.**
 *
 * The notation, complete:
 *
 *     blank line          — paragraph break
 *     single newline      — hard break within a paragraph
 *     `- ` line prefix    — bullet list item
 *     `1. ` line prefix   — ordered list item (any number)
 *     `> ` line prefix    — blockquote
 *     ``` fence lines     — code block, verbatim between them
 *     **text**            — bold
 *     _text_              — italic (word boundaries only, so snake_case survives)
 *     ~~text~~            — strikethrough
 *     `text`              — inline code (nothing inside it is notation)
 *     [label](https://…)  — link; http, https and mailto only, matching the grammar
 *
 * Two rules keep it honest:
 *
 * - **Unmatched notation is literal.** A lone `**` or a link whose scheme the grammar
 *   refuses stays exactly as typed, in the preview and in the message. Nothing is repaired
 *   or dropped — the same refusal-over-repair stance as the sanitiser, applied one step
 *   earlier.
 * - **A message that uses no notation stays plain.** `compose` answers `plain`, the send
 *   carries `body`, and the transcript renders it as text with its line breaks — a rich
 *   document wrapping unformatted text would say something false about what was written.
 */

export type ComposedMessage =
  | { readonly kind: 'plain'; readonly body: string }
  | { readonly kind: 'rich'; readonly document: RichTextDocument; readonly plainText: string };

/** `1. `, `12. ` — up to three digits keeps a date like `2026.` from becoming a list. */
const ORDERED_PREFIX = /^\d{1,3}\.\s/;

const LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

interface InlineResult {
  readonly inlines: RichTextInline[];
  readonly formatted: boolean;
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_]/u.test(value);
}

function pushText(target: RichTextInline[], text: string, marks?: readonly RichTextMark[]): void {
  if (text === '') return;
  const previous = target[target.length - 1];
  // Coalesce adjacent unmarked runs so literal fallbacks don't fragment the node list.
  if (
    marks === undefined &&
    previous !== undefined &&
    previous.type === 'text' &&
    previous.marks === undefined
  ) {
    target[target.length - 1] = { type: 'text', text: previous.text + text };
    return;
  }
  target.push(marks === undefined ? { type: 'text', text } : { type: 'text', text, marks });
}

/** A delimited span: the closing delimiter's index, or -1. Content must be non-empty. */
function closingIndex(line: string, from: number, delimiter: string): number {
  const at = line.indexOf(delimiter, from);
  return at > from ? at : -1;
}

function linkAt(line: string, start: number): { label: string; href: string; end: number } | null {
  const labelEnd = line.indexOf(']', start + 1);
  if (labelEnd <= start + 1) return null;
  if (line[labelEnd + 1] !== '(') return null;
  const hrefEnd = line.indexOf(')', labelEnd + 2);
  if (hrefEnd <= labelEnd + 2) return null;
  const href = line.slice(labelEnd + 2, hrefEnd);
  try {
    if (!LINK_SCHEMES.includes(new URL(href).protocol)) return null;
  } catch {
    return null;
  }
  return { label: line.slice(start + 1, labelEnd), href, end: hrefEnd };
}

/**
 * One line of paragraph text into inline nodes. Marks do not nest — the content of a span
 * is plain — which is a smaller promise than an editor makes and exactly as much as a
 * notation this size can keep unambiguous.
 */
function parseInline(line: string): InlineResult {
  const inlines: RichTextInline[] = [];
  let formatted = false;
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    if (rest.startsWith('`')) {
      const end = closingIndex(line, index + 1, '`');
      if (end !== -1) {
        pushText(inlines, line.slice(index + 1, end), [{ type: 'code' }]);
        formatted = true;
        index = end + 1;
        continue;
      }
    }

    if (rest.startsWith('**')) {
      const end = line.indexOf('**', index + 2);
      if (end > index + 2) {
        pushText(inlines, line.slice(index + 2, end), [{ type: 'bold' }]);
        formatted = true;
        index = end + 2;
        continue;
      }
    }

    if (rest.startsWith('~~')) {
      const end = line.indexOf('~~', index + 2);
      if (end > index + 2) {
        pushText(inlines, line.slice(index + 2, end), [{ type: 'strike' }]);
        formatted = true;
        index = end + 2;
        continue;
      }
    }

    if (rest.startsWith('_') && !isWordChar(line[index - 1])) {
      // Italic only opens at a word boundary and only closes at one, so `snake_case_name`
      // is never half-italicised.
      let end = line.indexOf('_', index + 1);
      while (end !== -1 && isWordChar(line[end + 1])) end = line.indexOf('_', end + 1);
      if (end > index + 1) {
        pushText(inlines, line.slice(index + 1, end), [{ type: 'italic' }]);
        formatted = true;
        index = end + 1;
        continue;
      }
    }

    if (rest.startsWith('[')) {
      const link = linkAt(line, index);
      if (link !== null) {
        pushText(inlines, link.label, [{ type: 'link', href: link.href }]);
        formatted = true;
        index = link.end + 1;
        continue;
      }
    }

    pushText(inlines, line[index] as string);
    index += 1;
  }

  return { inlines, formatted };
}

/** Consecutive lines into one paragraph, single newlines becoming hard breaks. */
function paragraphOf(lines: readonly string[]): { block: RichTextBlock; formatted: boolean } {
  const content: RichTextInline[] = [];
  let formatted = false;
  lines.forEach((line, position) => {
    if (position > 0) content.push({ type: 'hard_break' });
    const parsed = parseInline(line);
    content.push(...parsed.inlines);
    formatted = formatted || parsed.formatted;
  });
  return { block: { type: 'paragraph', content }, formatted };
}

/**
 * The whole textarea into a composed message.
 *
 * The caller trims and refuses an empty draft before asking; this function assumes
 * non-empty text. `\r` is dropped up front — the grammar refuses it everywhere, and a
 * Windows clipboard should not be able to make a message inadmissible.
 */
export function composeMessage(text: string): ComposedMessage {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: RichTextBlock[] = [];
  let formatted = false;
  let index = 0;

  const plainLines: string[] = [];

  while (index < lines.length) {
    const line = lines[index] as string;

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (line.trim() === '```') {
      // Verbatim until the closing fence — or the end, so an unclosed fence still means
      // "this was code" rather than becoming a paragraph that starts with backticks.
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] as string).trim() !== '```') {
        codeLines.push(lines[index] as string);
        index += 1;
      }
      index += 1; // Past the closing fence, when there was one.
      const code = codeLines.join('\n');
      const content: RichTextText[] = code === '' ? [] : [{ type: 'text', text: code }];
      blocks.push({ type: 'code_block', content });
      plainLines.push(code);
      formatted = true;
      continue;
    }

    if (line.startsWith('- ')) {
      const items: RichTextListItem[] = [];
      while (index < lines.length && (lines[index] as string).startsWith('- ')) {
        const itemText = (lines[index] as string).slice(2);
        const paragraph = paragraphOf([itemText]);
        items.push({ type: 'list_item', content: [paragraph.block] });
        plainLines.push(itemText);
        index += 1;
      }
      blocks.push({ type: 'bullet_list', content: items });
      formatted = true;
      continue;
    }

    if (ORDERED_PREFIX.test(line)) {
      const items: RichTextListItem[] = [];
      while (index < lines.length && ORDERED_PREFIX.test(lines[index] as string)) {
        const itemText = (lines[index] as string).replace(ORDERED_PREFIX, '');
        const paragraph = paragraphOf([itemText]);
        items.push({ type: 'list_item', content: [paragraph.block] });
        plainLines.push(itemText);
        index += 1;
      }
      blocks.push({ type: 'ordered_list', content: items });
      formatted = true;
      continue;
    }

    if (line.startsWith('> ') || line === '>') {
      const quoted: string[] = [];
      while (
        index < lines.length &&
        ((lines[index] as string).startsWith('> ') || (lines[index] as string) === '>')
      ) {
        quoted.push((lines[index] as string) === '>' ? '' : (lines[index] as string).slice(2));
        index += 1;
      }
      const paragraph = paragraphOf(quoted);
      blocks.push({ type: 'blockquote', content: [paragraph.block] });
      plainLines.push(...quoted);
      formatted = true;
      continue;
    }

    // A paragraph: this line and every following one until a blank line or a block marker.
    const runOn: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] as string;
      if (
        candidate.trim() === '' ||
        candidate.trim() === '```' ||
        candidate.startsWith('- ') ||
        candidate.startsWith('> ') ||
        candidate === '>' ||
        ORDERED_PREFIX.test(candidate)
      ) {
        break;
      }
      runOn.push(candidate);
      index += 1;
    }
    const paragraph = paragraphOf(runOn);
    blocks.push(paragraph.block);
    plainLines.push(...runOn);
    formatted = formatted || paragraph.formatted;
  }

  if (!formatted || blocks.length === 0) {
    return { kind: 'plain', body: text };
  }
  return {
    kind: 'rich',
    document: { type: 'doc', content: blocks },
    plainText: plainLines.join('\n'),
  };
}
