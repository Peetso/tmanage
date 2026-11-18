import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ArabicUseCasePage } from '../../../../components/website/pages/arabic/ArabicFirstPage';
import {
  USE_CASE_COPY,
  USE_CASE_ENTRIES,
  findUseCase,
} from '../../../../content/arabic/arabic-pages';

/** Row 57-07 (MENA) — one use-case page, `/arabic/[slug]`; every entry is prerendered. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return USE_CASE_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = findUseCase((await params).slug);
  if (entry === undefined) return {};
  return { title: USE_CASE_COPY.en.tabTitle(entry.en.name), description: entry.en.lede };
}

export default async function ArabicUseCaseRoute({ params }: { params: Params }) {
  const entry = findUseCase((await params).slug);
  if (entry === undefined) notFound();
  return <ArabicUseCasePage entry={entry} />;
}
