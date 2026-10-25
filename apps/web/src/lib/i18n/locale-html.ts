import type { DisplayLocale } from '../api/display-preferences';
import { translate, type MessageKey } from './t';

/**
 * The site description in English: the root layout's static `metadata.description` (the layout
 * reads no request, so the public pages stay prerendered).
 */
export const SITE_DESCRIPTION_EN = 'The work operating system for service teams and their clients.';

/** Catalog key for the site description (added in wave6/i18n-E3.*.json). */
const SITE_DESCRIPTION_KEY = 'PublicSite.metaDescription';

/** The site description in `locale`; English until the catalog carries the key. */
export function siteDescription(locale: DisplayLocale): string {
  const value = translate(locale, SITE_DESCRIPTION_KEY as MessageKey);
  return value === SITE_DESCRIPTION_KEY ? SITE_DESCRIPTION_EN : value;
}
