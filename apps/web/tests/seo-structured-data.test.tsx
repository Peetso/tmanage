import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prerender } from 'react-dom/static';
import { describe, expect, it, vi } from 'vitest';
import { PublicStructuredData } from '../src/components/website/PublicStructuredData';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { jsonLdGraph, type JsonLd, type JsonLdValue } from '../src/lib/structured-data';

let mockPathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const ORIGIN = 'https://tmanageapp.com';

/**
 * The JSON-LD items the page at `pathname` emits, one per `@graph` node. Prerendered like the
 * build does it: the help, library and compare families load lazily and are waited for.
 */
async function itemsAt(pathname: string): Promise<JsonLd[]> {
  mockPathname = pathname;
  const { prelude } = await prerender(<PublicStructuredData />);
  const html = await new Response(prelude).text();
  const match = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
  if (match === null) return [];
  const data = JSON.parse(match[1] ?? 'null') as JsonLd;
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

  it('the chrome loads no help, library or compare data until a page of that family needs it', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'components', 'website', 'PublicStructuredData.tsx'),
      'utf8',
    );
    const staticImports = [...source.matchAll(/^import [^;]*? from '([^']+)';/gms)].map(
      (match) => match[1] ?? '',
    );
    expect(staticImports.length).toBeGreaterThan(5);
    expect(staticImports.filter((path) => /content\/|resources-data|JsonLd$/.test(path))).toEqual(
      [],
    );
    expect(await typesAt('/pricing')).toEqual(['FAQPage']);
  });
});
