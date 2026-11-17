import type { Metadata } from 'next';
import { MarketingResourceScreen } from '../../../../components/screens/MarketingResourceScreen';
import { ResourceArticlePage } from '../../../../components/website/pages/resources/ResourceArticlePage';
import { findResource } from '../../../../components/website/pages/resources/resources-data';
import { ResourceJsonLd } from '../../../../components/website/structured-data/ResourceJsonLd';

/**
 * **Public resource / guide article** — `/resources/[slug]`.
 *
 * Every card on the WEB-15 Resources index links here. A slug from that library renders the
 * website article page; any other slug falls through to {@link MarketingResourceScreen}, which
 * reads the `@Public()` `GET /v1/public/site/resources/:slug` catalog (module 1, x187) and renders
 * an honest "not found" with a way back to the index when the API does not name it either.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const item = findResource(slug);
  return item
    ? { title: item.tabTitle ?? item.title, description: item.line }
    : { title: 'Resources' };
}

export default async function ResourcePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const item = findResource(slug);
  if (item === undefined) return <MarketingResourceScreen slug={slug} />;
  return (
    <>
      <ResourceJsonLd english={`/resources/${item.slug}`} language="en" />
      <ResourceArticlePage item={item} />
    </>
  );
}
