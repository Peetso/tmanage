import type { DisplayLocale } from '../api/display-preferences';
import { localeDirection, type TextDirection } from './direction';
import { translate, type MessageKey } from './t';

/**
 * What the root layout renders from the request's locale (`server-locale.ts`): the `<html>`
 * attributes and the site description. Pure, so it is unit-tested without a request.
 *
 * `htmlLocaleAttributes` gives the `<html>` attributes the root layout renders for `locale`.
 */
export function htmlLocaleAttributes(locale: DisplayLocale): {
  readonly lang: DisplayLocale;
  readonly dir: TextDirection;
} {
  return { lang: locale, dir: localeDirection(locale) };
}

/** The site description in English (the root layout's `metadata.description`). */
export const SITE_DESCRIPTION_EN = 'The work operating system for service teams and their clients.';

/** Catalog key for the site description (added in wave6/i18n-E3.*.json). */
const SITE_DESCRIPTION_KEY = 'PublicSite.metaDescription';

/** The site description in `locale`; English until the catalog carries the key. */
export function siteDescription(locale: DisplayLocale): string {
  const value = translate(locale, SITE_DESCRIPTION_KEY as MessageKey);
  return value === SITE_DESCRIPTION_KEY ? SITE_DESCRIPTION_EN : value;
}
