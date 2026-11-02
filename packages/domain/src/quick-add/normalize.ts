import { toLatinDigits } from './numerals.js';

/**
 * 55-25 — Arabic-aware name normalisation, shared with 53-17 (search) so a person typed as
 * «ساره» finds «سارة» and «احمد» finds «أحمد».
 *
 * - strips tashkeel (U+064B–065F, U+0670) and tatweel (U+0640);
 * - unifies أ / إ / آ / ٱ → ا, ة → ه, ى → ي;
 * - drops bidi marks (LRM, RLM, ALM, isolates), folds digits to Latin and case to lower;
 * - «ال» is kept: «العنود» is not «عنود».
 */

const TASHKEEL = /[\u064B-\u065F\u0670\u0640]/g;
const BIDI_MARKS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;

export function normalizeArabic(text: string): string {
  return text
    .replace(TASHKEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

/** The comparable form of a person or project name: Arabic-normalised, lower case, one space. */
export function normalizeName(text: string): string {
  return toLatinDigits(normalizeArabic(text.normalize('NFC')))
    .replace(BIDI_MARKS, '')
    .replace(/[_.-]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether `query` is a prefix of `name` or of any word in it, after normalisation. */
export function nameMatches(query: string, name: string): boolean {
  const q = normalizeName(query);
  if (q === '') return false;
  const n = normalizeName(name);
  return n.startsWith(q) || ` ${n}`.includes(` ${q}`);
}

export interface NameCandidate {
  readonly id: string;
  readonly label: string;
}

/**
 * The entries `query` names, best first (an exact name, then a whole-name prefix, then a word
 * prefix; shorter and then alphabetical within each), at most `limit`.
 */
export function matchCandidates<T extends NameCandidate>(
  query: string,
  entries: readonly T[],
  limit = 5,
): readonly T[] {
  const q = normalizeName(query);
  if (q === '') return [];
  const rank = (label: string): number => {
    const n = normalizeName(label);
    if (n === q) return 0;
    return n.startsWith(q) ? 1 : 2;
  };
  return entries
    .filter((entry) => nameMatches(q, entry.label))
    .map((entry) => ({ entry, rank: rank(entry.label) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entry.label.length - b.entry.label.length ||
        a.entry.label.localeCompare(b.entry.label) ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .slice(0, Math.max(0, limit))
    .map((ranked) => ranked.entry);
}

/** One entry when the query names exactly one (or exactly one by its whole name), else null. */
export function uniqueCandidate<T extends NameCandidate>(
  query: string,
  matches: readonly T[],
): T | null {
  if (matches.length === 1) return matches[0] ?? null;
  const q = normalizeName(query);
  const exact = matches.filter((entry) => normalizeName(entry.label) === q);
  return exact.length === 1 ? (exact[0] ?? null) : null;
}
