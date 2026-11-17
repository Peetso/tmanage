import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ComparePage } from '../../../../components/website/pages/compare/ComparePage';
import { COMPARE_ENTRIES, findCompareEntry } from '../../../../content/compare/compare-entries';
import { COMPARE_COPY } from '../../../../content/compare/compare-copy';
import { CompareJsonLd } from '../../../../components/website/structured-data/CompareJsonLd';

/** Row 57-06 — one compare page, `/compare/[slug]`; every entry is prerendered. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return COMPARE_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = findCompareEntry((await params).slug);
  return entry
    ? { title: COMPARE_COPY.en.title(entry.name), description: entry.strong.en }
    : { title: COMPARE_COPY.en.indexTitle };
}

export default async function CompareEntryRoute({ params }: { params: Params }) {
  const entry = findCompareEntry((await params).slug);
  if (entry === undefined) notFound();
  return (
    <>
      <CompareJsonLd english={`/compare/${entry.slug}`} language="en" />
      <ComparePage entry={entry} />
    </>
  );
}
