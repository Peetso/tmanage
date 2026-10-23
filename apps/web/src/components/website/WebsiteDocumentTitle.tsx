'use client';

import { useEffect } from 'react';
import { translate, type MessageKey } from '../../lib/i18n/t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';

/**
 * The public site's tab title, in the active locale (live recheck 2026-10-23).
 *
 * The pages are static, so every route's `metadata.title` is English and the server sends
 * `Pricing · TManage` whatever the visitor's language. The locale is a browser choice
 * (`locale-boot.ts`), so the title can only follow it in the browser: this component reads the
 * English title Next wrote, looks its page name up in the catalog and writes the Arabic one. A
 * `MutationObserver` on `<head>` catches Next replacing the title after a client navigation.
 */

const SUFFIX = ' · TManage';
const HOME_PREFIX = 'TManage — ';

/** English page name (the route's `metadata.title`) → catalog key. */
export const WEBSITE_TITLE_KEYS: Readonly<Record<string, string>> = {
  About: 'WebsiteTitle.about',
  Changelog: 'WebsiteTitle.changelog',
  'Client portal': 'WebsiteTitle.clientPortal',
  'Book a demo': 'WebsiteTitle.contact',
  'Customers & stories': 'WebsiteTitle.customers',
  FAQ: 'WebsiteTitle.faq',
  'Chat & calendar': 'WebsiteTitle.featuresCommunication',
  'Insights & automations': 'WebsiteTitle.featuresInsights',
  'Docs, decisions & approvals': 'WebsiteTitle.featuresKnowledge',
  'Work, requests & projects': 'WebsiteTitle.featuresWork',
  Integrations: 'WebsiteTitle.integrations',
  Pricing: 'WebsiteTitle.pricing',
  'Product overview': 'WebsiteTitle.product',
  Resources: 'WebsiteTitle.resources',
  'Security & trust': 'WebsiteTitle.security',
  'Agencies & studios': 'WebsiteTitle.solutionsAgencies',
  Consultancies: 'WebsiteTitle.solutionsConsultancies',
  'In-house teams': 'WebsiteTitle.solutionsInHouse',
  'Service status': 'WebsiteTitle.status',
  'Page not found': 'WebsiteTitle.notFound',
  'Access denied': 'WebsiteTitle.forbidden',
  Offline: 'WebsiteTitle.offline',
};

/** The home page's absolute title is the brand plus its hero line. */
const HOME_TITLE_KEY: MessageKey = 'HomePage.heroTitle';

/** The catalog string, or `undefined` while the key is not in the catalogs yet. */
function lookup(locale: string, key: string): string | undefined {
  const value = translate(locale, key as MessageKey);
  return value === key ? undefined : value;
}

/**
 * `englishTitle` as it reads in `locale`, or `undefined` when the page name is not one this
 * table knows (the title is then left as Next wrote it).
 */
export function localizedWebsiteTitle(englishTitle: string, locale: string): string | undefined {
  if (englishTitle === `${HOME_PREFIX}${translate('en-US', HOME_TITLE_KEY)}`) {
    return `${HOME_PREFIX}${translate(locale, HOME_TITLE_KEY)}`;
  }
  if (!englishTitle.endsWith(SUFFIX)) return undefined;
  const key = WEBSITE_TITLE_KEYS[englishTitle.slice(0, -SUFFIX.length)];
  if (key === undefined) return undefined;
  const name = lookup(locale, key);
  return name === undefined ? undefined : `${name}${SUFFIX}`;
}

export function WebsiteDocumentTitle() {
  const locale = useActiveLocale();

  useEffect(() => {
    let english = document.title;
    let applied: string | undefined;

    const apply = () => {
      const current = document.title;
      // A title this component did not write is Next's English title for the current route.
      if (current !== applied) english = current;
      const next = localizedWebsiteTitle(english, locale) ?? english;
      applied = next;
      if (next !== current) document.title = next;
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (document.title === applied) document.title = english;
    };
  }, [locale]);

  return null;
}
