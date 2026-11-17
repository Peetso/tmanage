import type { Metadata } from 'next';
import { CompareIndexPage } from '../../../components/website/pages/compare/CompareIndexPage';
import { COMPARE_COPY } from '../../../content/compare/compare-copy';
import { CompareJsonLd } from '../../../components/website/structured-data/CompareJsonLd';

export const metadata: Metadata = {
  title: COMPARE_COPY.en.indexTitle,
  description: COMPARE_COPY.en.indexLede,
};

/** Row 57-06 — the compare index, `/compare` (Arabic twin at `/ar/compare`). */
export default function CompareRoute() {
  return (
    <>
      <CompareJsonLd english="/compare" language="en" />
      <CompareIndexPage />
    </>
  );
}
