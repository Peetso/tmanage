import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../../components/website/ArabicNotFound';
import { ArabicUseCasePage } from '../../../../../components/website/pages/arabic/ArabicFirstPage';
import {
  USE_CASE_COPY,
  USE_CASE_ENTRIES,
  findUseCase,
} from '../../../../../content/arabic/arabic-pages';
import { TITLE_SUFFIX } from '../../../../../lib/route-titles';

/** Row 57-07 (MENA) — one use-case page in Arabic, `/ar/arabic/[slug]`; others are the Arabic 404. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return USE_CASE_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = findUseCase((await params).slug);
  if (entry === undefined) return ARABIC_NOT_FOUND_METADATA;
  return {
    title: { absolute: `${USE_CASE_COPY.ar.tabTitle(entry.ar.name)}${TITLE_SUFFIX}` },
    description: entry.ar.lede,
  };
}

export default async function ArabicArabicUseCaseRoute({ params }: { params: Params }) {
  const entry = findUseCase((await params).slug);
  if (entry === undefined) notFound();
  return <ArabicUseCasePage entry={entry} />;
}
