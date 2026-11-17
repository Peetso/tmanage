import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../../components/website/ArabicNotFound';
import { AlternativePage } from '../../../../../components/website/pages/alternatives/AlternativePage';
import { AlternativesJsonLd } from '../../../../../components/website/structured-data/AlternativesJsonLd';
import { ALTERNATIVE_COPY } from '../../../../../content/alternatives/alternative-copy';
import {
  ALTERNATIVE_PAGES,
  findAlternativePage,
} from '../../../../../content/alternatives/alternative-entries';
import { TITLE_SUFFIX } from '../../../../../lib/route-titles';

/** SEOF (B1) — one alternative page in Arabic, `/ar/alternatives/[slug]`; others are the Arabic 404. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return ALTERNATIVE_PAGES.map((page) => ({ slug: page.entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const page = findAlternativePage((await params).slug);
  if (page === undefined) return ARABIC_NOT_FOUND_METADATA;
  return {
    title: { absolute: `${ALTERNATIVE_COPY.ar.tabTitle(page.rival.name)}${TITLE_SUFFIX}` },
    description: ALTERNATIVE_COPY.ar.description(page.rival.name),
  };
}

export default async function ArabicAlternativeRoute({ params }: { params: Params }) {
  const page = findAlternativePage((await params).slug);
  if (page === undefined) notFound();
  return (
    <>
      <AlternativesJsonLd english={`/alternatives/${page.entry.slug}`} language="ar" />
      <AlternativePage page={page} />
    </>
  );
}
