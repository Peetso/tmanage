/**
 * A count in the locale's plural form (R34 D1/D2). The catalogs keep one key per CLDR category
 * under a base — `<base>.zero|one|two|few|many|other` — because Arabic has six forms and English
 * two. `{count}` in the chosen string is filled with `display` (the number in the locale's digits
 * by default; a caller may pass "50+"). Until a key reaches the catalogs, the English pair is used.
 */
export function pluralPhrase(
  tr: (key: string, english: string) => string,
  locale: string,
  base: string,
  count: number,
  english: { readonly one: string; readonly other: string },
  display: string = count.toLocaleString(locale),
): string {
  const category = new Intl.PluralRules(locale).select(count);
  const fallback = category === 'one' ? english.one : english.other;
  return tr(`${base}.${category}`, fallback).replace(/\{count\}/gu, display);
}
