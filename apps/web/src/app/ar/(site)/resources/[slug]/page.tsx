import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../../components/website/ArabicNotFound';
import { ResourceArticlePage } from '../../../../../components/website/pages/resources/ResourceArticlePage';
import {
  ALL_RESOURCES,
  findResource,
} from '../../../../../components/website/pages/resources/resources-data';
import { ARABIC_ROUTE_LOCALE } from '../../../../../lib/i18n/public-locale-routes';
import { translate } from '../../../../../lib/i18n/t';
import { TITLE_SUFFIX } from '../../../../../lib/route-titles';

/**
 * **A library article in Arabic** — `/ar/resources/[slug]` (Figma `426:13485`).
 *
 * The English article page component under the Arabic route locale, so the title, summary,
 * category and takeaways are Arabic in the prerendered HTML. Every article of the library is
 * prerendered; any other slug is the Arabic 404 (`notFound()` below, answered by
 * `(site)/not-found.tsx`) — unlike English, there is no API catalog fallback in Arabic.
 */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return ALL_RESOURCES.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const item = findResource((await params).slug);
  if (item === undefined) return ARABIC_NOT_FOUND_METADATA;
  return {
    title: { absolute: `${translate(ARABIC_ROUTE_LOCALE, item.titleKey)}${TITLE_SUFFIX}` },
    description: translate(ARABIC_ROUTE_LOCALE, item.lineKey),
  };
}

export default async function ArabicResourcePage({ params }: { params: Params }) {
  const item = findResource((await params).slug);
  if (item === undefined) notFound();
  return <ResourceArticlePage item={item} />;
}
