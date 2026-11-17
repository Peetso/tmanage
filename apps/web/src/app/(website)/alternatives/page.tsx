import type { Metadata } from 'next';
import { AlternativesIndexPage } from '../../../components/website/pages/alternatives/AlternativesIndexPage';
import { AlternativesJsonLd } from '../../../components/website/structured-data/AlternativesJsonLd';
import { ALTERNATIVE_COPY } from '../../../content/alternatives/alternative-copy';

export const metadata: Metadata = {
  title: ALTERNATIVE_COPY.en.indexTitle,
  description: ALTERNATIVE_COPY.en.indexDescription,
};

/** SEOF (B1) — the alternatives index, `/alternatives` (Arabic twin at `/ar/alternatives`). */
export default function AlternativesRoute() {
  return (
    <>
      <AlternativesJsonLd english="/alternatives" language="en" />
      <AlternativesIndexPage />
    </>
  );
}
