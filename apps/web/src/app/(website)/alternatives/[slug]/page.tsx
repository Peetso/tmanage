import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlternativePage } from '../../../../components/website/pages/alternatives/AlternativePage';
import { AlternativesJsonLd } from '../../../../components/website/structured-data/AlternativesJsonLd';
import { ALTERNATIVE_COPY } from '../../../../content/alternatives/alternative-copy';
import {
  ALTERNATIVE_PAGES,
  findAlternativePage,
} from '../../../../content/alternatives/alternative-entries';

/** SEOF (B1) — one alternative page, `/alternatives/[slug]`; every entry is prerendered. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return ALTERNATIVE_PAGES.map((page) => ({ slug: page.entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const page = findAlternativePage((await params).slug);
  return page
    ? {
        title: ALTERNATIVE_COPY.en.tabTitle(page.rival.name),
        description: ALTERNATIVE_COPY.en.description(page.rival.name),
      }
    : { title: ALTERNATIVE_COPY.en.indexTitle };
}

export default async function AlternativeRoute({ params }: { params: Params }) {
  const page = findAlternativePage((await params).slug);
  if (page === undefined) notFound();
  return (
    <>
      <AlternativesJsonLd english={`/alternatives/${page.entry.slug}`} language="en" />
      <AlternativePage page={page} />
    </>
  );
}
