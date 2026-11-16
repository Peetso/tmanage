/**
 * Content negotiation for the public pages' Markdown versions (AGENTREADY, 2026-11-16), kept free
 * of page data so the proxy can read it cheaply. The Markdown itself is `site-text-files.ts`.
 */

/** The prefix the Markdown version of a public page is served under (`/md/pricing`). */
export const MARKDOWN_PREFIX = '/md';

/** The Markdown address of an English public page (`/` → `/md`, `/pricing` → `/md/pricing`). */
export function markdownPathFor(path: string): string {
  return path === '/' ? MARKDOWN_PREFIX : `${MARKDOWN_PREFIX}${path}`;
}

/** One media range of an `Accept` header and its quality. */
function qualityOf(accept: string, type: string): number {
  let best = -1;
  for (const part of accept.split(',')) {
    const [range = '', ...params] = part.split(';').map((piece) => piece.trim().toLowerCase());
    if (range !== type) continue;
    const q = params.find((param) => param.startsWith('q='));
    const value = q === undefined ? 1 : Number(q.slice(2));
    if (Number.isFinite(value)) best = Math.max(best, value);
  }
  return best;
}

/**
 * Whether an `Accept` header asks for Markdown over HTML: `text/markdown` is listed with a
 * quality above zero and above `text/html`'s. A browser never lists it, so HTML stays the default.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (accept === null) return false;
  const markdown = qualityOf(accept, 'text/markdown');
  return markdown > 0 && markdown > qualityOf(accept, 'text/html');
}

/**
 * The RFC 8288 `Link` header of a public page: `llms.txt` describes the site, and the English
 * page's Markdown version is its alternate (`englishPath` is the page itself or the English twin
 * of an Arabic page).
 */
export function publicPageLinkHeader(englishPath: string): string {
  return [
    '</llms.txt>; rel="describedby"; type="text/plain"',
    `<${markdownPathFor(englishPath)}>; rel="alternate"; type="text/markdown"; hreflang="en"`,
  ].join(', ');
}
