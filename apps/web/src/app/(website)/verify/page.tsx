import type { Metadata } from 'next';
import { VerifyRecordPage } from '../../../components/website/pages/verify/VerifyRecordPage';

/**
 * 52-19 (web half) — `/verify`: check a printed approval record with its record ID and fingerprint,
 * no sign-in. Never indexed (the website group opts pages in; this one opts back out) and never
 * sends a referrer, so a certificate link's fragment stays with the reader.
 */
export const metadata: Metadata = {
  title: 'Verify an approval record',
  description: 'Check whether a TManage approval record is genuine.',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function VerifyRoute() {
  return <VerifyRecordPage />;
}
