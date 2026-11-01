/**
 * A15 — the document editor toolbar (H1 H2 B I • List ☐ Checklist ↗ Link), as plain markdown edits
 * on the textarea at the current selection: the same model the chat composer's toolbar uses, so a
 * document body stays text the API stores as-is.
 */

export type DocToolbarEdit =
  | { readonly kind: 'wrap'; readonly before: string; readonly after: string }
  | { readonly kind: 'prefix'; readonly marker: string }
  | { readonly kind: 'link' };

export type DocToolId = 'h1' | 'h2' | 'bold' | 'italic' | 'list' | 'checklist' | 'link';

export const DOC_TOOL_EDITS: Readonly<Record<DocToolId, DocToolbarEdit>> = {
  h1: { kind: 'prefix', marker: '# ' },
  h2: { kind: 'prefix', marker: '## ' },
  bold: { kind: 'wrap', before: '**', after: '**' },
  italic: { kind: 'wrap', before: '_', after: '_' },
  list: { kind: 'prefix', marker: '- ' },
  checklist: { kind: 'prefix', marker: '- [ ] ' },
  link: { kind: 'link' },
};

/** Arabic in any region (`ar`, `ar-EG`). */
export function isArabic(locale: string): boolean {
  return locale === 'ar' || locale.startsWith('ar-');
}

/**
 * The formatting tag. The catalog draws "16 Oct 2026" / "16 أكتوبر 2026": day-first English and
 * Arabic with Latin digits; any other language formats as chosen.
 */
export function tagFor(locale: string): string {
  if (isArabic(locale)) return 'ar-u-nu-latn';
  return locale === 'en' || locale.startsWith('en-') ? 'en-GB' : locale;
}

export interface DocEditResult {
  readonly text: string;
  /** Where the caret goes after the edit (the end of the selection). */
  readonly caret: number;
  /**
   * Where the selection starts after the edit. Equal to `caret` except when a placeholder was
   * inserted ("**text**", "[text](https://)"): then the placeholder is selected, so the next typed
   * word replaces it instead of landing beside it (live test 2026-10-31).
   */
  readonly selectionStart: number;
}

/** Apply one toolbar edit to `text` at the selection `[start, end)`. */
export function applyDocEdit(
  text: string,
  start: number,
  end: number,
  edit: DocToolbarEdit,
  placeholder = 'text',
): DocEditResult {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);

  if (edit.kind === 'wrap') {
    const inner = selected || placeholder;
    const next = `${before}${edit.before}${inner}${edit.after}${after}`;
    const innerStart = before.length + edit.before.length;
    const innerEnd = innerStart + inner.length;
    return { text: next, caret: innerEnd, selectionStart: selected ? innerEnd : innerStart };
  }
  if (edit.kind === 'link') {
    const label = selected || placeholder;
    const inserted = `[${label}](https://)`;
    if (selected) {
      // The label is there: put the caret inside the empty address, after "https://".
      const caret = before.length + inserted.length - 1;
      return { text: `${before}${inserted}${after}`, caret, selectionStart: caret };
    }
    // No selection: select the label placeholder so typing names the link.
    const labelStart = before.length + 1;
    return {
      text: `${before}${inserted}${after}`,
      caret: labelStart + label.length,
      selectionStart: labelStart,
    };
  }
  // Prefix every line the selection touches, from the start of its first line.
  const lineStart = before.lastIndexOf('\n') + 1;
  const head = text.slice(0, lineStart);
  const target = text.slice(lineStart, end);
  const prefixed = target
    .split('\n')
    .map((line) => `${edit.marker}${line}`)
    .join('\n');
  const caret = head.length + prefixed.length;
  return { text: `${head}${prefixed}${after}`, caret, selectionStart: caret };
}

