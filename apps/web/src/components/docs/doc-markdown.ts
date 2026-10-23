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
  /** Where the caret goes after the edit. */
  readonly caret: number;
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
    return { text: next, caret: before.length + edit.before.length + inner.length };
  }
  if (edit.kind === 'link') {
    const label = selected || placeholder;
    const inserted = `[${label}](https://)`;
    return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length - 1 };
  }
  // Prefix every line the selection touches, from the start of its first line.
  const lineStart = before.lastIndexOf('\n') + 1;
  const head = text.slice(0, lineStart);
  const target = text.slice(lineStart, end);
  const prefixed = target
    .split('\n')
    .map((line) => `${edit.marker}${line}`)
    .join('\n');
  return { text: `${head}${prefixed}${after}`, caret: head.length + prefixed.length };
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
