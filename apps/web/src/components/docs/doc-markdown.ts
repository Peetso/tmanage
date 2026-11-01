/**
 * Shared helpers of the docs screens: locale tags and day formats, initials, the line diff of
 * Compare, and the U+200F mark for mixed Arabic lines. (The textarea toolbar and "/" menu that
 * lived here went with R5's rich editor, `editor/`.)
 */

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