/** One entry of the "/" menu (Figma 446:35321): the toolbar edit it applies. */
export interface SlashCommand {
  readonly id: DocToolId;
  readonly key: string;
  readonly english: string;
  readonly glyph: string;
  /** Extra words a typed filter matches ("/head", "/todo"). */
  readonly words: readonly string[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'h1',
    key: 'DocumentEditorScreen.slashH1',
    english: 'Heading 1',
    glyph: 'H1',
    words: ['heading', 'title', 'h1'],
  },
  {
    id: 'h2',
    key: 'DocumentEditorScreen.slashH2',
    english: 'Heading 2',
    glyph: 'H2',
    words: ['heading', 'subtitle', 'h2'],
  },
  {
    id: 'list',
    key: 'DocumentEditorScreen.slashList',
    english: 'Bulleted list',
    glyph: '•',
    words: ['list', 'bullet'],
  },
  {
    id: 'checklist',
    key: 'DocumentEditorScreen.slashChecklist',
    english: 'Checklist',
    glyph: '☐',
    words: ['checklist', 'todo', 'task'],
  },
  {
    id: 'link',
    key: 'DocumentEditorScreen.slashLink',
    english: 'Link',
    glyph: '↗',
    words: ['link', 'url'],
  },
];

/** The commands a "/query" still matches, by label or extra word, in menu order. */
export function filterSlashCommands(
  query: string,
  labelOf: (command: SlashCommand) => string,
): readonly SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === '') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) =>
      labelOf(command).toLowerCase().includes(q) ||
      command.english.toLowerCase().includes(q) ||
      command.words.some((word) => word.startsWith(q)),
  );
}

/**
 * Where a "/" menu opens: the "/" just typed at `caret - 1` starts a line or follows a space, so a
 * path such as "and/or" or "https://" never opens it. Returns the slash's index, or -1.
 */
export function slashTriggerAt(text: string, caret: number): number {
  const at = caret - 1;
  if (at < 0 || text[at] !== '/') return -1;
  const previous = at === 0 ? '\n' : text[at - 1];
  return previous === '\n' || previous === ' ' || previous === '\t' ? at : -1;
}

/** One block of a line diff: lines only in the old text, or only in the new one. */
export interface DiffBlock {
  readonly kind: 'added' | 'removed';
  readonly lines: readonly string[];
}

/**
 * A line diff from `before` to `after` (longest common subsequence), grouped into runs of added
 * and removed lines — the Compare panel of DOC-03 (Figma 145:224). Blank lines are ignored.
 */
export function diffLines(before: string, after: string): readonly DiffBlock[] {
  const a = before.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const b = after.split(/\r?\n/u).filter((line) => line.trim() !== '');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const blocks: DiffBlock[] = [];
  const push = (kind: DiffBlock['kind'], line: string) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) (last.lines as string[]).push(line);
    else blocks.push({ kind, lines: [line] });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i >= a.length || (table[i * cols + j + 1] ?? 0) >= (table[(i + 1) * cols + j] ?? 0))
    ) {
      push('added', b[j] as string);
      j += 1;
    } else {
      push('removed', a[i] as string);
      i += 1;
    }
  }
  return blocks;
}

/** A blank document's body (a lone newline the API needed) reads as empty in the editor. */
export function isBlankBody(body: string): boolean {
  return body.trim() === '';
}

/** "16 Oct 2026" / "16 أكتوبر 2026" — Latin digits in Arabic, as the catalog draws dates. */
export function formatDocDay(iso: string, locale: string, month: 'short' | 'long' = 'short') {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(tagFor(locale), {
    day: 'numeric',
    month: isArabic(locale) ? 'long' : month,
    year: 'numeric',
  }).format(at);
}

/** "24 Oct" / "24 أكتوبر" — a due day without the year. */
export function formatDocShortDay(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(tagFor(locale), {
    day: 'numeric',
    month: isArabic(locale) ? 'long' : 'short',
  }).format(at);
}

/** "15 Oct, 10:51" — a message's day and time. */
export function formatDocMoment(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(tagFor(locale), {
    day: 'numeric',
    month: isArabic(locale) ? 'long' : 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

/** The initials orb's letters: two Latin initials, or one Arabic letter. */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const count = /\p{Script=Arabic}/u.test(name) ? 1 : 2;
  return parts
    .slice(0, count)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
}

/** A line mixing Arabic with Latin words starts with U+200F so it lays out right-to-left. */
export function rtlLine(text: string, locale: string): string {
  return isArabic(locale) && /[A-Za-z]/u.test(text) ? `\u200F${text}` : text;
}
