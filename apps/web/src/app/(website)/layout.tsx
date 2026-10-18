import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { WebsiteChrome } from '../../components/website/WebsiteChrome';

/**
 * The public website (`/`, `/product`, `/features/*`, `/solutions/*`, `/pricing`, `/security`,
 * `/resources`, `/contact`, `/status`, `/changelog`, `/faq`, `/legal/*` …).
 *
 * A route group, so no URL changes: every page here gets Web/Nav, one `<main>` and Web/Footer
 * from `WebsiteChrome`. The root layout keeps tenant screens out of search engines; the public
 * site opts back in here, as the root layout's note anticipated.
 */
export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function WebsiteLayout({ children }: { children: ReactNode }) {
  return <WebsiteChrome>{children}</WebsiteChrome>;
}
