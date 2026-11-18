import type { Metadata } from 'next';
import { ArabicFirstPage } from '../../../../components/website/pages/arabic/ArabicFirstPage';
import { ARABIC_FIRST_COPY } from '../../../../content/arabic/arabic-pages';
import { TITLE_SUFFIX } from '../../../../lib/route-titles';

/** Row 57-07 (MENA) — the Arabic-first product page in Arabic, `/ar/arabic`. */
export const metadata: Metadata = {
  title: { absolute: `${ARABIC_FIRST_COPY.ar.tabTitle}${TITLE_SUFFIX}` },
  description: ARABIC_FIRST_COPY.ar.description,
};

export default function ArabicArabicFirstRoute() {
  return <ArabicFirstPage />;
}
