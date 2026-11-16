import { BETA_FAQ, BETA_INCLUDED } from '../components/website/pages/pricing/pricing-data';
import { ALL_RESOURCES } from '../components/website/pages/resources/resources-data';
import { COMPARE_COPY } from '../content/compare/compare-copy';
import { COMPARE_ENTRIES, COMPARE_FEATURES, OURS } from '../content/compare/compare-entries';
import { HELP_ARTICLES, type HelpBlock } from '../content/help/help-articles';
import { siteDescription } from './i18n/locale-html';
import { translate, type MessageKey } from './i18n/t';
import { PUBLIC_PAGE_SECTIONS, PUBLIC_PAGES, publicPageAt, type PublicPage } from './public-pages';
import { MARKDOWN_PREFIX, markdownPathFor } from './markdown-negotiation';
import { absoluteSiteUrl, siteOrigin } from './site-origin';

/**
 * The public site's plain-text files for crawlers and AI agents (AGENTREADY, 2026-11-16):
 * `robots.txt`, `llms.txt` and the Markdown version of each public page. All are built from
 * {@link PUBLIC_PAGES}, so a page is named in each of them or in none. No request value is read
 * here: a page is looked up by its exact path in that list, never used to build a file path.
 */

/** Kept out of crawlers: the JSON API, which has no page to carry a `noindex`. */
export const ROBOTS_DISALLOW = ['/v1/'] as const;

/**
 * Content Signals (contentsignals.org): the site may be indexed and quoted in AI answers, but not
 * used to train models.
 */
export const CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=no';

/** The `/robots.txt` body. */
export function robotsTxt(origin: string = siteOrigin()): string {
  return [
    'User-Agent: *',
    `Content-Signal: ${CONTENT_SIGNAL}`,
    'Allow: /',
    ...ROBOTS_DISALLOW.map((path) => `Disallow: ${path}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** The English page a Markdown address names, or `undefined` when it names none. */
export function pageForMarkdownSegments(
  segments: readonly string[] | undefined,
): PublicPage | undefined {
  return publicPageAt(`/${(segments ?? []).join('/')}`);
}

function link(page: PublicPage, origin: string): string {
  const note = page.summary === undefined ? '' : `: ${page.summary}`;
  return `- [${page.title}](${absoluteSiteUrl(page.path, origin)})${note}`;
}

/** The `/llms.txt` body (llmstxt.org): name, summary, then every public page by section. */
export function llmsTxt(origin: string = siteOrigin()): string {
  const sections = PUBLIC_PAGE_SECTIONS.flatMap(({ id, heading }) => {
    const pages = PUBLIC_PAGES.filter((page) => page.section === id);
    if (pages.length === 0) return [];
    const extra =
      id === 'developers'
        ? [
            `- [MCP server card](${origin}/.well-known/mcp/server-card.json): the hosted MCP endpoint, its transport and OAuth sign-in`,
          ]
        : [];
    return ['', `## ${heading}`, '', ...pages.map((page) => link(page, origin)), ...extra];
  });
  return [
    '# TManage',
    '',
    `> ${siteDescription('en-US')} ${translate('en', 'HomePage.heroLede')} Free for everyone during the beta; client users are always free. Available in English and Arabic (every page below has an Arabic twin under /ar).`,
    '',
    `Every page below is also available as Markdown: send \`Accept: text/markdown\`, or open the same path under ${MARKDOWN_PREFIX} (for example ${origin}${markdownPathFor('/pricing')}).`,
    ...sections,
    '',
  ].join('\n');
}

const en = (key: string): string => translate('en', key as MessageKey);

function helpBlock(block: HelpBlock): string {
  if (block.kind === 'p') return block.text;
  if (block.kind === 'tip') return `> Tip: ${block.text}`;
  return block.items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function pricingBody(): string[] {
  return [
    `## ${en('PricingPage.betaCardTitle')}`,
    en('PricingPage.betaCardBody'),
    `## ${en('PricingPage.betaIncludedTitle')}`,
    BETA_INCLUDED.map((key) => `- ${en(key)}`).join('\n'),
    `**${en('PricingPage.betaAfterLabel')}** ${en('PricingPage.betaAfterBody')}`,
    `## ${en('PricingPage.betaFaqTitle')}`,
    ...BETA_FAQ.map((item) => `### ${en(item.questionKey)}\n\n${en(item.answerKey)}`),
  ];
}

function compareBody(slug: string): string[] {
  const entry = COMPARE_ENTRIES.find((candidate) => candidate.slug === slug);
  if (entry === undefined) return [];
  const copy = COMPARE_COPY.en;
  const rows = COMPARE_FEATURES.map(
    (feature) =>
      `| ${copy.features[feature]} | ${OURS[feature].en} | ${entry.rows[feature]?.text.en ?? '—'} |`,
  );
  return [
    `## ${copy.suitsThem(entry.name)}`,
    entry.suits.en.map((line) => `- ${line}`).join('\n'),
    `## ${copy.suitsUs}`,
    copy.usSuits.map((line) => `- ${line}`).join('\n'),
    `## ${copy.sideBySide}`,
    [`| ${copy.need} | TManage | ${entry.name} |`, '| --- | --- | --- |', ...rows].join('\n'),
    `${copy.lastChecked(entry.checkedOn)}. [${copy.seePricing(entry.name)}](${entry.pricingUrl})`,
  ];
}

function bodyOf(page: PublicPage): string[] {
  if (page.path === '/pricing') return pricingBody();
  if (page.path.startsWith('/help/')) {
    const article = HELP_ARTICLES.find((item) => `/help/${item.slug}` === page.path);
    return article === undefined ? [] : article.en.body.map(helpBlock);
  }
  if (page.path.startsWith('/compare/')) return compareBody(page.path.slice('/compare/'.length));
  if (page.path.startsWith('/resources/')) {
    const item = ALL_RESOURCES.find((resource) => `/resources/${resource.slug}` === page.path);
    return item === undefined ? [] : [item.points.map((point) => `- ${point}`).join('\n')];
  }
  return [];
}

/**
 * The Markdown version of an English public page: its name, summary and the page's own text
 * where it is held as data (pricing, help articles, compare pages, library articles), then a link
 * to the full page. The home page's Markdown is the site index, `llms.txt`.
 */
export function publicPageMarkdown(page: PublicPage, origin: string = siteOrigin()): string {
  if (page.path === '/') return llmsTxt(origin);
  const url = absoluteSiteUrl(page.path, origin);
  return [
    `# ${page.title}`,
    ...(page.summary === undefined ? [] : [`> ${page.summary}`]),
    ...bodyOf(page),
    `Full page: [${url}](${url})`,
    '',
  ].join('\n\n');
}
