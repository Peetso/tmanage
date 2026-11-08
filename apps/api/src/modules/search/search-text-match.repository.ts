import { like, sql } from 'drizzle-orm';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { ARABIC_FOLDS, hasArabic, likePattern, normaliseArabic } from './search-normalise.js';

/**
 * 53-17 — the SQL side of the Arabic fold (`search-normalise.ts`): the stored column is folded with
 * the same table as the query, as nested `REPLACE` calls, only when the query is Arabic.
 */

/** The stored value with the same fold applied, as SQL (`REPLACE(REPLACE(col, ?, ?), ?, ?)…`). */
export function foldedColumn(column: SQLWrapper): SQL {
  let expression: SQL = sql`${column}`;
  for (const [from, to] of ARABIC_FOLDS) {
    expression = sql`REPLACE(${expression}, ${from}, ${to})`;
  }
  return expression;
}

/**
 * A prepared matcher for one query: the folded pattern, and a column predicate that folds the
 * column too when (and only when) the query is Arabic.
 */
export interface TextMatcher {
  readonly pattern: string;
  readonly arabic: boolean;
  matches(column: SQLWrapper): SQL;
}

export function textMatcher(query: string): TextMatcher {
  const folded = normaliseArabic(query);
  const arabic = hasArabic(folded);
  const pattern = likePattern(folded);
  return {
    pattern,
    arabic,
    matches: (column) => like(arabic ? foldedColumn(column) : sql`${column}`, pattern),
  };
}
