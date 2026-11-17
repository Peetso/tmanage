import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AlternativeRoute from '../src/app/(website)/alternatives/[slug]/page';
import AlternativesRoute from '../src/app/(website)/alternatives/page';
import CompareRoute from '../src/app/(website)/compare/page';
import CompareEntryRoute from '../src/app/(website)/compare/[slug]/page';
import FactsRoute from '../src/app/(website)/facts/page';
import SwitchEntryRoute from '../src/app/(website)/switch/[slug]/page';
import ArabicAlternativeRoute from '../src/app/ar/(site)/alternatives/[slug]/page';
import ArabicAlternativesRoute from '../src/app/ar/(site)/alternatives/page';
import ArabicFactsRoute from '../src/app/ar/(site)/facts/page';
import { WebsiteChrome } from '../src/components/website/WebsiteChrome';
import { ALTERNATIVE_COPY } from '../src/content/alternatives/alternative-copy';
import {
  ALTERNATIVE_ENTRIES,
  ALTERNATIVE_PAGES,
} from '../src/content/alternatives/alternative-entries';
import { ALTERNATIVE_SLUGS } from '../src/content/alternatives/alternative-slugs';
import { COMPARE_SLUGS, SWITCH_SLUGS } from '../src/content/compare/compare-slugs';
import { FACTS_COPY } from '../src/content/facts/facts';
import { hasArabicTwin } from '../src/lib/i18n/public-locale-routes';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';
import { publicPageAt } from '../src/lib/public-pages';
import { llmsFullTxt, llmsTxt } from '../src/lib/site-text-files';

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  notFound: () => {
    throw new Error('not found');
  },
}));

const ORIGIN = 'https://tmanageapp.com';
const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });

/** The page at `pathname` as its route renders it on the server, inside the website chrome. */
async function serverHtml(pathname: string): Promise<string> {
  mockPathname = pathname;
  const arabic = pathname.startsWith('/ar/');
  const english = arabic ? pathname.slice(3) : pathname;
  let page: ReactElement;
  if (english === '/alternatives') page = arabic ? ArabicAlternativesRoute() : AlternativesRoute();
  else if (english === '/facts') page = arabic ? ArabicFactsRoute() : FactsRoute();
  else {
    const params = slugParams(english.slice('/alternatives/'.length));
    page = await (arabic ? ArabicAlternativeRoute(params) : AlternativeRoute(params));
  }
  // As in the app: only the `/ar` layout names a route locale.
  const chrome = <WebsiteChrome>{page}</WebsiteChrome>;
  return renderToString(
    arabic ? <RouteLocaleProvider locale="ar-EG">{chrome}</RouteLocaleProvider> : chrome,
  );
}

async function render(pathname: string): Promise<{ html: string; root: HTMLElement }> {
  const html = await serverHtml(pathname);
  const root = document.createElement('div');
  root.innerHTML = html;
  return { html, root };
}

const text = (element: Element | null): string => (element?.textContent ?? '').trim();

/** The `@type`s of the page's one JSON-LD block. */
function jsonLdTypes(root: HTMLElement): unknown[] {
  const blocks = root.querySelectorAll('script[type="application/ld+json"]');
  expect(blocks).toHaveLength(1);
  const data = JSON.parse(blocks[0]?.textContent ?? '{}') as Record<string, unknown>;
  const graph = data['@graph'];
  return (Array.isArray(graph) ? graph : [data]).map(
    (item: Record<string, unknown>) => item['@type'],
  );
}

