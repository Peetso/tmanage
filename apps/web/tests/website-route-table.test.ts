import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Every public website route renders its own page (live-check 9c6d816c, M1).**
 *
 * The live site served the Chat & calendar page at `/contact` (and once at `/customers`). The
 * build was right — its `contact.html` held "Book a demo" — and the wrong body came from a stale
 * CDN object. This test pins the source half so a swapped import can never be the cause: it walks
 * `src/app/(website)`, and for every `page.tsx` asserts the route's own page component is the one
 * imported and rendered, and that the static title is the route's own. A page added to the site
 * without a row here fails, so the table cannot fall behind the routes.
 */

const WEBSITE = join(__dirname, '..', 'src', 'app', '(website)');

interface RouteRow {
  /** the component the default export renders */
  component: string;
  /** the module it is imported from, relative to `src/components` */
  from: string;
  /** the static `metadata.title`, or `null` for a page whose title is set elsewhere */
  title: string | null;
}

const ROUTES: Record<string, RouteRow> = {
  '/': { component: 'HomePage', from: 'website/pages/home/HomePage', title: null },
  '/about': { component: 'AboutPage', from: 'website/pages/about/AboutPage', title: 'About' },
  '/changelog': {
    component: 'ChangelogScreen',
    from: 'screens/ChangelogScreen',
    title: 'Changelog',
  },
  '/client-portal': {
    component: 'ClientPortalPage',
    from: 'website/pages/client-portal/ClientPortalPage',
    title: 'Client portal',
  },
  '/contact': {
    component: 'ContactPage',
    from: 'website/pages/contact/ContactPage',
    title: 'Book a demo',
  },
  '/customers': {
    component: 'CustomersPage',
    from: 'website/pages/customers/CustomersPage',
    title: 'Customers & stories',
  },
  '/download': {
    component: 'DownloadPage',
    from: 'website/pages/download/DownloadPage',
    title: 'Download',
  },
  '/faq': { component: 'MarketingFaqScreen', from: 'screens/MarketingFaqScreen', title: 'FAQ' },
  '/features/communication': {
    component: 'FeaturesCommunicationPage',
    from: 'website/pages/features-communication/FeaturesCommunicationPage',
    title: 'Chat & calendar',
  },
  '/features/insights': {
    component: 'FeaturesInsightsPage',
    from: 'website/pages/features-insights/FeaturesInsightsPage',
    title: 'Insights & automations',
  },
  '/features/knowledge': {
    component: 'FeaturesKnowledgePage',
    from: 'website/pages/features-knowledge/FeaturesKnowledgePage',
    title: 'Docs, decisions & approvals',
  },
  '/features/work': {
    component: 'FeaturesWorkPage',
    from: 'website/pages/features-work/FeaturesWorkPage',
    title: 'Work, requests & projects',
  },
  '/integrations': {
    component: 'IntegrationsPage',
    from: 'website/pages/integrations/IntegrationsPage',
    title: 'Integrations',
  },
  '/legal/privacy': {
    component: 'MarketingLegalScreen',
    from: 'screens/MarketingLegalScreen',
    title: null,
  },
  '/legal/terms': {
    component: 'MarketingLegalScreen',
    from: 'screens/MarketingLegalScreen',
    title: null,
  },
  '/pricing': {
    component: 'PricingPage',
    from: 'website/pages/pricing/PricingPage',
    title: 'Pricing',
  },
  '/product': {
    component: 'ProductPage',
    from: 'website/pages/product/ProductPage',
    title: 'Product overview',
  },
  '/resources': {
    component: 'ResourcesPage',
    from: 'website/pages/resources/ResourcesPage',
    title: 'Resources',
  },
  '/resources/[slug]': {
    component: 'ResourceArticlePage',
    from: 'website/pages/resources/ResourceArticlePage',
    title: null,
  },
  '/security': {
    component: 'SecurityPage',
    from: 'website/pages/security/SecurityPage',
    title: 'Security & trust',
  },
  '/security/data-location': {
    component: 'DataLocationPage',
    from: 'website/pages/data-location/DataLocationPage',
    title: 'Where your data lives',
  },
  '/solutions/agencies': {
    component: 'SolutionsAgenciesPage',
    from: 'website/pages/solutions-agencies/SolutionsAgenciesPage',
    title: 'Agencies & studios',
  },
  '/solutions/consultancies': {
    component: 'ConsultanciesPage',
    from: 'website/pages/solutions-consultancies/ConsultanciesPage',
    title: 'Consultancies',
  },
  '/solutions/in-house': {
    component: 'SolutionsInhousePage',
    from: 'website/pages/solutions-inhouse/SolutionsInhousePage',
    title: 'In-house teams',
  },
  '/status': { component: 'StatusScreen', from: 'screens/StatusScreen', title: 'Service status' },
};

/** Routes that are not public pages and carry no single page component. */
const NOT_PUBLIC = new Set(['/website-kit']);

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pageFiles(full);
    return name === 'page.tsx' ? [full] : [];
  });
}

function routeOf(file: string): string {
  const rel = relative(WEBSITE, file).split(sep).slice(0, -1).join('/');
  return `/${rel}`;
}

const PAGES = new Map(pageFiles(WEBSITE).map((file) => [routeOf(file), file]));

describe('website route table', () => {
  it('has one row for every public page.tsx, and no row without a page', () => {
    const onDisk = [...PAGES.keys()].filter((route) => !NOT_PUBLIC.has(route)).sort();
    expect(onDisk).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(Object.entries(ROUTES))('%s renders its own page', (route, row) => {
    const source = readFileSync(PAGES.get(route) as string, 'utf8');
    const importLine = new RegExp(
      `import \\{[^}]*\\b${row.component}\\b[^}]*\\} from '(?:\\.\\./)+components/${row.from}';`,
    );
    expect(source, `${route} imports ${row.component} from ${row.from}`).toMatch(importLine);
    const body = source.slice(source.indexOf('export default'));
    expect(body, `${route}'s default export renders <${row.component}`).toContain(
      `<${row.component}`,
    );
    // No other website page component is rendered by this route.
    const others = Object.values(ROUTES)
      .map((r) => r.component)
      .filter((c) => c !== row.component && c !== 'MarketingResourceScreen');
    for (const other of others) expect(body).not.toContain(`<${other}`);
    if (row.title !== null) expect(source).toContain(`title: '${row.title}'`);
  });

  it('gives every route a distinct static title', () => {
    const titles = Object.values(ROUTES)
      .map((row) => row.title)
      .filter((t): t is string => t !== null);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('renders the legal documents by their own key', () => {
    for (const doc of ['privacy', 'terms']) {
      const source = readFileSync(PAGES.get(`/legal/${doc}`) as string, 'utf8');
      expect(source).toContain(`doc="${doc}" document={LEGAL_DOCUMENTS.${doc}}`);
    }
  });
});
