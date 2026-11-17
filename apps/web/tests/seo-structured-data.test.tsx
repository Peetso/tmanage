import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import CompareRoute from '../src/app/(website)/compare/page';
import CompareEntryRoute from '../src/app/(website)/compare/[slug]/page';
import HelpArticleRoute from '../src/app/(website)/help/[slug]/page';
import ResourcePage from '../src/app/(website)/resources/[slug]/page';
import SwitchEntryRoute from '../src/app/(website)/switch/[slug]/page';
import ArabicCompareEntryRoute from '../src/app/ar/(site)/compare/[slug]/page';
import { WebsiteChrome } from '../src/components/website/WebsiteChrome';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { RouteLocaleProvider } from '../src/lib/i18n/route-locale';
import { jsonLdGraph, type JsonLd, type JsonLdValue } from '../src/lib/structured-data';

let mockPathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  notFound: () => {
    throw new Error('not found');
  },
}));

const ORIGIN = 'https://tmanageapp.com';

type SlugRoute = (props: { params: Promise<{ slug: string }> }) => Promise<ReactElement>;

/** The route that renders each page family, by the start of its path. */
const SLUG_ROUTES: readonly (readonly [string, SlugRoute])[] = [
  ['/ar/compare/', ArabicCompareEntryRoute],
  ['/compare/', CompareEntryRoute],
  ['/switch/', SwitchEntryRoute],
  ['/help/', HelpArticleRoute],
  ['/resources/', ResourcePage],
];

/** The page at `pathname` as its route renders it on the server, inside the website chrome. */
async function pageAt(pathname: string): Promise<ReactElement> {
  if (pathname === '/compare') return CompareRoute();
  const found = SLUG_ROUTES.find(([prefix]) => pathname.startsWith(prefix));
  // Home, pricing and every other page: the chrome's own JSON-LD only.
  if (found === undefined) return <p />;
  const [prefix, route] = found;
  return route({ params: Promise.resolve({ slug: pathname.slice(prefix.length) }) });
}

/** The server-rendered HTML of the page at `pathname`: what a crawler gets before any script. */
async function serverHtml(pathname: string): Promise<string> {
  mockPathname = pathname;
  const page = await pageAt(pathname);
  return renderToString(
    <RouteLocaleProvider locale={pathname.startsWith('/ar/') ? 'ar-EG' : 'en-US'}>
      <WebsiteChrome>{page}</WebsiteChrome>
    </RouteLocaleProvider>,
  );
}

const JSON_LD = /<script type="application\/ld\+json">([^<]*)<\/script>/g;

/** The JSON-LD items the page at `pathname` emits in its first HTML, one per `@graph` node. */
async function itemsAt(pathname: string): Promise<JsonLd[]> {
  const blocks = [...(await serverHtml(pathname)).matchAll(JSON_LD)];
  expect(blocks.length).toBeLessThanOrEqual(1);
  const text = blocks[0]?.[1];
  if (text === undefined) return [];
  const data = JSON.parse(text) as JsonLd;
  const graph = data['@graph'];
  return Array.isArray(graph) ? (graph as JsonLd[]) : [data];
}

const typesAt = async (pathname: string): Promise<(JsonLdValue | undefined)[]> =>
  (await itemsAt(pathname)).map((item) => item['@type']);

const ofType = async (pathname: string, type: string): Promise<JsonLd | undefined> =>
  (await itemsAt(pathname)).find((item) => item['@type'] === type);

/** SEOA (2026-11-17): the structured data each page type emits, from what the page shows. */
describe('public structured data per page type', () => {
  it('the compare hub lists every compare page it shows, in order', async () => {
    const list = await ofType('/compare', 'ItemList');
    expect(list?.['numberOfItems']).toBe(COMPARE_ENTRIES.length);
    expect((list?.['itemListElement'] as JsonLd[])[0]?.['url']).toBe(
      `${ORIGIN}/compare/${COMPARE_ENTRIES[0]?.slug ?? ''}`,
    );
  });

  it('a compare page names both products and its checked date, with a trail to the hub', async () => {
    expect(await typesAt('/compare/basecamp')).toEqual(['BreadcrumbList', 'WebPage']);
    const page = await ofType('/compare/basecamp', 'WebPage');
    expect([page?.['dateModified'], page?.['about']]).toEqual([
      '2026-11-15',
      [
        { '@type': 'SoftwareApplication', name: 'TManage' },
        { '@type': 'SoftwareApplication', name: 'Basecamp' },
      ],
    ]);
  });

  it('a switch page has no date it does not show, and a HowTo of its move text', async () => {
    expect(await typesAt('/switch/asana')).toEqual(['WebPage', 'HowTo']);
    expect((await ofType('/switch/asana', 'WebPage'))?.['dateModified']).toBeUndefined();
  });

  it('a help article with numbered steps gets a HowTo of exactly those steps', async () => {
    const steps = (await ofType('/help/create-your-workspace', 'HowTo'))?.['step'] as JsonLd[];
    expect(steps.map((step) => step['text'])[0]).toBe('Open tmanageapp.com and choose Start free.');
    expect(steps).toHaveLength(4);
  });

  it('a library article is an Article by the TManage team, without dates it does not show', async () => {
    const item = await ofType('/resources/client-approval-playbook', 'Article');
    expect([
      (item?.['author'] as JsonLd)['name'],
      item?.['datePublished'],
      item?.['inLanguage'],
    ]).toEqual(['TManage', undefined, 'en']);
  });

  it('the Arabic twin speaks Arabic and points at the /ar address', async () => {
    const page = await ofType('/ar/compare/basecamp', 'WebPage');
    expect([page?.['inLanguage'], page?.['url']]).toEqual(['ar', `${ORIGIN}/ar/compare/basecamp`]);
  });

  it('a page without structured data renders nothing', async () => {
    expect(await itemsAt('/about')).toEqual([]);
  });

  it('one item stays as it is; several share one @context in a @graph', () => {
    const one = { '@context': 'https://schema.org', '@type': 'Thing' };
    expect([jsonLdGraph([]), jsonLdGraph([one])]).toEqual([undefined, one]);
    expect(jsonLdGraph([one, one])).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Thing' }, { '@type': 'Thing' }],
    });
  });

  it('the browser code of every public page carries no help, library or compare content', async () => {
    const importsOf = (...path: string[]): string[] =>
      [
        ...readFileSync(join(__dirname, '..', 'src', ...path), 'utf8').matchAll(
          /^import [^;]*? from '([^']+)';/gms,
        ),
      ].map((match) => match[1] ?? '');
    const chrome = importsOf('components', 'website', 'PublicStructuredData.tsx');
    const routes = importsOf('lib', 'i18n', 'public-locale-routes.ts');
    expect(Math.min(chrome.length, routes.length)).toBeGreaterThan(5);
    const content = /content\/(?!.*-slugs$)|resources-data|JsonLd$/;
    expect([...chrome, ...routes].filter((path) => content.test(path))).toEqual([]);
    expect(await typesAt('/pricing')).toEqual(['FAQPage']);
  });
});
