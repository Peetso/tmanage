import type { Metadata } from 'next';
import { AlternativesIndexPage } from '../../../../components/website/pages/alternatives/AlternativesIndexPage';
import { AlternativesJsonLd } from '../../../../components/website/structured-data/AlternativesJsonLd';
import { ALTERNATIVE_COPY } from '../../../../content/alternatives/alternative-copy';
import { TITLE_SUFFIX } from '../../../../lib/route-titles';

/** SEOF (B1) — the alternatives index in Arabic, `/ar/alternatives`. */
export const metadata: Metadata = {
  title: { absolute: `${ALTERNATIVE_COPY.ar.indexTitle}${TITLE_SUFFIX}` },
  description: ALTERNATIVE_COPY.ar.indexDescription,
};

export default function ArabicAlternativesRoute() {
  return (
    <>
      <AlternativesJsonLd english="/alternatives" language="ar" />
      <AlternativesIndexPage />
    </>
  );
}
