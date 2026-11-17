import { describe, expect, it } from 'vitest';
import { GET as markdownRoute } from '../src/app/md/[[...path]]/route';
import { GET as llmsFullRoute } from '../src/app/llms-full.txt/route';
import {
  LLMS_FULL_PAGE_LIMIT,
  TMANAGE_DESCRIPTION,
  llmsFullPages,
  llmsFullTxt,
  llmsTxt,
} from '../src/lib/site-text-files';

const ORIGIN = 'https://tmanageapp.com';

/** SEOA (2026-11-17): the richer llms.txt, llms-full.txt and the Markdown twins' headers. */
describe('llms files and Markdown twins', () => {
  it('llms.txt opens with the fixed description, key facts and the pages to start with', () => {
    const text = llmsTxt(ORIGIN);
    const facts = text.indexOf('## Key facts');
    const start = text.indexOf('## Start here');
    expect(text.startsWith(`# TManage\n\n> ${TMANAGE_DESCRIPTION} `)).toBe(true);
    expect([facts > 0, start > facts]).toEqual([true, true]);
    expect(text.slice(start)).toContain(`](${ORIGIN}/pricing)`);
    expect(text).toContain(`](${ORIGIN}/llms-full.txt)`);
    expect(text).toContain('- Price: Free during the beta.');
  });

  it('llms-full.txt carries at most the page limit, pricing first, each with its own address', () => {
    const pages = llmsFullPages();
    const text = llmsFullTxt(ORIGIN);
    expect([pages.length <= LLMS_FULL_PAGE_LIMIT, pages[0]?.path]).toEqual([true, '/pricing']);
    expect(text).toContain(`## TManage vs Basecamp\n\nSource: [${ORIGIN}/compare/basecamp]`);
    expect(text).not.toMatch(/^# (?!TManage$)/m);
  });

  it('llms-full.txt is served as plain text', async () => {
    const response = llmsFullRoute();
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toContain('## Key facts');
  });

  it('a Markdown twin is noindex and names its HTML page as canonical', async () => {
    const response = await markdownRoute(new Request(`${ORIGIN}/md/pricing`), {
      params: Promise.resolve({ path: ['pricing'] }),
    });
    expect([response.headers.get('x-robots-tag'), response.headers.get('link')]).toEqual([
      'noindex',
      `<${ORIGIN}/pricing>; rel="canonical"; type="text/html"`,
    ]);
  });
});
