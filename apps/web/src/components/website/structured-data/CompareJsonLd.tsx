import { COMPARE_COPY, SWITCH_COPY } from '../../../content/compare/compare-copy';
import { COMPARE_ENTRIES, findCompareEntry } from '../../../content/compare/compare-entries';
import { findSwitchEntry } from '../../../content/compare/switch-entries';
import {
  breadcrumbList,
  howTo,
  itemList,
  webPageAbout,
  type JsonLd,
} from '../../../lib/structured-data';
import { JsonLdScript, pageContext, type PageContext, type PageFamilyProps } from './page-context';

/** The compare hub: the list of compare pages its cards show. */
function compareIndexData(context: PageContext): JsonLd[] {
  const copy = COMPARE_COPY[context.language];
  return [
    itemList({
      name: copy.indexTitle,
      items: COMPARE_ENTRIES.map((entry) => ({
        name: copy.title(entry.name),
        url: context.url(`/compare/${entry.slug}`),
      })),
    }),
  ];
}

/** A compare page: its trail back to the hub and the two products, with the checked date. */
function compareData(context: PageContext, slug: string): JsonLd[] {
  const entry = findCompareEntry(slug);
  if (entry === undefined) return [];
  const copy = COMPARE_COPY[context.language];
  const url = context.url(context.english);
  const name = copy.title(entry.name);
  return [
    breadcrumbList([
      { name: copy.allCompare, url: context.url('/compare') },
      { name, url },
    ]),
    webPageAbout({
      language: context.language,
      url,
      name,
      about: ['TManage', entry.name],
      dateModified: entry.checkedOn,
    }),
  ];
}

/** A switch page: the two products and the "How the move works" text it shows. */
function switchData(context: PageContext, slug: string): JsonLd[] {
  const entry = findSwitchEntry(slug);
  if (entry === undefined) return [];
  const words = SWITCH_COPY[context.language];
  const url = context.url(context.english);
  return [
    webPageAbout({
      language: context.language,
      url,
      name: words.title(entry.name),
      about: ['TManage', entry.name],
    }),
    howTo({
      language: context.language,
      url,
      name: words.howTitle,
      steps: [entry.how[context.language]],
    }),
  ];
}

function compareFamilyData(context: PageContext): JsonLd[] {
  const { english } = context;
  if (english === '/compare') return compareIndexData(context);
  if (english.startsWith('/compare/')) {
    return compareData(context, english.slice('/compare/'.length));
  }
  if (english.startsWith('/switch/')) return switchData(context, english.slice('/switch/'.length));
  return [];
}

/** The compare hub, a compare page (`/compare/<slug>`) or a switch page (`/switch/<slug>`). */
export function CompareJsonLd({ english, language }: PageFamilyProps) {
  return <JsonLdScript items={compareFamilyData(pageContext(english, language))} />;
}
