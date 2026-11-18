/**
 * "{n} minutes" in Arabic, by the Arabic plural rules (CLDR via `Intl.PluralRules`): one and two
 * have their own words, 3–10 take the plural دقائق, 11 and up the singular دقيقة. The two form is
 * the genitive (دقيقتين) because every sentence that uses it reads "خلال …" / "بعد …".
 */
const RULES = new Intl.PluralRules('ar');

export function arabicMinutes(count: number): string {
  switch (RULES.select(count)) {
    case 'one':
      return 'دقيقة واحدة';
    case 'two':
      return 'دقيقتين';
    case 'few':
      return `${count} دقائق`;
    default:
      return `${count} دقيقة`;
  }
}
