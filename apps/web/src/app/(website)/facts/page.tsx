import type { Metadata } from 'next';
import { FactsPage } from '../../../components/website/pages/facts/FactsPage';
import { AlternativesJsonLd } from '../../../components/website/structured-data/AlternativesJsonLd';
import { FACTS_COPY } from '../../../content/facts/facts';
import { siteOrigin } from '../../../lib/site-origin';

export const metadata: Metadata = {
  title: FACTS_COPY.en.title,
  description: FACTS_COPY.en.description,
};

/** SEOF (B7) — the facts page, `/facts` (Arabic twin at `/ar/facts`). */
export default function FactsRoute() {
  return (
    <>
      <AlternativesJsonLd english="/facts" language="en" />
      <FactsPage website={siteOrigin()} />
    </>
  );
}
