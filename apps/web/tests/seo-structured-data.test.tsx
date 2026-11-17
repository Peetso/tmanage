import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PublicStructuredData } from '../src/components/website/PublicStructuredData';
import { COMPARE_ENTRIES } from '../src/content/compare/compare-entries';
import { jsonLdGraph, type JsonLd, type JsonLdValue } from '../src/lib/structured-data';

let mockPathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const ORIGIN = 'https://tmanageapp.com';

/** The JSON-LD items the page at `pathname` emits, one per `@graph` node. */
function itemsAt(pathname: string): JsonLd[] {
  mockPathname = pathname;
  const html = renderToString(<PublicStructuredData />);
  const match = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
  if (match === null) return [];
  const data = JSON.parse(match[1] ?? 'null') as JsonLd;
  const graph = data['@graph'];
  return Array.isArray(graph) ? (graph as JsonLd[]) : [data];
}

const typesAt = (pathname: string): (JsonLdValue | undefined)[] =>
  itemsAt(pathname).map((item) => item['@type']);

const ofType = (pathname: string, type: string): JsonLd | undefined =>
  itemsAt(pathname).find((item) => item['@type'] === type);

/** SEOA (2026-11-17): the structured data each page type emits, from what the page shows. */
describe('public structured data per page type', () => {
  it('the compare hub lists every compare page it shows, in order', () => {
    const list = ofType('/compare', 'ItemList');
    expect(list?.['numberOfItems']).toBe(COMPARE_ENTRIES.length);
    expect((list?.['itemListElement'] as JsonLd[])[0]?.['url']).toBe(
      `${ORIGIN}/compare/${COMPARE_ENTRIES[0]?.slug ?? ''}`,
    );
  });

  it('a compare page names both products and its checked date, with a trail to the hub', () => {
    expect(typesAt('/compare/basecamp')).toEqual(['BreadcrumbList', 'WebPage']);
    const page = ofType('/compare/basecamp', 'WebPage');
    expect([page?.['dateModified'], page?.['about']]).toEqual([
      '2026-11-15',
      [
        { '@type': 'SoftwareApplication', name: 'TManage' },
        { '@type': 'SoftwareApplication', name: 'Basecamp' },
      ],
    ]);
  });

  it('a switch page has no date it does not show, and a HowTo of its move text', () => {
    expect(typesAt('/switch/asana')).toEqual(['WebPage', 'HowTo']);
    expect(ofType('/switch/asana', 'WebPage')?.['dateModified']).toBeUndefined();
  });

  it('a help article with numbered steps gets a HowTo of exactly those steps', () => {
    const steps = ofType('/help/create-your-workspace', 'HowTo')?.['step'] as JsonLd[];
    expect(steps.map((step) => step['text'])[0]).toBe('Open tmanageapp.com and choose Start free.');
    expect(steps).toHaveLength(4);
  });

  it('a library article is an Article by the TManage team, without dates it does not show', () => {
    const item = ofType('/resources/client-approval-playbook', 'Article');
    expect([
      (item?.['author'] as JsonLd)['name'],
      item?.['datePublished'],
      item?.['inLanguage'],
    ]).toEqual(['TManage', undefined, 'en']);
  });

  it('the Arabic twin speaks Arabic and points at the /ar address', () => {
    const page = ofType('/ar/compare/basecamp', 'WebPage');
    expect([page?.['inLanguage'], page?.['url']]).toEqual(['ar', `${ORIGIN}/ar/compare/basecamp`]);
  });

  it('a page without structured data renders nothing', () => {
    expect(itemsAt('/about')).toEqual([]);
  });

  it('one item stays as it is; several share one @context in a @graph', () => {
    const one = { '@context': 'https://schema.org', '@type': 'Thing' };
    expect([jsonLdGraph([]), jsonLdGraph([one])]).toEqual([undefined, one]);
    expect(jsonLdGraph([one, one])).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Thing' }, { '@type': 'Thing' }],
    });
  });
});
