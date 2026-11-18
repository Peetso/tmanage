import { describe, expect, it } from 'vitest';
import { ALTERNATIVE_COPY, PUBLIC_HERO_COPY } from '../src/content/alternatives/alternative-copy';
import { ALTERNATIVE_ENTRIES } from '../src/content/alternatives/alternative-entries';
import { COMPARE_LINKS_COPY } from '../src/content/alternatives/compare-links';
import {
  ARABIC_FIRST_COPY,
  USE_CASE_COPY,
  USE_CASE_ENTRIES,
} from '../src/content/arabic/arabic-pages';
import { COMPARE_COPY, SWITCH_COPY } from '../src/content/compare/compare-copy';
import { COMPARE_ENTRIES, OURS } from '../src/content/compare/compare-entries';
import { SWITCH_ENTRIES } from '../src/content/compare/switch-entries';
import { FACTS_COPY, FACTS_DESCRIPTION } from '../src/content/facts/facts';
import { PUBLIC_PAGES } from '../src/lib/public-pages';
import { llmsFullTxt, llmsTxt, publicPageMarkdown } from '../src/lib/site-text-files';
import { homeGraph, jsonLdText } from '../src/lib/structured-data';

const ORIGIN = 'https://tmanageapp.com';

/** The one page that speaks to agencies by name: the agencies segment page. */
const SEGMENT_PATH = '/solutions/agencies';

/** "agency" / "agencies" in English, and the وكالة family in Arabic. */
const AGENCY_WORD = /\bagenc(?:y|ies)\b|وكال/iu;

/**
 * One argument that reads as every argument a copy function takes: a product name, address or ISO
 * date (`${name}`, a valid date so the date formatters run), a list of names (`names.join`) and an
 * `AlternativeFit` (`fit.theyHaveArabic`).
 */
function sample(fit: boolean): unknown {
  return Object.assign(['2026-11-19'], {
    hasSwitchPage: fit,
    theyHaveArabic: fit,
    theyListClients: fit,
    toString: () => '2026-11-19',
  });
}

/**
 * Every string a content value holds. A function (a title built from a product name, the facts
 * rows built from the website address) is called with both samples and its results read.
 */
function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    const build = value as (...args: unknown[]) => unknown;
    return [true, false].flatMap((fit) =>
      textsOf(build(...Array.from({ length: build.length }, () => sample(fit)))),
    );
  }
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(textsOf);
  return [];
}

/** The lines of a site text file, without those that only link to the segment page. */
function linesOutsideSegment(text: string): string[] {
  return text.split('\n').filter((line) => !line.includes(`${ORIGIN}${SEGMENT_PATH})`));
}

function offenders(texts: readonly string[]): string[] {
  return texts.filter((text) => AGENCY_WORD.test(text));
}

/**
 * SITEWORD (B06, 2026-11-19): TManage is for every company, so the public site names the company,
 * not an agency. Only the agencies segment page (and a link to it) may say "agency".
 */
describe('public site company wording', () => {
  it('the content data never says "agency" in English or Arabic', () => {
    const content = [
      FACTS_DESCRIPTION,
      FACTS_COPY,
      ALTERNATIVE_COPY,
      PUBLIC_HERO_COPY,
      ALTERNATIVE_ENTRIES,
      COMPARE_LINKS_COPY,
      COMPARE_COPY,
      SWITCH_COPY,
      COMPARE_ENTRIES,
      OURS,
      SWITCH_ENTRIES,
      ARABIC_FIRST_COPY,
      USE_CASE_COPY,
      USE_CASE_ENTRIES,
    ];
    expect(offenders(textsOf(content))).toEqual([]);
  });

  it('llms.txt and llms-full.txt say "agency" only when linking to the segment page', () => {
    expect(offenders(linesOutsideSegment(llmsTxt(ORIGIN)))).toEqual([]);
    expect(offenders(linesOutsideSegment(llmsFullTxt(ORIGIN)))).toEqual([]);
  });

  it('every Markdown twin except the segment page is free of the word', () => {
    const pages = PUBLIC_PAGES.filter((page) => page.path !== SEGMENT_PATH);
    const found = pages.flatMap((page) =>
      offenders(linesOutsideSegment(publicPageMarkdown(page, ORIGIN))).map(
        (line) => `${page.path}: ${line}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('the structured data describes TManage without the word', () => {
    for (const language of ['en', 'ar'] as const) {
      const graph = homeGraph({
        language,
        description: FACTS_DESCRIPTION[language],
        origin: ORIGIN,
      });
      expect(jsonLdText(graph)).not.toMatch(AGENCY_WORD);
    }
  });

  it('the word test itself catches both languages', () => {
    expect(offenders(['for agencies', 'An agency', 'للوكالات', 'وكالتك', 'for companies'])).toEqual(
      ['for agencies', 'An agency', 'للوكالات', 'وكالتك'],
    );
  });
});
