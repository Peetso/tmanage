import type { Metadata } from 'next';
import { describe, expect, it } from 'vitest';
import { ALL_RESOURCES } from '../src/components/website/pages/resources/resources-data';
import { ALTERNATIVE_COPY } from '../src/content/alternatives/alternative-copy';
import { ALTERNATIVE_PAGES } from '../src/content/alternatives/alternative-entries';
import { FACTS_COPY } from '../src/content/facts/facts';
import { COMPARE_COPY, SWITCH_COPY } from '../src/content/compare/compare-copy';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { SWITCH_ENTRIES } from '../src/content/compare/switch-entries';
import { HELP_ARTICLES } from '../src/content/help/help-articles';
import { HELP_COPY } from '../src/content/help/help-copy';
import { OFFERED_LOCALES } from '../src/lib/i18n/catalog-status';
import {
  ARABIC_AUTH_PATHS,
  ARABIC_ROUTE_LOCALE,
  arabicPublicTitle,
  arabicRouteMetadata,
  PUBLIC_LOCALIZED_PATHS,
} from '../src/lib/i18n/public-locale-routes';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { PUBLIC_PAGES } from '../src/lib/public-pages';
import {
  homePageTitle,
  MAX_PUBLIC_TITLE_LENGTH,
  PAGE_OWNS_TITLE,
  ROUTE_TITLES,
  TITLE_SUFFIX,
} from '../src/lib/route-titles';

/**
 * SEOFIX (2026-11-17): every signed-out public page's tab title is at most 60 characters in every
 * language, so search results show it whole. The live home title was 71. Each title is built the
 * way its route builds it; the bidi marks around Latin names in Arabic are invisible and not
 * counted.
 */

const visible = (title: string): string => title.replace(/[‎‏]/g, '');

function absoluteTitle(metadata: Metadata): string {
  const title = metadata.title;
  if (title !== null && typeof title === 'object' && 'absolute' in title) return title.absolute;
  throw new Error('expected an absolute title');
}

/**
 * English: the page name plus the root template's suffix; the home page sets its own, and a
 * library article may carry a shorter tab title than its heading.
 */
function englishTitles(): [string, string][] {
  const tabTitles = new Map(
    ALL_RESOURCES.map((item) => [`/resources/${item.slug}`, item.tabTitle ?? item.title]),
  );
  return PUBLIC_PAGES.map((page) => [
    page.path,
    page.path === '/'
      ? homePageTitle('en-US')
      : `${tabTitles.get(page.path) ?? page.title}${TITLE_SUFFIX}`,
  ]);
}

/** Arabic: the titles the `/ar` routes write (catch-all, auth twins, help, compare, alternatives, facts, library). */
function arabicTitles(): [string, string][] {
  const ar = (name: string): string => `${name}${TITLE_SUFFIX}`;
  return [
    ...PUBLIC_LOCALIZED_PATHS.map((path): [string, string] => [path, arabicPublicTitle(path)]),
    ...ARABIC_AUTH_PATHS.map((path): [string, string] => [
      path,
      absoluteTitle(arabicRouteMetadata(path)),
    ]),
    ['/help', ar(HELP_COPY.ar.eyebrow)],
    ...HELP_ARTICLES.map((a): [string, string] => [`/help/${a.slug}`, ar(a.ar.title)]),
    ['/compare', ar(COMPARE_COPY.ar.indexTitle)],
    ...COMPARE_ENTRIES.map((e): [string, string] => [
      `/compare/${e.slug}`,
      ar(COMPARE_COPY.ar.title(e.name)),
    ]),
    ...SWITCH_ENTRIES.map((e): [string, string] => [
      `/switch/${e.slug}`,
      ar(SWITCH_COPY.ar.title(e.name)),
    ]),
    ['/alternatives', ar(ALTERNATIVE_COPY.ar.indexTitle)],
    ...ALTERNATIVE_PAGES.map(({ rival }): [string, string] => [
      `/alternatives/${rival.slug}`,
      ar(ALTERNATIVE_COPY.ar.tabTitle(rival.name)),
    ]),
    ['/facts', ar(FACTS_COPY.ar.title)],
    ...ALL_RESOURCES.map((item): [string, string] => [
      `/resources/${item.slug}`,
      ar(translate(ARABIC_ROUTE_LOCALE, item.tabTitleKey ?? item.titleKey)),
    ]),
  ];
}

/** Every offered locale: the tab title the browser writes (home line, or page name + suffix). */
function catalogTitles(): [string, string][] {
  const paths = [...PUBLIC_LOCALIZED_PATHS, ...ARABIC_AUTH_PATHS];
  return OFFERED_LOCALES.flatMap((locale) =>
    paths.map((path): [string, string] => {
      if (path === '/') return [`${locale} /`, homePageTitle(locale)];
      const entry = ROUTE_TITLES[path];
      if (entry === undefined || entry === PAGE_OWNS_TITLE) {
        throw new Error(`No page name for public route ${path}`);
      }
      return [`${locale} ${path}`, `${translate(locale, entry.key as MessageKey)}${TITLE_SUFFIX}`];
    }),
  );
}

describe('public page titles are at most 60 characters (SEOFIX)', () => {
  it.each([
    ['English', englishTitles],
    ['Arabic', arabicTitles],
    ['every offered catalog', catalogTitles],
  ])('%s', (_language, titles) => {
    const all = titles();
    expect(all.length).toBeGreaterThan(30);
    const tooLong = all
      .filter(([, title]) => visible(title).length > MAX_PUBLIC_TITLE_LENGTH)
      .map(([path, title]) => `${path}: ${visible(title).length} ${title}`);
    expect(tooLong).toEqual([]);
  });

  it('keeps the brand in the home title and the hero line out of it', () => {
    for (const locale of OFFERED_LOCALES) {
      expect(homePageTitle(locale)).toContain('TManage');
      expect(homePageTitle(locale)).not.toBe(translate(locale, 'HomePage.betaHeroTitle'));
    }
  });
});
