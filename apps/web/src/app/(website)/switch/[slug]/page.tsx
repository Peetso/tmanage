import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SwitchPage } from '../../../../components/website/pages/compare/ComparePage';
import { SWITCH_COPY } from '../../../../content/compare/compare-copy';
import { SWITCH_ENTRIES, findSwitchEntry } from '../../../../content/compare/switch-entries';

/** Row 54-29 — one "switch from X" page, `/switch/[slug]`; every entry is prerendered. */
type Params = Promise<{ slug: string }>;

export function generateStaticParams(): { slug: string }[] {
  return SWITCH_ENTRIES.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = findSwitchEntry((await params).slug);
  return entry
    ? {
        title: SWITCH_COPY.en.title(entry.name),
        description: SWITCH_COPY.en.description(entry.name),
      }
    : {};
}

export default async function SwitchEntryRoute({ params }: { params: Params }) {
  const entry = findSwitchEntry((await params).slug);
  if (entry === undefined) notFound();
  return <SwitchPage entry={entry} />;
}
