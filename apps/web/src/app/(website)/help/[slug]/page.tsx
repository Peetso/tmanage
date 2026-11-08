import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { HelpArticlePage } from '../../../../components/website/pages/help/HelpArticlePage';
import { HELP_ARTICLES, findHelpArticle } from '../../../../content/help/help-articles';

/** Row 55-16 — one Help centre article, `/help/[slug]`; every article is prerendered. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return HELP_ARTICLES.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const article = findHelpArticle((await params).slug);
  return article
    ? { title: article.en.title, description: article.en.summary }
    : { title: 'Help centre' };
}

export default async function HelpArticleRoute({ params }: { params: Params }) {
  const article = findHelpArticle((await params).slug);
  if (article === undefined) notFound();
  return <HelpArticlePage article={article} />;
}
