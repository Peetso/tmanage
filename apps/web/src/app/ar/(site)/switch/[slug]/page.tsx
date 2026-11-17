import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../../components/website/ArabicNotFound';
import { SwitchPage } from '../../../../../components/website/pages/compare/ComparePage';
import { SWITCH_COPY } from '../../../../../content/compare/compare-copy';
import { SWITCH_ENTRIES, findSwitchEntry } from '../../../../../content/compare/switch-entries';
import { TITLE_SUFFIX } from '../../../../../lib/route-titles';

/** Row 54-29 — one "switch from X" page in Arabic, `/ar/switch/[slug]`; other slugs are the Arabic 404. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return SWITCH_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = findSwitchEntry((await params).slug);
  if (entry === undefined) return ARABIC_NOT_FOUND_METADATA;
  return {
    title: { absolute: `${SWITCH_COPY.ar.title(entry.name)}${TITLE_SUFFIX}` },
    description: SWITCH_COPY.ar.description(entry.name),
  };
}

export default async function ArabicSwitchEntryRoute({ params }: { params: Params }) {
  const entry = findSwitchEntry((await params).slug);
  if (entry === undefined) notFound();
  return <SwitchPage entry={entry} />;
}
