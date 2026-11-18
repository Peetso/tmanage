import type { Metadata } from 'next';
import { VerifyRecordPage } from '../../../../components/website/pages/verify/VerifyRecordPage';

/**
 * 52-19 (web half) — `/ar/verify`, the Arabic twin of `/verify` (the same component; `app/ar`
 * sets the locale and direction). Its own route rather than an `ARABIC_PAGES` entry, so it stays
 * out of the sitemap and the hreflang list: a verify page is never indexed.
 */
export const metadata: Metadata = {
  title: 'التحقّق من سجل اعتماد',
  description: 'تحقّق مما إذا كان سجل اعتماد في TManage أصليًا.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ArabicVerifyRoute() {
  return <VerifyRecordPage />;
}
