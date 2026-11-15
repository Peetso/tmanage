import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../../components/website/ArabicNotFound';
import { ComparePage } from '../../../../../components/website/pages/compare/ComparePage';
import { COMPARE_ENTRIES, findCompareEntry } from '../../../../../content/compare/compare-entries';
import { COMPARE_COPY } from '../../../../../content/compare/compare-copy';
import { TITLE_SUFFIX } from '../../../../../lib/route-titles';

/** Row 57-06 — one compare page in Arabic, `/ar/compare/[slug]`; other slugs are the Arabic 404. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return COMPARE_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = findCompareEntry((await params).slug);
  if (entry === undefined) return ARABIC_NOT_FOUND_METADATA;
  return {
    title: { absolute: `${COMPARE_COPY.ar.title(entry.name)}${TITLE_SUFFIX}` },
    description: entry.strong.ar,
  };
}

export default async function ArabicCompareEntryRoute({ params }: { params: Params }) {
  const entry = findCompareEntry((await params).slug);
  if (entry === undefined) notFound();
  return <ComparePage entry={entry} />;
}
