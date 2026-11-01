/**
 * R12 (R2, SPEC D6). The interface language to suggest for a visitor: from the country their
 * address is in when that country speaks one of TManage's languages unambiguously, otherwise from
 * `Accept-Language`, otherwise `en-US`. Pure — no I/O.
 */
export type SuggestedLocale =
  'en-US' | 'en-GB' | 'es-ES' | 'fr-FR' | 'pt-BR' | 'de-DE' | 'zh-CN' | 'ar-EG';

export const DEFAULT_SUGGESTED_LOCALE: SuggestedLocale = 'en-US';

const SPANISH = 'ES MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY';
/** The 22 members of the Arab League. */
const ARAB_LEAGUE = 'DZ BH KM DJ EG IQ JO KW LB LY MR MA OM PS QA SA SO SD SY TN AE YE';

const BY_COUNTRY: ReadonlyMap<string, SuggestedLocale> = new Map([
  ...codes(SPANISH, 'es-ES'),
  ...codes('FR MC', 'fr-FR'),
  ...codes('BR PT AO MZ', 'pt-BR'),
  ...codes('DE AT', 'de-DE'),
  ...codes('CN', 'zh-CN'),
  ...codes(ARAB_LEAGUE, 'ar-EG'),
  ...codes('GB IE AU NZ ZA IN', 'en-GB'),
  ...codes('US', 'en-US'),
]);

function codes(list: string, locale: SuggestedLocale): [string, SuggestedLocale][] {
  return list.split(' ').map((code) => [code, locale]);
}

/**
 * The locale a country speaks unambiguously, or `null` — for a multilingual country
 * (CH, BE, CA, LU, SG, HK, TW…) and for any country not listed.
 */
export function localeForCountry(countryCode: string | null | undefined): SuggestedLocale | null {
  if (typeof countryCode !== 'string') return null;
  return BY_COUNTRY.get(countryCode.trim().toUpperCase()) ?? null;
}

/** The best supported locale in an `Accept-Language` header (q-sorted), or `null`. */
export function localeForAcceptLanguage(header: string | null | undefined): SuggestedLocale | null {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.tag !== '' && entry.tag !== '*' && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const found = localeOfTag(tag);
    if (found) return found;
  }
  return null;
}

function localeOfTag(tag: string): SuggestedLocale | null {
  const [primary = '', region = ''] = tag.split(/[-_]/);
  switch (primary) {
    case 'en':
      return ['gb', 'ie', 'au', 'nz', 'za', 'in'].includes(region) ? 'en-GB' : 'en-US';
    case 'es':
      return 'es-ES';
    case 'fr':
      return 'fr-FR';
    case 'pt':
      return 'pt-BR';
    case 'de':
      return 'de-DE';
    case 'zh':
      return 'zh-CN';
    case 'ar':
      return 'ar-EG';
    default:
      return null;
  }
}
