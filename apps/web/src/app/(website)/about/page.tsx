import type { Metadata } from 'next';
import { AboutPage } from '../../../components/website/pages/about/AboutPage';

/**
 * **About** — routed at `/about` (WEB-16, built to the round-2 Figma frame, node 308:41).
 */
export const metadata: Metadata = {
  title: 'About · TManage',
  description:
    'TManage is built for the teams who do the work and the clients who wait on it — one thread from the ask to the sign-off.',
};

export default function AboutRoute() {
  return <AboutPage />;
}
