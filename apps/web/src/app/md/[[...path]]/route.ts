import { PUBLIC_PAGES } from '../../../lib/public-pages';
import { markdownPathFor } from '../../../lib/markdown-negotiation';
import { absoluteSiteUrl } from '../../../lib/site-origin';
import { pageForMarkdownSegments, publicPageMarkdown } from '../../../lib/site-text-files';

/**
 * The Markdown version of every English public page (AGENTREADY): `/md` is the home page,
 * `/md/pricing` the pricing page. The proxy also serves it at the page's own address when the
 * request's `Accept` asks for `text/markdown` (`proxy.ts`). Every address is prerendered, and any
 * other answers 404 before this runs (`dynamicParams = false`): the segments are only looked up in
 * the page list.
 */
type Params = Promise<{ path?: string[] }>;

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams(): { path: string[] }[] {
  return PUBLIC_PAGES.map((page) => ({
    path: markdownPathFor(page.path)
      .split('/')
      .filter((segment) => segment !== '')
      .slice(1),
  }));
}

export async function GET(_request: Request, { params }: { params: Params }): Promise<Response> {
  const page = pageForMarkdownSegments((await params).path);
  if (page === undefined) return new Response('Not found\n', { status: 404 });
  return new Response(publicPageMarkdown(page), { headers: markdownHeaders(page.path) });
}

/**
 * The Markdown twin's headers (SEOA 2026-11-17): kept out of search indexes (`noindex`) and
 * pointing at the HTML page as the canonical address, so the twin never competes with the page.
 */
function markdownHeaders(path: string): Record<string, string> {
  return {
    'content-type': 'text/markdown; charset=utf-8',
    vary: 'Accept',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    link: `<${absoluteSiteUrl(path)}>; rel="canonical"; type="text/html"`,
  };
}
