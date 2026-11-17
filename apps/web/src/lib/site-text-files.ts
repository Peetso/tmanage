import { BETA_FAQ, BETA_INCLUDED } from '../components/website/pages/pricing/pricing-data';
import { ALL_RESOURCES } from '../components/website/pages/resources/resources-data';
import { alternativeMarkdown } from '../content/alternatives/alternative-markdown';
import { FACTS_DESCRIPTION, factsMarkdown } from '../content/facts/facts';
import { COMPARE_COPY, SWITCH_COPY } from '../content/compare/compare-copy';
import { COMPARE_ENTRIES, COMPARE_FEATURES, OURS } from '../content/compare/compare-entries';
import { findSwitchEntry } from '../content/compare/switch-entries';
import { HELP_ARTICLES, type HelpBlock } from '../content/help/help-articles';
import { translate, type MessageKey } from './i18n/t';
import { PUBLIC_PAGE_SECTIONS, PUBLIC_PAGES, publicPageAt, type PublicPage } from './public-pages';
import { MARKDOWN_PREFIX, markdownPathFor } from './markdown-negotiation';
import { HELLO_EMAIL, SUPPORT_EMAIL } from './public-contact';
import { absoluteSiteUrl, siteOrigin } from './site-origin';

const en = (key: string): string => translate('en', key as MessageKey);

/**
 * The public site's plain-text files for crawlers and AI agents (AGENTREADY, 2026-11-16):
 * `robots.txt`, `llms.txt`, `llms-full.txt` (SEOA, 2026-11-17) and the Markdown version of each
 * public page. All are built from
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

/**
 * The one fixed description of TManage (SEO/GEO plan 4.3), used word for word wherever the site
 * describes itself to machines.
 */
export const TMANAGE_DESCRIPTION: string = FACTS_DESCRIPTION.en;

/** The address of the full-text file. */
export const LLMS_FULL_PATH = '/llms-full.txt';

/** How many pages `llms-full.txt` carries in full. */
export const LLMS_FULL_PAGE_LIMIT = 20;

/**
 * The pages named first in `llms.txt`, in order. One that is not (yet) a public page is left out,
 * so the facts page (B7) is named here as soon as it is registered.
 */
const KEY_PAGE_PATHS = ['/facts', '/pricing', '/compare'] as const;

/**
 * Key facts, each true of the product today: the TManage column of the compare pages, the price
 * and the contact addresses. When the facts page (B7) lands, its data replaces this list.
 */
export function keyFacts(): string[] {
  const words = COMPARE_COPY.en;
  return [
    ...COMPARE_FEATURES.map((feature) => `${words.features[feature]}: ${OURS[feature].en}`),
    `${words.price}: ${OURS.price.en}. ${en('PricingPage.betaAfterBody')}`,
    `Contact: ${HELLO_EMAIL} (support: ${SUPPORT_EMAIL})`,
  ];
}

function intro(origin: string): string[] {
  const keyPages = KEY_PAGE_PATHS.flatMap((path) => {
    const page = publicPageAt(path);
    return page === undefined ? [] : [link(page, origin)];
  });
  return [
    '# TManage',
    '',
    `> ${TMANAGE_DESCRIPTION} ${en('HomePage.betaHeroLede')} Free for everyone during the beta; client users are always free. Every page below has an Arabic twin under /ar.`,
    '',
    '## Key facts',
    '',
    ...keyFacts().map((fact) => `- ${fact}`),
    '',
    '## Start here',
    '',
    ...keyPages,
    `- [Full text of the main pages](${origin}${LLMS_FULL_PATH}): pricing, comparisons, switch guides and help articles in one Markdown file`,
  ];
}

/** The `/llms.txt` body (llmstxt.org): name, summary, key facts, then every public page by section. */
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
    ...intro(origin),
    '',
    `Every page below is also available as Markdown: send \`Accept: text/markdown\`, or open the same path under ${MARKDOWN_PREFIX} (for example ${origin}${markdownPathFor('/pricing')}).`,
    ...sections,
    '',
  ].join('\n');
}

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

