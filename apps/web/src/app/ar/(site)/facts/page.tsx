import type { Metadata } from 'next';
import { FactsPage } from '../../../../components/website/pages/facts/FactsPage';
import { AlternativesJsonLd } from '../../../../components/website/structured-data/AlternativesJsonLd';
import { FACTS_COPY } from '../../../../content/facts/facts';
import { TITLE_SUFFIX } from '../../../../lib/route-titles';
import { siteOrigin } from '../../../../lib/site-origin';

/** SEOF (B7) — the facts page in Arabic, `/ar/facts`. */
export const metadata: Metadata = {
  title: { absolute: `${FACTS_COPY.ar.title}${TITLE_SUFFIX}` },
  description: FACTS_COPY.ar.description,
};

export default function ArabicFactsRoute() {
  return (
    <>
      <AlternativesJsonLd english="/facts" language="ar" />
      <FactsPage website={siteOrigin()} />
    </>
  );
}
