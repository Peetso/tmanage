/**
 * 53-17 — Arabic search normalisation, applied to both sides of a match.
 *
 * An Arabic word is written many ways that a reader treats as the same word: hamza on or under
 * the alef (أ / إ / آ / ٱ), a final taa marbuta or haa (ة / ه), a final dotless or dotted ya
 * (ى / ي), hamza seats (ؤ / ئ), short-vowel marks and the tatweel stretch (ـ). A query typed one
 * way must find text stored another way, so the same fold runs on the query (in TypeScript) and on
 * the stored text (as nested `REPLACE` calls in the statement) — one table drives both.
 *
 * No generated column, no functional index and no migration: the fold is computed at read time on
 * the bounded, tenant-scoped scans the search already runs. It is applied only when the query
 * itself holds Arabic letters, so a Latin search keeps its plain `LIKE`.
 */

/** Marks removed outright: the eight harakat (U+064B–U+0652), the dagger alef and the tatweel. */
const REMOVED: readonly string[] = ['ً', 'ٌ', 'ٍ', 'َ', 'ُ', 'ِ', 'ّ', 'ْ', 'ٰ', 'ـ'];

/** Letter forms folded onto one letter. */
const FOLDED: ReadonlyArray<readonly [string, string]> = [
  ['أ', 'ا'], // أ → ا
  ['إ', 'ا'], // إ → ا
  ['آ', 'ا'], // آ → ا
  ['ٱ', 'ا'], // ٱ → ا
  ['ة', 'ه'], // ة → ه
  ['ى', 'ي'], // ى → ي
  ['ی', 'ي'], // ی → ي (Persian ya, common from some keyboards)
  ['ؤ', 'و'], // ؤ → و
  ['ئ', 'ي'], // ئ → ي
];

/** The whole fold, in application order: `[from, to]` pairs, removals first. */
export const ARABIC_FOLDS: ReadonlyArray<readonly [string, string]> = [
  ...REMOVED.map((mark) => [mark, ''] as const),
  ...FOLDED,
];

const ARABIC_LETTER = /[؀-ۿ]/;

/** Whether the text holds any Arabic-block character (letters or marks). */
export function hasArabic(text: string): boolean {
  return ARABIC_LETTER.test(text);
}

/** Fold one string exactly as `foldedColumn` (`search-text-match.repository.ts`) folds a stored value. */
export function normaliseArabic(text: string): string {
  let out = text;
  for (const [from, to] of ARABIC_FOLDS) out = out.split(from).join(to);
  return out;
}

/** Escape the LIKE metacharacters so a query is matched literally (MySQL/MariaDB default escape). */
export function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}
