import type { Metadata } from 'next';
import { WalkthroughPage } from '../../../components/website/pages/walkthrough/WalkthroughPage';

export const metadata: Metadata = {
  title: 'Book a walkthrough',
  description:
    'A 20-minute walkthrough of TManage at a time that suits you: pick three times in your own time zone.',
};

/**
 * Public site — Book a walkthrough (`/walkthrough`, WEB-38, LANE-Q). The form posts to the
 * `@Public()` `POST /v1/public/walkthrough-requests` (rate-limited per address, honeypot, abuse
 * assessment); the response is a bare reference, so this route reflects no stored request.
 */
export default function WalkthroughRoute() {
  return <WalkthroughPage />;
}
