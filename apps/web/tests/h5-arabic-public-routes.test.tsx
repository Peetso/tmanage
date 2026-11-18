import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { act, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebsiteChrome } from '../src/components/website/WebsiteChrome';
import { LanguageSwitch } from '../src/components/website/WebFooter';
import { ARABIC_PAGES } from '../src/app/ar/arabic-pages';
import { englishBootTitle, localeBootScript, resolveBootLocale } from '../src/lib/i18n/locale-boot';
import { LocaleStore, activeLocale } from '../src/lib/i18n/locale-store';
import {
  arabicPublicMetadata,
  arabicPublicTitle,
  englishPublicPath,
  ALTERNATIVE_PATHS,
  ARABIC_KIT_PATHS,
  COMPARE_PATHS,
  FACTS_PATH,
  REFERRAL_PATH,
  HELP_PATHS,
  isArabicPublicPath,
  languageSwitchTarget,
  localizeHref,
  pathFromSegments,
  PUBLIC_LOCALIZED_PATHS,
  publicAlternates,
  segmentsOf,
} from '../src/lib/i18n/public-locale-routes';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';
import { useActiveLocale } from '../src/lib/i18n/use-active-locale';
import { translate } from '../src/lib/i18n/t';
import { localizedWebsiteTitle } from '../src/components/website/WebsiteDocumentTitle';
import {
  arabicHtmlFiles,
  localizeHtml,
  localizePrerenderedHtml,
} from '../scripts/localize-prerendered-html.mjs';

let mockPathname = '/ar/pricing';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

/**
 * **H5 — Arabic first paint for the public pages (audit 2026-10-25b, gap 5).**
 *
 * The public pages were prerendered `lang="en" dir="ltr"` in English only, so an Arabic visitor saw
 * English until the browser switched it, and crawlers saw English only. Every public page now has
 * an Arabic twin under `/ar`, prerendered in Arabic; these tests pin the route table, the rendering,
 * the links, the boot rule, the language switch's targets and the post-build `<html>` rewrite.
 */

const WEBSITE = join(__dirname, '..', 'src', 'app', '(website)');

function pageRoutes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pageRoutes(path);
    if (name !== 'page.tsx') return [];
    const rel = relative(WEBSITE, path).split(sep).slice(0, -1).join('/');
    return [`/${rel}`];
  });
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
  mockPathname = '/ar/pricing';
});

describe('the Arabic route table', () => {
  it('covers every static public page, and only those', () => {
    const english = pageRoutes(WEBSITE)
      // The Help centre (55-16), compare pages (57-06), alternatives and facts page (SEOF) have
      // their own Arabic routes.
      .filter(
        (route) =>
          route !== '/website-kit' &&
          !route.includes('[') &&
          !HELP_PATHS.includes(route) &&
          !COMPARE_PATHS.includes(route) &&
          !ALTERNATIVE_PATHS.includes(route) &&
          route !== FACTS_PATH &&
          // 57-07 (MENA): the Arabic-first page and its use cases have their own Arabic routes.
          !ARABIC_KIT_PATHS.includes(route) &&
          // 57-08 (REFERRAL): "Invite a company" has its own Arabic route.
          route !== REFERRAL_PATH &&
          // 52-19: /verify is never indexed, so its Arabic twin is its own route, off the table.
          route !== '/verify',
      )
      .sort();
    expect([...PUBLIC_LOCALIZED_PATHS].sort()).toEqual(english);
    expect(Object.keys(ARABIC_PAGES).sort()).toEqual(english);
  });

  it('renders each English route’s own page component', () => {
    // Pinned in the source, like website-route-table: the row's component is the default export
    // of that very route's page module, so the two languages cannot drift apart.
    const source = readFileSync(
      join(__dirname, '..', 'src', 'app', 'ar', 'arabic-pages.ts'),
      'utf8',
    );
    for (const path of PUBLIC_LOCALIZED_PATHS) {
      const module = `../(website)${path === '/' ? '' : path}/page`;
      const escaped = module.replace(/[()]/g, '\\$&');
      const name = new RegExp(`^import (\\w+) from '${escaped}';$`, 'm').exec(source)?.[1];
      expect(name, `${path} imports ${module}`).toBeDefined();
      expect(source, path).toContain(`  '${path}': ${name},`);
      expect(typeof ARABIC_PAGES[path], path).toBe('function');
    }
  });

  it('maps paths to catch-all segments and back', () => {
    for (const path of PUBLIC_LOCALIZED_PATHS) {
      expect(pathFromSegments(segmentsOf(path))).toBe(path);
    }
    expect(pathFromSegments(undefined)).toBe('/');
    expect(pathFromSegments(['sign-in'])).toBeUndefined();
    expect(pathFromSegments(['resources', 'some-article'])).toBeUndefined();
  });

  it('gives each page its Arabic title, the one the boot script and the tab title agree on', () => {
    for (const path of PUBLIC_LOCALIZED_PATHS) {
      const title = arabicPublicTitle(path);
      expect(title, path).toMatch(/[؀-ۿ]/);
      const english = englishBootTitle(title);
      expect(english, path).toBeDefined();
      expect(localizedWebsiteTitle(english as string, 'ar-EG'), path).toBe(title);
    }
    const meta = arabicPublicMetadata('/pricing');
    expect(meta.title).toEqual({ absolute: 'الأسعار · TManage' });
    expect(meta.description).toBe(translate('ar-EG', 'PublicSite.metaDescription'));
  });
});

