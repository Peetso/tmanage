import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as markdownRoute } from '../src/app/md/[[...path]]/route';
import { GET as serverCardRoute } from '../src/app/.well-known/mcp/server-card.json/route';
import sitemap from '../src/app/sitemap';
import { WebsiteChrome } from '../src/components/website/WebsiteChrome';
import { WebMcpTools } from '../src/components/website/WebMcpTools';
import { prefersMarkdown, publicPageLinkHeader } from '../src/lib/markdown-negotiation';
import { MCP_SERVER_VERSION } from '../src/lib/mcp-server-card';
import { llmsTxt, robotsTxt } from '../src/lib/site-text-files';
import { homeGraph, jsonLdText, type JsonLd } from '../src/lib/structured-data';
import { workspaceGate } from '../src/lib/workspace-gate';

let mockPathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const ORIGIN = 'https://tmanageapp.com';

function chromeHtml(pathname: string): string {
  mockPathname = pathname;
  return renderToString(
    <WebsiteChrome>
      <main />
    </WebsiteChrome>,
  );
}

function jsonLdOf(html: string): JsonLd {
  const match = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html);
  return JSON.parse(match?.[1] ?? 'null') as JsonLd;
}

/** AGENTREADY (2026-11-16): the 15 findings of Hostinger's AI-visibility check, one by one. */
describe('agent-ready public site', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'modelContext');
  });

  it('1. robots.txt carries the Content-Signal line', () => {
    expect(robotsTxt(ORIGIN)).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
  });

  it('2. every sitemap URL has an ISO lastmod date', () => {
    expect(sitemap().every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(String(entry.lastModified)))).toBe(
      true,
    );
  });

  it('3. a signed-out unknown single-segment path is a 404, not a sign-in redirect', () => {
    const slug = 'this-page-does-not-exist-xyz';
    expect(workspaceGate({ slug, pathname: `/${slug}`, hasSession: false })).toEqual({
      kind: 'not-found',
    });
  });

  it('4. the home page names its absolute canonical URL', () => {
    expect(chromeHtml('/')).toContain(`<link rel="canonical" href="${ORIGIN}/"/>`);
  });

  it('5-8. the home page JSON-LD has Organization, WebSite and SoftwareApplication', () => {
    const graph = jsonLdOf(chromeHtml('/'))['@graph'] as readonly JsonLd[];
    expect(graph.map((node) => node['@type'])).toEqual([
      'Organization',
      'WebSite',
      'SoftwareApplication',
    ]);
  });

  it('the home page JSON-LD describes the product without the agency word (SITEWORD)', () => {
    for (const path of ['/', '/ar']) {
      const graph = jsonLdOf(chromeHtml(path))['@graph'] as readonly JsonLd[];
      const description = graph[2]?.['description'];
      expect([typeof description, description], path).toEqual(['string', expect.any(String)]);
      expect(description, path).not.toMatch(/\bagenc(?:y|ies)\b|وكال/iu);
    }
  });

  it('7. the Organization names the three social profiles', () => {
    const graph = homeGraph({ language: 'en', description: 'x', origin: ORIGIN })[
      '@graph'
    ] as readonly JsonLd[];
    expect(graph[0]?.['sameAs']).toHaveLength(3);
  });

  it('JSON-LD text cannot close its script element', () => {
    expect(jsonLdText({ name: '</script><b>&' })).toBe(
      '{"name":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}',
    );
  });

  it('Arabic pages get the same JSON-LD, in Arabic', () => {
    const graph = jsonLdOf(chromeHtml('/ar'))['@graph'] as readonly JsonLd[];
    expect(graph[1]?.['inLanguage']).toBe('ar');
  });

  it('9. the public footer shows the contact mailto link', () => {
    expect(chromeHtml('/pricing')).toContain('href="mailto:hello@tmanageapp.com"');
  });

  it('10-11. llms.txt starts with the site name and links the key pages', () => {
    const text = llmsTxt(ORIGIN);
    expect([text.startsWith('# TManage\n\n> '), text.includes(`](${ORIGIN}/pricing)`)]).toEqual([
      true,
      true,
    ]);
  });

  it('12. Accept: text/markdown is preferred only when it outranks HTML', () => {
    expect([
      prefersMarkdown('text/markdown'),
      prefersMarkdown('text/html,application/xhtml+xml,*/*;q=0.8'),
      prefersMarkdown('text/markdown;q=0.5, text/html'),
    ]).toEqual([true, false, false]);
  });

  it('12. the Markdown version of a page is text/markdown', async () => {
    const response = await markdownRoute(new Request(`${ORIGIN}/md/pricing`), {
      params: Promise.resolve({ path: ['pricing'] }),
    });
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  it('13. the Link header names llms.txt and the Markdown alternate', () => {
    expect(publicPageLinkHeader('/pricing')).toBe(
      '</llms.txt>; rel="describedby"; type="text/plain", </md/pricing>; rel="alternate"; type="text/markdown"; hreflang="en"',
    );
  });

  it('14. WebMCP registers the read-only tools where the browser offers it', () => {
    const registerTool = vi.fn();
    Object.defineProperty(navigator, 'modelContext', {
      value: { registerTool },
      configurable: true,
    });
    mockPathname = '/';
    render(<WebMcpTools />);
    expect(registerTool.mock.calls.map(([tool]) => (tool as { name: string }).name)).toEqual([
      'get_pricing_summary',
      'list_features',
      'open_sign_up',
    ]);
  });

  it('15. the MCP server card points at the hosted endpoint', async () => {
    const card = (await serverCardRoute().json()) as { transport: { endpoint: string } };
    expect(card.transport.endpoint).toBe(`${ORIGIN}/mcp`);
  });

  it('15. the server card version is the hosted catalog server version', () => {
    const catalog = readFileSync(
      join(process.cwd(), '..', 'mcp-server', 'src', 'catalog.ts'),
      'utf8',
    );
    expect(catalog).toContain(`CATALOG_SERVER_VERSION = '${MCP_SERVER_VERSION}'`);
  });
});
