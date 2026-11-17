import { ALTERNATIVE_COPY, PUBLIC_HERO_COPY } from '../../../content/alternatives/alternative-copy';
import {
  ALTERNATIVE_PAGES,
  ALTERNATIVES_UPDATED_ON,
  findAlternativePage,
} from '../../../content/alternatives/alternative-entries';
import { FACTS_COPY, FACTS_UPDATED_ON } from '../../../content/facts/facts';
import {
  breadcrumbList,
  faqPage,
  itemList,
  webPageAbout,
  type JsonLd,
} from '../../../lib/structured-data';
import { JsonLdScript, pageContext, type PageContext, type PageFamilyProps } from './page-context';

/** The alternatives hub: the list of alternative pages its cards show. */
function indexData(context: PageContext): JsonLd[] {
  const copy = ALTERNATIVE_COPY[context.language];
  return [
    itemList({
      name: copy.indexTitle,
      items: ALTERNATIVE_PAGES.map(({ entry, rival }) => ({
        name: copy.cardTitle(rival.name),
        url: context.url(`/alternatives/${entry.slug}`),
      })),
    }),
  ];
}

/** An alternative page: its trail, the two products with its date, and the questions it shows. */
function alternativeData(context: PageContext, slug: string): JsonLd[] {
  const page = findAlternativePage(slug);
  if (page === undefined) return [];
  const { language } = context;
  const copy = ALTERNATIVE_COPY[language];
  const { name } = page.rival;
  const url = context.url(context.english);
  const title = copy.title(name);
  return [
    breadcrumbList([
      { name: PUBLIC_HERO_COPY[language].home, url: context.url('/') },
      { name: copy.alternatives, url: context.url('/alternatives') },
      { name: title, url },
    ]),
    webPageAbout({
      language,
      url,
      name: title,
      about: ['TManage', name],
      dateModified: ALTERNATIVES_UPDATED_ON,
    }),
    faqPage({ language, url, items: copy.faq(name, page.entry.workWord, page.fit) }),
  ];
}

/** The facts page: its trail and the page about TManage, with the date it shows. */
function factsData(context: PageContext): JsonLd[] {
  const { language } = context;
  const copy = FACTS_COPY[language];
  const url = context.url('/facts');
  return [
    breadcrumbList([
      { name: PUBLIC_HERO_COPY[language].home, url: context.url('/') },
      { name: copy.title, url },
    ]),
    webPageAbout({
      language,
      url,
      name: copy.title,
      about: ['TManage'],
      dateModified: FACTS_UPDATED_ON,
    }),
  ];
}

function familyData(context: PageContext): JsonLd[] {
  const { english } = context;
  if (english === '/alternatives') return indexData(context);
  if (english === '/facts') return factsData(context);
  if (english.startsWith('/alternatives/')) {
    return alternativeData(context, english.slice('/alternatives/'.length));
  }
  return [];
}

/** SEOF — the alternatives hub, an alternative page (`/alternatives/<slug>`) or the facts page. */
export function AlternativesJsonLd({ english, language }: PageFamilyProps) {
  return <JsonLdScript items={familyData(pageContext(english, language))} />;
}