describe('Arabic paths and links', () => {
  it('knows the Arabic prefix exactly', () => {
    expect(isArabicPublicPath('/ar')).toBe(true);
    expect(isArabicPublicPath('/ar/pricing')).toBe(true);
    expect(isArabicPublicPath('/archive')).toBe(false);
    expect(isArabicPublicPath('/pricing')).toBe(false);
    expect(englishPublicPath('/ar')).toBe('/');
    expect(englishPublicPath('/ar/features/work')).toBe('/features/work');
    expect(englishPublicPath('/pricing')).toBe('/pricing');
  });

  it('points links with an Arabic twin at it and leaves everything else alone', () => {
    expect(localizeHref('/')).toBe('/ar');
    expect(localizeHref('/pricing')).toBe('/ar/pricing');
    expect(localizeHref('/contact?plan=team#form')).toBe('/ar/contact?plan=team#form');
    expect(localizeHref('/sign-in')).toBe('/ar/sign-in');
    expect(localizeHref('/sign-up?plan=team')).toBe('/ar/sign-up?plan=team');
    expect(localizeHref('/recover')).toBe('/recover');
    expect(localizeHref('/resources/some-article')).toBe('/resources/some-article');
    expect(localizeHref('#featured-story')).toBe('#featured-story');
    expect(localizeHref('mailto:security@example.com')).toBe('mailto:security@example.com');
    expect(localizeHref('//evil.example/pricing')).toBe('//evil.example/pricing');
  });

  it('sends the language switch between /x and /ar/x, dropping ?lang=', () => {
    expect(languageSwitchTarget('/pricing', true)).toBe('/ar/pricing');
    expect(languageSwitchTarget('/', true, '?lang=en&tab=blog', '#top')).toBe('/ar?tab=blog#top');
    expect(languageSwitchTarget('/ar/pricing', false)).toBe('/pricing');
    expect(languageSwitchTarget('/ar', false)).toBe('/');
    expect(languageSwitchTarget('/ar/pricing', true)).toBeUndefined();
    expect(languageSwitchTarget('/pricing', false)).toBeUndefined();
    expect(languageSwitchTarget('/sign-in', true)).toBe('/ar/sign-in');
    expect(languageSwitchTarget('/recover', true)).toBeUndefined();
    expect(languageSwitchTarget('/acme/home', true)).toBeUndefined();
    expect(languageSwitchTarget(null, true)).toBeUndefined();
  });

  it('lists hreflang alternates for both languages of a public page only', () => {
    expect(publicAlternates('/pricing')).toEqual({ en: '/pricing', ar: '/ar/pricing' });
    expect(publicAlternates('/ar')).toEqual({ en: '/', ar: '/ar' });
    expect(publicAlternates('/sign-in')).toEqual({ en: '/sign-in', ar: '/ar/sign-in' });
    expect(publicAlternates('/recover')).toBeUndefined();
  });
});

describe('the boot locale on an Arabic page', () => {
  it('is ar-EG from the path, ahead of ?lang= and the cookie, and is persisted', () => {
    expect(resolveBootLocale('?lang=en', 'en-US', 'tmanage_locale=en-US', '/ar/pricing')).toEqual({
      locale: 'ar-EG',
      fromQuery: true,
      saveCookie: true,
    });
    expect(resolveBootLocale('', null, null, '/archive')).toBeUndefined();
    expect(resolveBootLocale('', null, null, '/pricing')).toBeUndefined();
  });

  it('sets rtl and ar-EG in the inline script and saves the choice', () => {
    window.history.replaceState(null, '', '/ar/pricing?lang=en');
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
    new Function(localeBootScript())();
    expect(document.documentElement.lang).toBe('ar-EG');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.cookie).toContain('tmanage_locale=ar-EG');
    expect(window.localStorage.getItem('tmanage:locale')).toBe('ar-EG');
    expect(new LocaleStore().get()).toBe('ar-EG');
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  });
});

