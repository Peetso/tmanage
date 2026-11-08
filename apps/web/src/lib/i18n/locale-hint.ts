import type { ApiClient } from '../api/client';
import { OFFERED_LOCALES, type OfferedLocale } from './catalog-status';

/**
 * R12 / R2 — the first-visit language guess (Figma "Languages (R2)" 501:29333).
 *
 * Asked once, only when the tab boots with no saved language (`LocaleStore.bootedWithoutChoice`):
 * the API's `GET /v1/public/locale-hint` (country from the IP, else the request's Accept-Language),
 * then — on a 404, an error or no network — the browser's own `navigator.languages`, then `en-US`.
 * Whatever comes back is mapped onto {@link OFFERED_LOCALES}, so a guess can never select a
 * language without a catalog.
 */

export interface LocaleHint {
  readonly locale: OfferedLocale;
  readonly source: 'geo' | 'accept-language' | 'browser' | 'default';
}

/** The offered locale a BCP-47 tag maps to, or `undefined` (Traditional Chinese has no catalog). */
export function offeredLocaleFor(tag: string | null | undefined): OfferedLocale | undefined {
  if (typeof tag !== 'string' || tag === '') return undefined;
  const exact = OFFERED_LOCALES.find((locale) => locale.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  const [primary = '', ...rest] = tag.toLowerCase().split('-');
  switch (primary) {
    case 'en':
      return rest.includes('gb') ? 'en-GB' : 'en-US';
    case 'ar':
      return 'ar-EG';
    case 'es':
      return 'es-ES';
    case 'fr':
      return 'fr-FR';
    case 'pt':
      return 'pt-BR';
    case 'de':
      return 'de-DE';
    case 'zh':
      return rest.some((part) => ['tw', 'hk', 'mo', 'hant'].includes(part)) ? undefined : 'zh-CN';
    case 'ur':
      return 'ur-PK';
    default:
      return undefined;
  }
}

/**
 * The guess: the API's answer when it names an offered locale, else the first browser language
 * that maps to one, else `en-US`. `ask` rejecting (404, offline) is the normal fallback path.
 */
export async function resolveLocaleHint(
  ask: () => Promise<unknown>,
  browserLanguages: readonly string[],
): Promise<LocaleHint> {
  try {
    const answer = (await ask()) as { locale?: unknown; source?: unknown } | null;
    const locale = offeredLocaleFor(typeof answer?.locale === 'string' ? answer.locale : null);
    if (locale) {
      const source = answer?.source === 'geo' ? 'geo' : 'accept-language';
      return { locale, source };
    }
  } catch {
    // The hint route is missing or the network is down: the browser's languages decide.
  }
  for (const tag of browserLanguages) {
    const locale = offeredLocaleFor(tag);
    if (locale) return { locale, source: 'browser' };
  }
  return { locale: 'en-US', source: 'default' };
}

/** The live question: the API route through the app's client, the browser's language list. */
export function askLocaleHint(client: ApiClient): Promise<LocaleHint> {
  const languages =
    typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language];
  return resolveLocaleHint(
    async () => (await client.request<unknown>({ path: '/v1/public/locale-hint' })).data,
    languages,
  );
}
