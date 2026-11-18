import type { Metadata } from 'next';
import { ArabicFirstPage } from '../../../components/website/pages/arabic/ArabicFirstPage';
import { ARABIC_FIRST_COPY } from '../../../content/arabic/arabic-pages';

/** Row 57-07 (MENA) — the Arabic-first product page, `/arabic` (Arabic twin at `/ar/arabic`). */
export const metadata: Metadata = {
  title: ARABIC_FIRST_COPY.en.tabTitle,
  description: ARABIC_FIRST_COPY.en.description,
};

export default function ArabicFirstRoute() {
  return <ArabicFirstPage />;
}
