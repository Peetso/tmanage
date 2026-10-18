import type { Metadata } from 'next';
import { HomePage } from '../../components/website/pages/home/HomePage';

/**
 * WEB-01 Home — the public website's landing page (`/`).
 *
 * A thin route wrapper inside the `(website)` group, so it gets Web/Nav, one `<main>` and
 * Web/Footer from the group layout. `HomePage` (a client component) renders every section of
 * SITE-SPEC "PAGE: Home". Sign-in stays one click away in the nav and the hero.
 */
export const metadata: Metadata = {
  title: { absolute: 'TManage — All the work. One connected story.' },
  description:
    'Plan, talk, deliver and get client approval in one place — without rebuilding context across five tools.',
};

export default function RootPage() {
  return <HomePage />;
}
