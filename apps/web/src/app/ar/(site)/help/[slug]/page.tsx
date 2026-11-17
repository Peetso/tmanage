import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../../components/website/ArabicNotFound';
import { HelpArticlePage } from '../../../../../components/website/pages/help/HelpArticlePage';
import { HELP_ARTICLES, findHelpArticle } from '../../../../../content/help/help-articles';
import { TITLE_SUFFIX } from '../../../../../lib/route-titles';
import { HelpJsonLd } from '../../../../../components/website/structured-data/HelpJsonLd';

/** Row 55-16 — one Help centre article in Arabic, `/ar/help/[slug]`; other slugs are the Arabic 404. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return HELP_ARTICLES.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const article = findHelpArticle((await params).slug);
  if (article === undefined) return ARABIC_NOT_FOUND_METADATA;
  return {
    title: { absolute: `${article.ar.title}${TITLE_SUFFIX}` },
    description: article.ar.summary,
  };
}

export default async function ArabicHelpArticleRoute({ params }: { params: Params }) {
  const article = findHelpArticle((await params).slug);
  if (article === undefined) notFound();
  return (
    <>
      <HelpJsonLd english={`/help/${article.slug}`} language="ar" />
      <HelpArticlePage article={article} />
    </>
  );
}