function switchBody(slug: string): string[] {
  const entry = findSwitchEntry(slug);
  if (entry === undefined) return [];
  const words = SWITCH_COPY.en;
  const rows = entry.rows.map((row) => `| ${row.from.en} | ${row.to.en} |`);
  return [
    `## ${words.situationsTitle}`,
    entry.situations.en.map((line) => `- ${line}`).join('\n'),
    `## ${words.carriesTitle}`,
    [`| ${words.from(entry.name)} | ${words.into} |`, '| --- | --- |', ...rows].join('\n'),
    `## ${words.howTitle}`,
    entry.how.en,
    `## ${words.undoTitle}`,
    words.undo,
    `## ${words.filesTitle}`,
    words.files,
  ];
}

function helpBody(slug: string): string[] {
  const article = HELP_ARTICLES.find((item) => item.slug === slug);
  return article === undefined ? [] : article.en.body.map(helpBlock);
}

function resourceBody(slug: string): string[] {
  const item = ALL_RESOURCES.find((resource) => resource.slug === slug);
  return item === undefined ? [] : [item.points.map((point) => `- ${point}`).join('\n')];
}

/**
 * The pages whose own text is held as data, most important first: a path ending in `/` names
 * every page under it (the builder gets the rest of the path), any other path names one page.
 * `llms-full.txt` takes its pages in this order. A new page type with text (the facts page, B7)
 * adds one line here.
 */
const PAGE_BODIES: readonly (readonly [string, (rest: string) => string[]])[] = [
  ['/pricing', pricingBody],
  ['/facts', () => factsMarkdown(siteOrigin())],
  ['/alternatives/', alternativeMarkdown],
  ['/compare/', compareBody],
  ['/switch/', switchBody],
  ['/help/', helpBody],
  ['/resources/', resourceBody],
];

/** Whether a {@link PAGE_BODIES} path names the page. */
function names(path: string, page: PublicPage): boolean {
  return path.endsWith('/') ? page.path.startsWith(path) : page.path === path;
}

function bodyOf(page: PublicPage): string[] {
  for (const [path, build] of PAGE_BODIES) {
    if (names(path, page)) {
      return build(page.path.slice(path.endsWith('/') ? path.length : page.path.length));
    }
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

/** Every heading one level deeper, so a page's own headings sit under its `##` in the full file. */
function deeper(markdown: string): string {
  return markdown.replace(/^(#{1,5}) /gm, '#$1 ');
}

/**
 * The pages `llms-full.txt` carries: those whose text is held as data, at most
 * {@link LLMS_FULL_PAGE_LIMIT}. The {@link PAGE_BODIES} groups are taken in turn (the first page of
 * each group in order, then the second of each, ...), so one large group (18 alternative pages)
 * cannot push the compare, switch, help and library pages out of the file.
 */
export function llmsFullPages(): PublicPage[] {
  const groups = PAGE_BODIES.map(([path]) =>
    PUBLIC_PAGES.filter((page) => names(path, page) && bodyOf(page).length > 0),
  );
  const rounds = Math.max(0, ...groups.map((group) => group.length));
  const pages: PublicPage[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const group of groups) {
      const page = group[round];
      if (page !== undefined) pages.push(page);
    }
  }
  return pages.slice(0, LLMS_FULL_PAGE_LIMIT);
}

/**
 * The `/llms-full.txt` body (llmstxt.org): the `llms.txt` introduction and key facts, then the
 * full text of the most important pages, each under its own heading with its address.
 */
export function llmsFullTxt(origin: string = siteOrigin()): string {
  const pages = llmsFullPages().map((page) => {
    const url = absoluteSiteUrl(page.path, origin);
    return [
      `## ${page.title}`,
      `Source: [${url}](${url})`,
      ...(page.summary === undefined ? [] : [`> ${page.summary}`]),
      ...bodyOf(page).map(deeper),
    ].join('\n\n');
  });
  return [...intro(origin), '', pages.join('\n\n'), ''].join('\n');
}