describe('SEOF alternative pages and facts page', () => {
  it.each(['en', 'ar'] as const)(
    'server-render every alternative page in %s as designed',
    async (language) => {
      const copy = ALTERNATIVE_COPY[language];
      for (const page of ALTERNATIVE_PAGES) {
        const { name, slug } = page.rival;
        const path = `${language === 'ar' ? '/ar' : ''}/alternatives/${slug}`;
        const { html, root } = await render(path);
        expect(text(root.querySelector('h1')), path).toBe(copy.title(name));
        const headings = [...root.querySelectorAll('h2')].map(text);
        expect(headings).toEqual(
          expect.arrayContaining([
            copy.whyTitle(name),
            copy.tableTitle(name),
            copy.switchTitle,
            copy.faqTitle(name),
            copy.relatedTitle,
          ]),
        );
        // Every answer is in the HTML, open.
        for (const item of copy.faq(name, page.entry.workWord)) expect(html).toContain(item.answer);
        expect(jsonLdTypes(root)).toEqual(['BreadcrumbList', 'WebPage', 'FAQPage']);
        expect(html).not.toContain('@peetrix.com');
      }
    },
  );

  it('reads every rival cell from its compare entry and links its pricing page, never a price', async () => {
    for (const language of ['en', 'ar'] as const) {
      for (const page of ALTERNATIVE_PAGES) {
        const { root } = await render(
          `${language === 'ar' ? '/ar' : ''}/alternatives/${page.rival.slug}`,
        );
        for (const [feature, cell] of Object.entries(page.rival.rows)) {
          const shown = root.querySelector(`[data-testid="theirs-${feature}"]`);
          if (feature === 'invoices') expect(shown).toBeNull();
          else expect(text(shown), `${page.rival.slug} ${feature}`).toBe(cell.text[language]);
        }
        const pricing = root.querySelector('[data-testid="theirs-pricing"] a');
        expect(pricing?.getAttribute('href')).toBe(page.rival.pricingUrl);
        expect(text(root.querySelector('[data-testid="theirs-strong"]'))).toContain(
          page.rival.strong[language],
        );
        expect(text(root.querySelector('[data-testid="alternative-sources"]'))).toMatch(/2026/);
        expect(text(root.querySelector('table'))).not.toMatch(/[$€£]|\bUSD\b/);
      }
    }
  });

  it.each(['en', 'ar'] as const)(
    'server-render the index and the facts page in %s',
    async (language) => {
      const prefix = language === 'ar' ? '/ar' : '';
      const index = await render(`${prefix}/alternatives`);
      expect(text(index.root.querySelector('h1'))).toBe(ALTERNATIVE_COPY[language].indexTitle);
      expect(jsonLdTypes(index.root)).toEqual(['ItemList']);
      for (const slug of ALTERNATIVE_SLUGS) {
        expect(
          index.root.querySelector(`a[href="${prefix}/alternatives/${slug}"]`),
          slug,
        ).not.toBeNull();
      }

      const facts = await render(`${prefix}/facts`);
      const copy = FACTS_COPY[language];
      expect(text(facts.root.querySelector('h1'))).toBe(copy.title);
      expect([...facts.root.querySelectorAll('h2')].map(text)).toEqual(
        expect.arrayContaining([copy.tableTitle, copy.featuresTitle, copy.writersTitle]),
      );
      expect(facts.root.querySelector('a[href="mailto:hello@tmanageapp.com"]')).not.toBeNull();
      expect(facts.root.querySelector(`a[href="${ORIGIN}"]`)).not.toBeNull();
      expect(jsonLdTypes(facts.root)).toEqual(['BreadcrumbList', 'WebPage']);
      expect(facts.html + index.html).not.toContain('@peetrix.com');
      const claims =
        text(facts.root.querySelector('table')) +
        text(facts.root.querySelector('ul.tm-web-alt-features'));
      expect(claims).not.toMatch(/[Ii]nvoice|\biOS\b|Android|\bMac\b|فاتورة|فواتير/);
    },
  );

  it('keeps the slug list, the twin table and the page list complete', () => {
    expect([...ALTERNATIVE_SLUGS]).toEqual(ALTERNATIVE_ENTRIES.map((entry) => entry.slug));
    for (const slug of ALTERNATIVE_SLUGS) {
      expect(COMPARE_SLUGS as readonly string[]).toContain(slug);
      expect(SWITCH_SLUGS).toContain(slug);
    }
    for (const path of [
      '/alternatives',
      '/facts',
      ...ALTERNATIVE_SLUGS.map((s) => `/alternatives/${s}`),
    ]) {
      expect(hasArabicTwin(path), path).toBe(true);
      expect(publicPageAt(path), path).toBeDefined();
    }
  });

  it('names the facts page and the alternatives in llms.txt and carries them in llms-full.txt', () => {
    const index = llmsTxt(ORIGIN);
    expect(index).toContain(`(${ORIGIN}/facts)`);
    for (const slug of ALTERNATIVE_SLUGS)
      expect(index).toContain(`(${ORIGIN}/alternatives/${slug})`);
    const full = llmsFullTxt(ORIGIN);
    expect(full).toContain(`Source: [${ORIGIN}/facts]`);
    expect(full).toContain(`Source: [${ORIGIN}/alternatives/basecamp]`);
  });

  it('links the compare and switch pages of the same product, and the compare hub, back here', async () => {
    const html = async (page: ReactElement) => {
      const root = document.createElement('div');
      root.innerHTML = renderToString(<WebsiteChrome>{page}</WebsiteChrome>);
      return root;
    };
    for (const slug of ALTERNATIVE_SLUGS) {
      for (const route of [CompareEntryRoute, SwitchEntryRoute]) {
        const root = await html(await route(slugParams(slug)));
        expect(root.querySelector(`a[href="/alternatives/${slug}"]`), slug).not.toBeNull();
      }
    }
    expect((await html(CompareRoute())).querySelector('a[href="/alternatives"]')).not.toBeNull();
  });
});
