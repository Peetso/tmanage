import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sitemap from '../src/app/sitemap';
import { PublicLocaleAlternates } from '../src/components/website/PublicLocaleAlternates';
import { mcpServerCard } from '../src/lib/mcp-server-card';
import { siteOrigin } from '../src/lib/site-origin';
import { llmsTxt, robotsTxt } from '../src/lib/site-text-files';
import { homeGraph } from '../src/lib/structured-data';

let mockPathname = '/pricing';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const NEW = 'https://tmanageapp.com';
const OLD = 'tmanage.peetrix.com';

/**
 * NEWDOMAIN (2026-11-17): the site moved to tmanageapp.com. With no `TMANAGE_SITE_URL` set, every
 * absolute URL search engines and AI assistants read (canonical, hreflang, sitemap, robots, JSON-LD,
 * llms.txt, the MCP server card) carries the new origin and never the old host.
 */
describe('the default site origin is https://tmanageapp.com', () => {
  beforeEach(() => {
    vi.stubEnv('TMANAGE_SITE_URL', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is the origin the helper falls back to', () => {
    expect(siteOrigin()).toBe(NEW);
  });

  it('puts the canonical and the hreflang EN/AR alternates on the new origin', () => {
    mockPathname = '/pricing';
    const html = renderToString(<PublicLocaleAlternates />);
    expect(html).toContain(`<link rel="canonical" href="${NEW}/pricing"/>`);
    expect(html).toContain(`<link rel="alternate" hrefLang="ar" href="${NEW}/ar/pricing"/>`);
    expect(html).toContain(`<link rel="alternate" hrefLang="x-default" href="${NEW}/pricing"/>`);
    expect(html).not.toContain(OLD);
  });

  it('lists every sitemap URL and alternate on the new origin', () => {
    const entries = sitemap();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.url.startsWith(`${NEW}/`)).toBe(true);
      for (const url of Object.values(entry.alternates?.languages ?? {})) {
        expect(String(url).startsWith(`${NEW}/`)).toBe(true);
      }
    }
  });

  it('points robots.txt at the new sitemap and keeps llms.txt on the new origin', () => {
    expect(robotsTxt()).toContain(`Sitemap: ${NEW}/sitemap.xml`);
    const llms = llmsTxt();
    expect(llms).toContain(`${NEW}/`);
    expect(llms).not.toContain(OLD);
  });

  it('gives the JSON-LD Organization, WebSite and SoftwareApplication the new url and logo', () => {
    const graph = homeGraph({ language: 'en', description: 'd' })['@graph'] as readonly Record<
      string,
      unknown
    >[];
    const byType = (type: string) => graph.find((node) => node['@type'] === type) ?? {};
    expect(byType('Organization')['url']).toBe(`${NEW}/`);
    expect(byType('Organization')['@id']).toBe(`${NEW}/#organization`);
    expect(byType('Organization')['logo']).toBe(`${NEW}/brand/tmanage-icon-512.png`);
    expect(byType('WebSite')['url']).toBe(`${NEW}/`);
    expect(byType('SoftwareApplication')['url']).toBe(`${NEW}/`);
    expect(JSON.stringify(graph)).not.toContain(OLD);
  });

  it('serves the MCP server card for the endpoint on the new origin', () => {
    const card = JSON.stringify(mcpServerCard());
    expect(card).toContain(`${NEW}/mcp`);
    expect(card).not.toContain(OLD);
  });
});