function Probe() {
  return <span data-testid="locale">{useActiveLocale()}</span>;
}

describe('rendering under the Arabic route locale', () => {
  it('prerenders the chrome in Arabic, with Arabic links and hreflang alternates', () => {
    mockPathname = '/ar/pricing';
    const html = renderToString(
      <RouteLocaleProvider locale="ar-EG">
        <WebsiteChrome>
          <Probe />
        </WebsiteChrome>
      </RouteLocaleProvider>,
    );
    expect(html).toContain('>ar-EG<');
    expect(html).toContain(translate('ar-EG', 'WebsiteChrome.skipLink'));
    expect(html).toMatch(/<a[^>]*href="\/ar\/pricing"/);
    expect(html).toMatch(/<a[^>]*href="\/ar\/sign-in"/);
    expect(html).not.toMatch(/<a[^>]*href="\/pricing"/);
    // AGENTREADY: absolute URLs, and the Arabic page is its own canonical.
    expect(html).toContain('<link rel="canonical" href="https://tmanageapp.com/ar/pricing"/>');
    expect(html).toContain(
      '<link rel="alternate" hrefLang="en" href="https://tmanageapp.com/pricing"/>',
    );
    expect(html).toContain(
      '<link rel="alternate" hrefLang="ar" href="https://tmanageapp.com/ar/pricing"/>',
    );
  });

  it('keeps the English site in English with English links', () => {
    mockPathname = '/pricing';
    const html = renderToString(
      <WebsiteChrome>
        <Probe />
      </WebsiteChrome>,
    );
    expect(html).toContain('>en-US<');
    expect(html).toMatch(/<a[^>]*href="\/pricing"/);
    expect(html).not.toMatch(/<a[^>]*href="\/ar\/pricing"/);
  });

  it('makes the route locale the tab’s locale on mount, and keeps Arabic while the store says English', () => {
    const store = new LocaleStore('en-US');
    const view = render(
      <RouteLocaleProvider locale="ar-EG" store={store}>
        <Probe />
      </RouteLocaleProvider>,
    );
    expect(store.get()).toBe('ar-EG');
    expect(view.getByTestId('locale').textContent).toBe('ar-EG');
  });

  it('marks العربية pressed on an Arabic page whatever the stored locale', () => {
    mockPathname = '/ar/pricing';
    act(() => activeLocale.set('en-US'));
    const view = render(
      <RouteLocaleProvider locale="ar-EG" store={new LocaleStore('ar-EG')}>
        <LanguageSwitch />
      </RouteLocaleProvider>,
    );
    expect(view.getByRole('button', { name: 'العربية' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the post-build <html> rewrite', () => {
  it('turns the root layout’s English tag into the Arabic one, once', () => {
    const html =
      '<!DOCTYPE html><html lang="en" dir="ltr" class="x"><body lang="en"></body></html>';
    expect(localizeHtml(html)).toBe(
      '<!DOCTYPE html><html lang="ar" dir="rtl" class="x"><body lang="en"></body></html>',
    );
    expect(localizeHtml(localizeHtml(html) as string)).toBe(localizeHtml(html));
    expect(localizeHtml('<!DOCTYPE html><html class="x">')).toBeUndefined();
  });

  it('rewrites ar.html and every page under ar/, and fails when there is nothing to rewrite', () => {
    const dist = mkdtempSync(join(tmpdir(), 'h5-dist-'));
    try {
      const app = join(dist, 'server', 'app');
      expect(() => localizePrerenderedHtml(dist)).toThrow(/no prerendered Arabic pages/);
      mkdirSync(join(app, 'ar', 'features'), { recursive: true });
      const page = '<!DOCTYPE html><html lang="en" dir="ltr" class="x"><head></head></html>';
      writeFileSync(join(app, 'ar.html'), page);
      writeFileSync(join(app, 'ar', 'pricing.html'), page);
      writeFileSync(join(app, 'ar', 'features', 'work.html'), page);
      writeFileSync(join(app, 'pricing.html'), page);
      expect(arabicHtmlFiles(dist)).toHaveLength(3);
      localizePrerenderedHtml(dist);
      for (const file of ['ar.html', 'ar/pricing.html', 'ar/features/work.html']) {
        expect(readFileSync(join(app, file), 'utf8')).toContain('<html lang="ar" dir="rtl"');
      }
      expect(readFileSync(join(app, 'pricing.html'), 'utf8')).toContain(
        '<html lang="en" dir="ltr"',
      );
      writeFileSync(join(app, 'ar', 'broken.html'), '<!DOCTYPE html><html class="x">');
      expect(() => localizePrerenderedHtml(dist)).toThrow(/broken\.html/);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
