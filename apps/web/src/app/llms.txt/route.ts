import { llmsTxt } from '../../lib/site-text-files';

/**
 * `/llms.txt` (llmstxt.org, AGENTREADY): the site's name, a one-paragraph summary and every
 * public page by section, built from the same page list as `sitemap.xml`. Prerendered.
 */
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(llmsTxt(), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });
}
