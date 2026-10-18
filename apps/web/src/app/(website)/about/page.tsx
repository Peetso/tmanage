import type { Metadata } from 'next';
import { AboutPage } from '../../../components/website/pages/about/AboutPage';

/**
 * **About** — routed at `/about` (SITE-SPEC "PAGE: About", WEB-16). No Figma frame yet: designed
 * in code in the visual language of the designed pages.
 */
export const metadata: Metadata = {
  title: 'About · TManage',
  description:
    'TManage is built for the teams who do the work and the clients who wait on it — one thread from the ask to the sign-off.',
};

export default function AboutRoute() {
  return <AboutPage />;
}
