import type { Metadata } from 'next';
import { FeaturesCommunicationPage } from '../../../../components/website/pages/features-communication/FeaturesCommunicationPage';

/**
 * **Features · Chat & calendar** (WEB-04) — routed at `/features/communication`. A public page
 * inside the website chrome; the content lives in the page-specific component folder so a test
 * can mount it directly.
 */
export const metadata: Metadata = {
  title: 'Chat & calendar',
  description:
    'Channels, threads and meetings that produce tasks, decisions and owners — not more scrolling.',
};

export default function Page() {
  return <FeaturesCommunicationPage />;
}
