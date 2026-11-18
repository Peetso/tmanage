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
import { OURS } from '../src/content/compare/compare-entries';
import { FACTS_DESCRIPTION } from '../src/content/facts/facts';

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

  it('says invoices exactly as they are live: one description everywhere, no online payment', () => {
    // INTEG14: client invoices are live (Finance > Invoices, portal invoices); paying them online
    // is not built (public-claims `pay_invoices_online` hidden).
    expect(TMANAGE_DESCRIPTION).toBe(FACTS_DESCRIPTION.en);
    expect(FACTS_DESCRIPTION.en).toContain('client invoices');
    expect(FACTS_DESCRIPTION.ar).toContain('فواتير العملاء');
    expect(OURS.invoices.en).toBe('Yes, invoices and retainers (no online payment yet)');
    expect(OURS.invoices.ar).toBe('نعم، فواتير وعقود شهرية (الدفع الإلكتروني غير متاح بعد)');
    expect(llmsTxt(ORIGIN)).toContain('Yes, invoices and retainers (no online payment yet)');
    expect(llmsFullTxt(ORIGIN)).not.toMatch(/pay invoices online/iu);
  });

  it('describes TManage as a workspace for companies, in both languages (SITEWORD)', () => {
    expect(TMANAGE_DESCRIPTION).toContain('workspace for companies and freelancers');
    expect(FACTS_DESCRIPTION.ar).toContain('للشركات والمستقلين');
    expect(llmsTxt(ORIGIN)).toContain(`> ${TMANAGE_DESCRIPTION} `);
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
