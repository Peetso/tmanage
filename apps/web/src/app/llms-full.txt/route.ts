import { llmsFullTxt } from '../../lib/site-text-files';

/**
 * `/llms-full.txt` (llmstxt.org, SEOA 2026-11-17): the `llms.txt` introduction and key facts, then
 * the full text of the most important public pages in one Markdown file, built from the same page
 * list as `sitemap.xml`. Prerendered.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(llmsFullTxt(), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}
