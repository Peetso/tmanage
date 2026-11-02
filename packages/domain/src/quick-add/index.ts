// 55-25 — the quick-add parser (English + Arabic), its numerals and the shared name normaliser.
export { parseQuickAdd, QUICK_ADD_MAX_LENGTH } from './parse.js';
export type { QuickAddOptions, QuickAddResult, QuickAddToken, QuickAddTokenKind } from './parse.js';
export type { QuickAddPriority, RelativeDate } from './tokens.js';
export { digitsFor, toArabicDigits, toLatinDigits } from './numerals.js';
export {
  matchCandidates,
  nameMatches,
  normalizeArabic,
  normalizeName,
  uniqueCandidate,
} from './normalize.js';
export type { NameCandidate } from './normalize.js';
