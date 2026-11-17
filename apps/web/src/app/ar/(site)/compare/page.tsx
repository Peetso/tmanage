import type { Metadata } from 'next';
import { CompareIndexPage } from '../../../../components/website/pages/compare/CompareIndexPage';
import { COMPARE_COPY } from '../../../../content/compare/compare-copy';
import { TITLE_SUFFIX } from '../../../../lib/route-titles';
import { CompareJsonLd } from '../../../../components/website/structured-data/CompareJsonLd';

/** Row 57-06 — the compare index in Arabic, `/ar/compare`. */
export const metadata: Metadata = {
  title: { absolute: `${COMPARE_COPY.ar.indexTitle}${TITLE_SUFFIX}` },
  description: COMPARE_COPY.ar.indexLede,
};

export default function ArabicCompareRoute() {
  return (
    <>
      <CompareJsonLd english="/compare" language="ar" />
      <CompareIndexPage />
    </>
  );
}
